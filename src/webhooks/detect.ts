import type { ProviderName, WebhookEvent } from '../types.ts';
import { toIncomingWebhook, type VerifyWebhookParams, type WebhookInput } from './verify.ts';

/**
 * The webhook helpers every provider subpath exports. Type a routing table with it to dispatch a
 * shared endpoint on `detectWebhookProvider`'s result.
 */
export interface ProviderWebhooks {
  verifyWebhook(params: VerifyWebhookParams): Promise<boolean>;
  parseWebhookEvent(input: WebhookInput): Promise<WebhookEvent>;
}

/**
 * Routes a shared webhook endpoint to a provider based on request headers. Routing only —
 * always verify the signature with the provider's `verifyWebhook` before trusting the payload.
 */
export async function detectWebhookProvider(
  input: WebhookInput,
): Promise<ProviderName | undefined> {
  const { headers, body } = await toIncomingWebhook(input);
  if (headers['stripe-signature']) {
    return 'stripe';
  }
  if (headers['paddle-signature']) {
    return 'paddle';
  }
  if (headers['x-signature']) {
    return 'lemon-squeezy';
  }
  if (headers['webhook-id'] && headers['webhook-signature']) {
    // Polar and Dodo Payments both follow Standard Webhooks; Dodo payloads carry `business_id`.
    try {
      const payload = JSON.parse(body) as Record<string, unknown>;
      return typeof payload.business_id === 'string' ? 'dodo-payments' : 'polar';
    } catch {
      return undefined;
    }
  }
  return undefined;
}
