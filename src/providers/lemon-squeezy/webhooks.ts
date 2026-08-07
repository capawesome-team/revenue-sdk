import { RevenueError } from '../../errors.ts';
import type { SubscriptionChange, WebhookEvent } from '../../types.ts';
import {
  hmacSha256,
  sha256Hex,
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

const SUBSCRIPTION_CHANGES: Record<string, SubscriptionChange> = {
  subscription_cancelled: 'cancel_scheduled',
  subscription_paused: 'paused',
  // `subscription_resumed` means un-CANCELED, not un-paused: Lemon Squeezy names the reversal of
  // `subscription_cancelled` "resumed" and the reversal of `subscription_paused` "unpaused".
  subscription_resumed: 'uncanceled',
  subscription_unpaused: 'resumed',
};

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
  const base = {
    providerType,
    // Lemon Squeezy publishes no event id — neither in the headers nor in the body — so the raw
    // body is the only stable delivery identity. It sends no event timestamp either.
    idempotencyKey: `lemon-squeezy:sha256:${await sha256Hex(body)}`,
    raw: envelope,
  };

  if (providerType === 'subscription_created') {
    return {
      ...base,
      type: 'subscription.created',
      subscription: toSubscription(envelope.data as LsResource<LsSubscriptionAttributes>, metadata),
    };
  }
  if (SUBSCRIPTION_UPDATE_EVENTS.has(providerType)) {
    return {
      ...base,
      type: 'subscription.updated',
      subscription: toSubscription(envelope.data as LsResource<LsSubscriptionAttributes>, metadata),
      subscriptionChange: SUBSCRIPTION_CHANGES[providerType],
    };
  }
  if (providerType === 'subscription_expired') {
    return {
      ...base,
      type: 'subscription.canceled',
      subscription: toSubscription(envelope.data as LsResource<LsSubscriptionAttributes>, metadata),
    };
  }
  if (providerType === 'order_created') {
    return {
      ...base,
      type: 'order.paid',
      order: toOrderFromOrder(envelope.data as LsResource<LsOrderAttributes>, metadata),
    };
  }
  // Renewal payments never emit order_created; the invoice-carrying payment event is the
  // uniform "money received" signal.
  if (providerType === 'subscription_payment_success') {
    return {
      ...base,
      type: 'order.paid',
      order: toOrderFromInvoice(envelope.data as LsResource<LsSubscriptionInvoiceAttributes>),
    };
  }
  if (providerType === 'license_key_created') {
    const licenseKey = toLicenseKey(envelope.data as LsResource<LsLicenseKeyAttributes>);
    return { ...base, type: 'license.issued', licenseKeyId: licenseKey.id, licenseKey };
  }
  return { ...base, type: 'unknown' };
}
