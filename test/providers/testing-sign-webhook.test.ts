import { describe, expect, it } from 'vitest';
import { verifyWebhook as verifyDodoPayments } from '../../src/providers/dodo-payments/webhooks.ts';
import { verifyWebhook as verifyLemonSqueezy } from '../../src/providers/lemon-squeezy/webhooks.ts';
import { verifyWebhook as verifyPaddle } from '../../src/providers/paddle/webhooks.ts';
import { verifyWebhook as verifyPolar } from '../../src/providers/polar/webhooks.ts';
import { verifyWebhook as verifyStripe } from '../../src/providers/stripe/webhooks.ts';
import { signWebhook, type SignWebhookParams } from '../../src/testing.ts';

type SignableProvider = SignWebhookParams['provider'];

// Polar and Dodo Payments deliberately share a secret here: the remainder after `whsec_` is valid
// base64, so the same string is usable both verbatim (Polar) and decoded (Dodo).
const STANDARD_WEBHOOKS_SECRET = 'whsec_ovyN6cPrTv56AApvzCaJno08SSmGJmgb';

const SECRETS: Record<SignableProvider, string> = {
  'dodo-payments': STANDARD_WEBHOOKS_SECRET,
  'lemon-squeezy': 'ls-signing-secret',
  paddle: 'pdl_ntfset_01gkpjp8bkm3tm53kdgkx6sms7_secret',
  polar: STANDARD_WEBHOOKS_SECRET,
  stripe: 'whsec_wRNftLajMZNeslQOP6vEPm4iVx5NlZ6z',
};

const VERIFIERS: Record<SignableProvider, typeof verifyPolar> = {
  'dodo-payments': verifyDodoPayments,
  'lemon-squeezy': verifyLemonSqueezy,
  paddle: verifyPaddle,
  polar: verifyPolar,
  stripe: verifyStripe,
};

const BODY = '{"type":"order.paid","data":{"id":"order-1"}}';

describe('signWebhook', () => {
  for (const provider of Object.keys(VERIFIERS) as SignableProvider[]) {
    it(`produces headers that the ${provider} verifyWebhook accepts`, async () => {
      const secret = SECRETS[provider];
      const headers = await signWebhook({ provider, secret, body: BODY });
      await expect(VERIFIERS[provider]({ headers, body: BODY, secret })).resolves.toBe(true);
      await expect(VERIFIERS[provider]({ headers, body: `${BODY} `, secret })).resolves.toBe(false);
      await expect(VERIFIERS[provider]({ headers, body: BODY, secret: 'other' })).resolves.toBe(
        false,
      );
    });
  }

  // Precomputed with an independent HMAC implementation. Pins the helper to the wire format so it
  // cannot drift in lockstep with the verifiers.
  describe('precomputed vectors', () => {
    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    const id = 'msg_test';

    it('signs a Polar webhook with the verbatim whsec_ secret', async () => {
      await expect(
        signWebhook({ provider: 'polar', secret: SECRETS.polar, body: BODY, timestamp, id }),
      ).resolves.toEqual({
        'webhook-id': 'msg_test',
        'webhook-timestamp': '1767225600',
        'webhook-signature': 'v1,f66T1mDRfz+QRmqRKr9BoMhKfiy7jroHeMKqRvFHdHU=',
      });
    });

    it('signs a Dodo Payments webhook with the stripped, base64-decoded secret', async () => {
      await expect(
        signWebhook({
          provider: 'dodo-payments',
          secret: SECRETS['dodo-payments'],
          body: BODY,
          timestamp,
          id,
        }),
      ).resolves.toEqual({
        'webhook-id': 'msg_test',
        'webhook-timestamp': '1767225600',
        'webhook-signature': 'v1,p6iRQ/I46d2R68JwSjmGafe+oN08VO0uJdcJk28mV/U=',
      });
    });

    it('signs a Stripe webhook', async () => {
      await expect(
        signWebhook({ provider: 'stripe', secret: SECRETS.stripe, body: BODY, timestamp }),
      ).resolves.toEqual({
        'stripe-signature':
          't=1767225600,v1=c343af138ea59642abe06f3254c28e9d24869fb1dd8e3e3e8dacb32cb2a2404d',
      });
    });

    it('signs a Paddle webhook', async () => {
      await expect(
        signWebhook({ provider: 'paddle', secret: SECRETS.paddle, body: BODY, timestamp }),
      ).resolves.toEqual({
        'paddle-signature':
          'ts=1767225600;h1=c391767e4da123c4e7cab05e7f236f707bc95c73a11bf772523c2275317d27ca',
      });
    });

    it('signs a Lemon Squeezy webhook over the body alone', async () => {
      await expect(
        signWebhook({
          provider: 'lemon-squeezy',
          secret: SECRETS['lemon-squeezy'],
          body: BODY,
          timestamp,
        }),
      ).resolves.toEqual({
        'x-signature': 'c16ec54f7903498b99e8cd4d0299df169b74f3a2222e2a2076dd676bed29ab4f',
      });
    });
  });

  it('keys Polar and Dodo Payments differently from the same secret', async () => {
    const polar = await signWebhook({
      provider: 'polar',
      secret: STANDARD_WEBHOOKS_SECRET,
      body: BODY,
      id: 'msg_1',
    });
    const dodo = await signWebhook({
      provider: 'dodo-payments',
      secret: STANDARD_WEBHOOKS_SECRET,
      body: BODY,
      id: 'msg_1',
    });
    expect(dodo['webhook-signature']).not.toBe(polar['webhook-signature']);
    await expect(
      verifyDodoPayments({ headers: polar, body: BODY, secret: STANDARD_WEBHOOKS_SECRET }),
    ).resolves.toBe(false);
    await expect(
      verifyPolar({ headers: dodo, body: BODY, secret: STANDARD_WEBHOOKS_SECRET }),
    ).resolves.toBe(false);
  });

  it('rejects a Dodo Payments secret that is not base64', async () => {
    await expect(
      signWebhook({ provider: 'dodo-payments', secret: 'whsec_%%%not-base64%%%', body: BODY }),
    ).rejects.toMatchObject({ code: 'validation', provider: 'dodo-payments' });
  });

  it('defaults the timestamp to now and the message id to a unique one', async () => {
    const before = Math.floor(Date.now() / 1000);
    const first = await signWebhook({ provider: 'polar', secret: SECRETS.polar, body: BODY });
    const second = await signWebhook({ provider: 'polar', secret: SECRETS.polar, body: BODY });
    const timestamp = Number(first['webhook-timestamp']);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(first['webhook-id']).toMatch(/^msg_/);
    expect(second['webhook-id']).not.toBe(first['webhook-id']);
  });
});
