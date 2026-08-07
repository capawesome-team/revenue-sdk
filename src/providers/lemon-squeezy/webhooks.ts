import { RevenueError } from '../../errors.ts';
import type { WebhookEvent } from '../../types.ts';
import {
  hmacSha256,
  timingSafeEqual,
  toHex,
  toIncomingWebhook,
  type VerifyWebhookParams,
  type WebhookInput,
} from '../../webhooks/verify.ts';
import { toMetadata } from '../shared.ts';
import {
  toLicenseKey,
  toOrderFromInvoice,
  toOrderFromOrder,
  toSubscription,
  type LsLicenseKeyAttributes,
  type LsOrderAttributes,
  type LsResource,
  type LsSubscriptionAttributes,
  type LsSubscriptionInvoiceAttributes,
} from './common.ts';

/**
 * Verifies a Lemon Squeezy webhook: `X-Signature` carries the hex HMAC-SHA256 digest of the
 * raw request body, keyed by the signing secret. There is no timestamp.
 */
export async function verifyWebhook(params: VerifyWebhookParams): Promise<boolean> {
  const { headers, body } = await toIncomingWebhook(params);
  const signature = headers['x-signature'];
  if (!signature) {
    return false;
  }
  const expected = toHex(await hmacSha256(params.secret, body));
  return timingSafeEqual(signature.toLowerCase(), expected);
}

interface LsWebhookEnvelope {
  meta?: {
    event_name?: string;
    custom_data?: Record<string, unknown>;
  };
  data?: unknown;
}

const SUBSCRIPTION_UPDATE_EVENTS = new Set([
  'subscription_cancelled',
  'subscription_paused',
  'subscription_resumed',
  'subscription_unpaused',
  'subscription_updated',
]);

/**
 * Parses a Lemon Squeezy webhook into a normalized event. Does NOT verify the signature —
 * call `verifyWebhook` first.
 */
export async function parseWebhookEvent(input: WebhookInput): Promise<WebhookEvent> {
  const { body } = await toIncomingWebhook(input);
  let envelope: LsWebhookEnvelope;
  try {
    envelope = JSON.parse(body) as LsWebhookEnvelope;
  } catch (error) {
    throw new RevenueError('Received an unparseable Lemon Squeezy webhook payload', {
      code: 'validation',
      provider: 'lemon-squeezy',
      cause: error,
    });
  }
  const providerType = envelope.meta?.event_name ?? 'unknown';
  // Checkout custom data only travels in `meta.custom_data`, never on the resource itself.
  const metadata = toMetadata(envelope.meta?.custom_data);

  if (providerType === 'subscription_created') {
    return {
      type: 'subscription.created',
      providerType,
      subscription: toSubscription(envelope.data as LsResource<LsSubscriptionAttributes>, metadata),
      raw: envelope,
    };
  }
  if (SUBSCRIPTION_UPDATE_EVENTS.has(providerType)) {
    return {
      type: 'subscription.updated',
      providerType,
      subscription: toSubscription(envelope.data as LsResource<LsSubscriptionAttributes>, metadata),
      raw: envelope,
    };
  }
  if (providerType === 'subscription_expired') {
    return {
      type: 'subscription.canceled',
      providerType,
      subscription: toSubscription(envelope.data as LsResource<LsSubscriptionAttributes>, metadata),
      raw: envelope,
    };
  }
  if (providerType === 'order_created') {
    return {
      type: 'order.paid',
      providerType,
      order: toOrderFromOrder(envelope.data as LsResource<LsOrderAttributes>, metadata),
      raw: envelope,
    };
  }
  // Renewal payments never emit order_created; the invoice-carrying payment event is the
  // uniform "money received" signal.
  if (providerType === 'subscription_payment_success') {
    return {
      type: 'order.paid',
      providerType,
      order: toOrderFromInvoice(envelope.data as LsResource<LsSubscriptionInvoiceAttributes>),
      raw: envelope,
    };
  }
  if (providerType === 'license_key_created') {
    const licenseKey = toLicenseKey(envelope.data as LsResource<LsLicenseKeyAttributes>);
    return {
      type: 'license.issued',
      providerType,
      licenseKeyId: licenseKey.id,
      licenseKey,
      raw: envelope,
    };
  }
  return { type: 'unknown', providerType, raw: envelope };
}
