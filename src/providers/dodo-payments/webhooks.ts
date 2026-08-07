import { base64ToBytes, bytesToBase64 } from '../../base64.ts';
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
  toLicenseKey,
  toOrderFromPayment,
  toSubscription,
  type DodoLicenseKey,
  type DodoPayment,
  type DodoSubscription,
} from './common.ts';

const TOLERANCE_SECONDS = 300;
const SECRET_PREFIX = 'whsec_';

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
 * Verifies a Dodo Payments webhook (Standard Webhooks, strict): the `whsec_` prefix is
 * stripped and the remainder base64-DECODED into the HMAC key bytes — unlike Polar, which
 * uses the secret verbatim.
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
  const encodedKey = params.secret.startsWith(SECRET_PREFIX)
    ? params.secret.slice(SECRET_PREFIX.length)
    : params.secret;
  let key: Uint8Array;
  try {
    key = base64ToBytes(encodedKey);
  } catch {
    return false;
  }
  const signature = await hmacSha256(key, `${id}.${timestampSeconds}.${body}`);
  return matchesAnySignature(signatureHeader, bytesToBase64(signature));
}

interface DodoWebhookEnvelope {
  business_id?: string;
  type?: string;
  timestamp?: string;
  data?: unknown;
}

const SUBSCRIPTION_UPDATE_EVENTS = new Set([
  // Dodo has no `subscription.created`; `subscription.active` also fires after on_hold
  // recovery, so all lifecycle events normalize to updates — consumers should upsert.
  'subscription.active',
  'subscription.on_hold',
  'subscription.plan_changed',
  'subscription.renewed',
  'subscription.update_payment_method',
  'subscription.updated',
]);

const SUBSCRIPTION_CANCELED_EVENTS = new Set([
  'subscription.cancelled',
  'subscription.expired',
  'subscription.failed',
]);

const SUBSCRIPTION_CHANGES: Record<string, SubscriptionChange> = {
  'subscription.on_hold': 'past_due',
};

/**
 * Parses a Dodo Payments webhook into a normalized event. Does NOT verify the signature —
 * call `verifyWebhook` first.
 */
export async function parseWebhookEvent(input: WebhookInput): Promise<WebhookEvent> {
  const { headers, body } = await toIncomingWebhook(input);
  let envelope: DodoWebhookEnvelope;
  try {
    envelope = JSON.parse(body) as DodoWebhookEnvelope;
  } catch (error) {
    throw new RevenueError('Received an unparseable Dodo Payments webhook payload', {
      code: 'validation',
      provider: 'dodo-payments',
      cause: error,
    });
  }
  const providerType = envelope.type ?? 'unknown';
  const id = headers['webhook-id'];
  const base = {
    providerType,
    idempotencyKey: id ? `dodo-payments:${id}` : `dodo-payments:sha256:${await sha256Hex(body)}`,
    // The envelope timestamp is when the event occurred. The `webhook-timestamp` header is the
    // delivery ATTEMPT time and moves with every retry.
    createdAt: toDate(envelope.timestamp),
    raw: envelope,
  };
  if (SUBSCRIPTION_UPDATE_EVENTS.has(providerType)) {
    return {
      ...base,
      type: 'subscription.updated',
      subscription: toSubscription(envelope.data as DodoSubscription),
      subscriptionChange: SUBSCRIPTION_CHANGES[providerType],
    };
  }
  if (SUBSCRIPTION_CANCELED_EVENTS.has(providerType)) {
    return {
      ...base,
      type: 'subscription.canceled',
      subscription: toSubscription(envelope.data as DodoSubscription),
    };
  }
  if (providerType === 'payment.succeeded') {
    return { ...base, type: 'order.paid', order: toOrderFromPayment(envelope.data as DodoPayment) };
  }
  if (providerType === 'license_key.created') {
    const licenseKey = toLicenseKey(envelope.data as DodoLicenseKey);
    return { ...base, type: 'license.issued', licenseKeyId: licenseKey.id, licenseKey };
  }
  return { ...base, type: 'unknown' };
}
