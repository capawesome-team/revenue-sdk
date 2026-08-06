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
  toCheckout,
  toOrderFromInvoice,
  toSubscription,
  type StripeCheckoutSession,
  type StripeInvoice,
  type StripeSubscription,
} from './common.ts';

const TOLERANCE_SECONDS = 300;

/**
 * Verifies a Stripe webhook. The `whsec_` signing secret is used VERBATIM as the HMAC key —
 * never stripped or base64-decoded (unlike Standard Webhooks implementations).
 */
export async function verifyWebhook(params: VerifyWebhookParams): Promise<boolean> {
  const { headers, body } = await toIncomingWebhook(params);
  const header = headers['stripe-signature'];
  if (!header) {
    return false;
  }
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') {
      timestamp = Number.parseInt(value, 10);
    } else if (key === 'v1') {
      // Only `v1` may be trusted; `v0` is a deliberately fake test scheme.
      signatures.push(value);
    }
  }
  if (timestamp === undefined || signatures.length === 0) {
    return false;
  }
  if (!isTimestampWithinTolerance(timestamp, TOLERANCE_SECONDS)) {
    return false;
  }
  const expected = toHex(await hmacSha256(params.secret, `${timestamp}.${body}`));
  let matched = false;
  for (const signature of signatures) {
    if (timingSafeEqual(signature, expected)) {
      matched = true;
    }
  }
  return matched;
}

interface StripeEventEnvelope {
  type?: string;
  data?: { object?: unknown };
}

/**
 * Parses a Stripe webhook into a normalized event. Does NOT verify the signature — call
 * `verifyWebhook` first.
 */
export async function parseWebhookEvent(input: WebhookInput): Promise<WebhookEvent> {
  const { body } = await toIncomingWebhook(input);
  let envelope: StripeEventEnvelope;
  try {
    envelope = JSON.parse(body) as StripeEventEnvelope;
  } catch (error) {
    throw new RevenueError('Received an unparseable Stripe webhook payload', {
      code: 'validation',
      provider: 'stripe',
      cause: error,
    });
  }
  const providerType = envelope.type ?? 'unknown';
  const object = envelope.data?.object;
  switch (providerType) {
    case 'customer.subscription.created':
      return {
        type: 'subscription.created',
        providerType,
        subscription: toSubscription(object as StripeSubscription),
        raw: envelope,
      };
    case 'customer.subscription.updated':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      return {
        type: 'subscription.updated',
        providerType,
        subscription: toSubscription(object as StripeSubscription),
        raw: envelope,
      };
    case 'customer.subscription.deleted':
      return {
        type: 'subscription.canceled',
        providerType,
        subscription: toSubscription(object as StripeSubscription),
        raw: envelope,
      };
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const checkout = toCheckout(object as StripeCheckoutSession);
      // `completed` fires with payment_status "unpaid" for delayed payment methods —
      // fulfillment must wait for async_payment_succeeded in that case.
      if (checkout.status === 'complete') {
        return { type: 'checkout.completed', providerType, checkout, raw: envelope };
      }
      return { type: 'unknown', providerType, checkout, raw: envelope };
    }
    case 'invoice.paid':
      return {
        type: 'order.paid',
        providerType,
        order: toOrderFromInvoice(object as StripeInvoice),
        raw: envelope,
      };
    default:
      return { type: 'unknown', providerType, raw: envelope };
  }
}
