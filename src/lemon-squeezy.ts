export { lemonSqueezy } from './providers/lemon-squeezy/index.ts';
export {
  activateLicenseKey,
  deactivateLicenseKey,
  validateLicenseKey,
} from './providers/lemon-squeezy/licenses.ts';
export { parseWebhookEvent, verifyWebhook } from './providers/lemon-squeezy/webhooks.ts';

export type { LemonSqueezyProviderOptions } from './providers/lemon-squeezy/index.ts';
export type {
  LemonSqueezyActivateLicenseKeyParams,
  LemonSqueezyDeactivateLicenseKeyParams,
  LemonSqueezyLicenseKeyExpectation,
  LemonSqueezyValidateLicenseKeyParams,
} from './providers/lemon-squeezy/licenses.ts';
export type { VerifyWebhookParams, WebhookInput } from './webhooks/verify.ts';
