import { RevenueError } from '../../errors.ts';
import type { WebhookEvent } from '../../types.ts';
import {
  hmacSha256,
  isTimestampWithinTolerance,
  timingSafeEqual,
  toHex,
  toIncomingWebhook,
  type VerifyWebhookParams,
  type WebhookInput,
} from '../../webhooks/verify.ts';
import {
  toOrderFromTransaction,
  toSubscription,
  type PaddleSubscription,
  type PaddleTransaction,
} from './common.ts';

// Paddle's own SDKs default to a 5-second tolerance; 300s is friendlier to retries and
// clock skew on serverless platforms while remaining a strict replay bound.
const TOLERANCE_SECONDS = 300;

/**
 * Verifies a Paddle webhook: `Paddle-Signature: ts=...;h1=...`, where `h1` is the hex
 * HMAC-SHA256 of `` `${ts}:${rawBody}` `` keyed by the endpoint's secret (used verbatim).
 */
export async function verifyWebhook(params: VerifyWebhookParams): Promise<boolean> {
  const { headers, body } = await toIncomingWebhook(params);
  const header = headers['paddle-signature'];
  if (!header) {
    return false;
  }
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 'ts') {
      timestamp = Number.parseInt(value, 10);
    } else if (key === 'h1') {
      // Multiple h1 values may appear during secret rotation.
      signatures.push(value);
    }
  }
  if (timestamp === undefined || signatures.length === 0) {
    return false;
  }
  if (!isTimestampWithinTolerance(timestamp, TOLERANCE_SECONDS)) {
    return false;
  }
  const expected = toHex(await hmacSha256(params.secret, `${timestamp}:${body}`));
  let matched = false;
  for (const signature of signatures) {
    if (timingSafeEqual(signature, expected)) {
      matched = true;
    }
  }
  return matched;
}

interface PaddleEventEnvelope {
  event_id?: string;
  event_type?: string;
  occurred_at?: string;
  data?: unknown;
}

const SUBSCRIPTION_UPDATE_EVENTS = new Set([
  'subscription.activated',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
  'subscription.trialing',
  'subscription.updated',
]);

/**
 * Parses a Paddle webhook into a normalized event. Does NOT verify the signature — call
 * `verifyWebhook` first. Note: scheduling a cancellation emits `subscription.updated` (with
 * `scheduled_change`), never `subscription.canceled` — that only fires when it takes effect.
 */
export async function parseWebhookEvent(input: WebhookInput): Promise<WebhookEvent> {
  const { body } = await toIncomingWebhook(input);
  let envelope: PaddleEventEnvelope;
  try {
    envelope = JSON.parse(body) as PaddleEventEnvelope;
  } catch (error) {
    throw new RevenueError('Received an unparseable Paddle webhook payload', {
      code: 'validation',
      provider: 'paddle',
      cause: error,
    });
  }
  const providerType = envelope.event_type ?? 'unknown';
  if (providerType === 'subscription.created') {
    return {
      type: 'subscription.created',
      providerType,
      subscription: toSubscription(envelope.data as PaddleSubscription),
      raw: envelope,
    };
  }
  if (SUBSCRIPTION_UPDATE_EVENTS.has(providerType)) {
    return {
      type: 'subscription.updated',
      providerType,
      subscription: toSubscription(envelope.data as PaddleSubscription),
      raw: envelope,
    };
  }
  if (providerType === 'subscription.canceled') {
    return {
      type: 'subscription.canceled',
      providerType,
      subscription: toSubscription(envelope.data as PaddleSubscription),
      raw: envelope,
    };
  }
  // `transaction.completed` marks full processing; `transaction.paid` precedes it and is
  // left unmapped to avoid double-firing.
  if (providerType === 'transaction.completed') {
    return {
      type: 'order.paid',
      providerType,
      order: toOrderFromTransaction(envelope.data as PaddleTransaction),
      raw: envelope,
    };
  }
  return { type: 'unknown', providerType, raw: envelope };
}
