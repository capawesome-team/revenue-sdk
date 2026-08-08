import { base64ToBytes, bytesToBase64 } from '../../base64.ts';
import { RevenueError } from '../../errors.ts';
import type { ProviderName } from '../../types.ts';
import { hmacSha256, toHex } from '../../webhooks/verify.ts';

const STANDARD_WEBHOOKS_SECRET_PREFIX = 'whsec_';

export interface SignWebhookParams {
  /** The scheme to sign with. The in-memory `testing` provider sends no webhooks. */
  provider: Exclude<ProviderName, 'testing'>;
  /** The endpoint's signing secret, exactly as the provider's dashboard shows it. */
  secret: string;
  /** The raw body your handler will read — signatures cover these exact bytes. */
  body: string;
  /** Defaults to now. Providers reject deliveries older than their tolerance (300s here). */
  timestamp?: Date;
  /** Standard Webhooks message id (Polar, Dodo Payments). Defaults to a random `msg_` id. */
  id?: string;
}

function toStandardWebhooksKey(secret: string): Uint8Array {
  const encoded = secret.startsWith(STANDARD_WEBHOOKS_SECRET_PREFIX)
    ? secret.slice(STANDARD_WEBHOOKS_SECRET_PREFIX.length)
    : secret;
  try {
    return base64ToBytes(encoded);
  } catch (error) {
    throw new RevenueError('The Dodo Payments webhook secret is not valid base64', {
      code: 'validation',
      provider: 'dodo-payments',
      cause: error,
    });
  }
}

/**
 * Signs a raw webhook body the way `provider` does, returning the exact headers that provider's
 * `verifyWebhook` accepts — so a handler test can exercise the real verification path.
 */
export async function signWebhook(params: SignWebhookParams): Promise<Record<string, string>> {
  const { body, provider, secret } = params;
  const timestamp = Math.floor((params.timestamp?.getTime() ?? Date.now()) / 1000);
  switch (provider) {
    case 'dodo-payments':
    case 'polar': {
      const id = params.id ?? `msg_${crypto.randomUUID()}`;
      // Polar keys the HMAC with the secret VERBATIM; Dodo follows Standard Webhooks strictly
      // and strips `whsec_` before base64-decoding the remainder into the key bytes.
      const key = provider === 'polar' ? secret : toStandardWebhooksKey(secret);
      const signature = await hmacSha256(key, `${id}.${timestamp}.${body}`);
      return {
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': `v1,${bytesToBase64(signature)}`,
      };
    }
    case 'lemon-squeezy':
      return { 'x-signature': toHex(await hmacSha256(secret, body)) };
    case 'paddle': {
      const signature = toHex(await hmacSha256(secret, `${timestamp}:${body}`));
      return { 'paddle-signature': `ts=${timestamp};h1=${signature}` };
    }
    case 'stripe': {
      const signature = toHex(await hmacSha256(secret, `${timestamp}.${body}`));
      return { 'stripe-signature': `t=${timestamp},v1=${signature}` };
    }
  }
}
