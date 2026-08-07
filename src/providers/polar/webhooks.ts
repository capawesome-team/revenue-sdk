import { bytesToBase64 } from '../../base64.ts';
import { RevenueError } from '../../errors.ts';
import type { WebhookEvent } from '../../types.ts';
import {
  hmacSha256,
  isTimestampWithinTolerance,
  timingSafeEqual,
  toIncomingWebhook,
  type VerifyWebhookParams,
  type WebhookInput,
} from '../../webhooks/verify.ts';
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
  data?: unknown;
}

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
  const { body } = await toIncomingWebhook(input);
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
  switch (providerType) {
    case 'subscription.created':
      return {
        type: 'subscription.created',
        providerType,
        subscription: toSubscription(envelope.data as PolarSubscription),
        raw: envelope,
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
        type: 'subscription.updated',
        providerType,
        subscription: toSubscription(envelope.data as PolarSubscription),
        raw: envelope,
      };
    case 'subscription.revoked':
      return {
        type: 'subscription.canceled',
        providerType,
        subscription: toSubscription(envelope.data as PolarSubscription),
        raw: envelope,
      };
    case 'order.paid':
      return {
        type: 'order.paid',
        providerType,
        order: toOrder(envelope.data as PolarOrder),
        raw: envelope,
      };
    case 'checkout.updated': {
      const checkout = toCheckout(envelope.data as PolarCheckout);
      if (checkout.status === 'complete') {
        return { type: 'checkout.completed', providerType, checkout, raw: envelope };
      }
      return { type: 'unknown', providerType, checkout, raw: envelope };
    }
    // Polar has no license webhook — license keys are delivered as a benefit grant, so this is
    // the only normalized type that depends on inspecting the payload rather than the event
    // string: `benefit.type` is a per-benefit const in Polar's schema, and every other benefit
    // type (Discord, downloadables, meter credits, ...) falls through to `unknown`.
    case 'benefit_grant.created': {
      const grant = envelope.data as PolarBenefitGrant;
      const licenseKeyId = grant.properties?.license_key_id;
      if (grant.benefit?.type !== 'license_keys' || !licenseKeyId) {
        return { type: 'unknown', providerType, raw: envelope };
      }
      // No `licenseKey`: the grant carries only `display_key`, a masked form that must never be
      // presented as the key. Fetch the plaintext key with `licenseKeys.get`.
      return { type: 'license.issued', providerType, licenseKeyId, raw: envelope };
    }
    default:
      return { type: 'unknown', providerType, raw: envelope };
  }
}
