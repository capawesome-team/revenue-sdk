export { dodoPayments } from './providers/dodo-payments/index.ts';
export {
  activateLicenseKey,
  deactivateLicenseKey,
  validateLicenseKey,
} from './providers/dodo-payments/licenses.ts';
export { parseWebhookEvent, verifyWebhook } from './providers/dodo-payments/webhooks.ts';

export type { DodoPaymentsProviderOptions } from './providers/dodo-payments/index.ts';
export type {
  DodoPaymentsActivateLicenseKeyParams,
  DodoPaymentsDeactivateLicenseKeyParams,
  DodoPaymentsValidateLicenseKeyParams,
} from './providers/dodo-payments/licenses.ts';
export type { VerifyWebhookParams, WebhookInput } from './webhooks/verify.ts';
