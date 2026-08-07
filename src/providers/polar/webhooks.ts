import { bytesToBase64 } from '../../base64.ts';
import { RevenueError } from '../../errors.ts';
import type { SubscriptionChange, WebhookEvent } from '../../types.ts';
import {
  hmacSha256,
  isTimestampWithinTolerance,
  sha256Hex,
  timingSafeEqual,
  toIncomingWebhook,
  type VerifyWebhookParams,
  type WebhookInput,
} from '../../webhooks/verify.ts';
import { toDate } from '../shared.ts';
import {
  toCheckout,
  toOrder,
  toSubscription,
  type PolarCheckout,
  type PolarOrder,
  type PolarSubscription,
} from './common.ts';

const TOLERANCE_SECONDS = 300;

function matchesAnySignature(header: string, expected: string): boolean {
  let matched = false;
  for (const part of header.split(' ')) {
    const separator = part.indexOf(',');
    if (separator === -1 || part.slice(0, separator) !== 'v1') {
      continue;
    }
    if (timingSafeEqual(part.slice(separator + 1), expected)) {
      matched = true;
    }
  }
  return matched;
}

/**
 * Verifies a Polar webhook (Standard Webhooks headers). Polar derives the HMAC key from the
 * secret VERBATIM — including any `whsec_` prefix — unlike the Standard Webhooks spec.
 */
export async function verifyWebhook(params: VerifyWebhookParams): Promise<boolean> {
  const { headers, body } = await toIncomingWebhook(params);
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'];
  if (!id || !timestamp || !signatureHeader) {
    return false;
  }
  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!isTimestampWithinTolerance(timestampSeconds, TOLERANCE_SECONDS)) {
    return false;
  }
  const signature = await hmacSha256(params.secret, `${id}.${timestampSeconds}.${body}`);
  return matchesAnySignature(signatureHeader, bytesToBase64(signature));
}

interface PolarWebhookEnvelope {
  type?: string;
  timestamp?: string;
  data?: unknown;
}

const SUBSCRIPTION_CHANGES: Record<string, SubscriptionChange> = {
  'subscription.canceled': 'cancel_scheduled',
  'subscription.past_due': 'past_due',
  'subscription.paused': 'paused',
  'subscription.resumed': 'resumed',
  'subscription.uncanceled': 'uncanceled',
};

/** The license-keys member of Polar's 8-way `BenefitGrantWebhook` union, narrowed to what is read. */
interface PolarBenefitGrant {
  benefit?: { type?: string };
  properties?: { license_key_id?: string };
}

/**
 * Parses a Polar webhook into a normalized event. Does NOT verify the signature — call
 * `verifyWebhook` first.
 */
export async function parseWebhookEvent(input: WebhookInput): Promise<WebhookEvent> {
  const { headers, body } = await toIncomingWebhook(input);
  let envelope: PolarWebhookEnvelope;
  try {
    envelope = JSON.parse(body) as PolarWebhookEnvelope;
  } catch (error) {
    throw new RevenueError('Received an unparseable Polar webhook payload', {
      code: 'validation',
      provider: 'polar',
      cause: error,
    });
  }
  const providerType = envelope.type ?? 'unknown';
  const id = headers['webhook-id'];
  const base = {
    providerType,
    idempotencyKey: id ? `polar:${id}` : `polar:sha256:${await sha256Hex(body)}`,
    // The envelope timestamp is when the event occurred. The `webhook-timestamp` header is the
    // delivery ATTEMPT time and moves with every retry.
    createdAt: toDate(envelope.timestamp),
    raw: envelope,
  };
  switch (providerType) {
    case 'subscription.created':
      return {
        ...base,
        type: 'subscription.created',
        subscription: toSubscription(envelope.data as PolarSubscription),
      };
    // `subscription.canceled` fires when a cancellation is merely scheduled; the terminal
    // state arrives as `subscription.revoked`.
    case 'subscription.active':
    case 'subscription.canceled':
    case 'subscription.cycled':
    case 'subscription.past_due':
    case 'subscription.paused':
    case 'subscription.resumed':
    case 'subscription.uncanceled':
    case 'subscription.updated':
      return {
        ...base,
        type: 'subscription.updated',
        subscription: toSubscription(envelope.data as PolarSubscription),
        subscriptionChange: SUBSCRIPTION_CHANGES[providerType],
      };
    case 'subscription.revoked':
      return {
        ...base,
        type: 'subscription.canceled',
        subscription: toSubscription(envelope.data as PolarSubscription),
      };
    case 'order.paid':
      return { ...base, type: 'order.paid', order: toOrder(envelope.data as PolarOrder) };
    case 'checkout.updated': {
      const checkout = toCheckout(envelope.data as PolarCheckout);
      if (checkout.status === 'complete') {
        return { ...base, type: 'checkout.completed', checkout };
      }
      return { ...base, type: 'unknown', checkout };
    }
    // Polar has no license webhook — license keys are delivered as a benefit grant, so this
    // mapping reads the payload rather than the event string: `benefit.type` is a per-benefit
    // const in Polar's schema, and every other benefit type (Discord, downloadables, meter
    // credits, ...) falls through to `unknown`.
    case 'benefit_grant.created': {
      const grant = envelope.data as PolarBenefitGrant;
      const licenseKeyId = grant.properties?.license_key_id;
      if (grant.benefit?.type !== 'license_keys' || !licenseKeyId) {
        return { ...base, type: 'unknown' };
      }
      // No `licenseKey`: the grant carries only `display_key`, a masked form that must never be
      // presented as the key. Fetch the plaintext key with `licenseKeys.get`.
      return { ...base, type: 'license.issued', licenseKeyId };
    }
    default:
      return { ...base, type: 'unknown' };
  }
}
