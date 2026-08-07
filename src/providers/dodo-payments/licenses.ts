import { RevenueError } from '../../errors.ts';
import { HttpClient } from '../../http.ts';
import type { BaseParams, LicenseKeyActivation, LicenseKeyValidation } from '../../types.ts';
import {
  mapError,
  toBaseUrl,
  toLicenseKeyActivation,
  type DodoLicenseKeyInstance,
} from './common.ts';

interface DodoPaymentsLicenseKeyParams extends BaseParams {
  /** The license key as the customer received it. */
  key: string;
  server?: 'live' | 'test';
  /** Overrides `server`; used verbatim. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface DodoPaymentsValidateLicenseKeyParams extends DodoPaymentsLicenseKeyParams {
  /** Narrows the check to a single activation. */
  activationId?: string;
}

export interface DodoPaymentsActivateLicenseKeyParams extends DodoPaymentsLicenseKeyParams {
  /** Names the device or instance being activated. Required by Dodo Payments. */
  label: string;
}

export interface DodoPaymentsDeactivateLicenseKeyParams extends DodoPaymentsLicenseKeyParams {
  activationId: string;
}

interface DodoLicenseValidation {
  valid: boolean;
}

function createHttpClient(params: DodoPaymentsLicenseKeyParams): HttpClient {
  return new HttpClient({
    provider: 'dodo-payments',
    baseUrl: toBaseUrl(params),
    fetchImpl: params.fetch,
    // The `/licenses` routes are unauthenticated — no credential is sent, and none may be added
    // here. Dodo rate-limits them tightly: roughly 20 requests per second and 100 per minute.
    authHeaders: () => ({}),
    mapError,
  });
}

/**
 * Validates a license key. Needs no API key — safe to call from a desktop, mobile or CLI
 * application.
 *
 * SECURITY: Dodo answers with nothing but `{ valid: boolean }`. It names neither the product nor
 * the business the key belongs to, so a live key issued by any Dodo merchant for any product
 * validates as `true`. Only `activateLicenseKey` returns `business_id` and `product`; bind the
 * key to your own product there, or read it server-side via `client.licenseKeys.get`. For the
 * same reason `LicenseKeyValidation.licenseKey` is left undefined — there is no key data to map.
 */
export async function validateLicenseKey(
  params: DodoPaymentsValidateLicenseKeyParams,
): Promise<LicenseKeyValidation> {
  const http = createHttpClient(params);
  try {
    const { data } = await http.json<DodoLicenseValidation>('/licenses/validate', {
      method: 'POST',
      body: { license_key: params.key, license_key_instance_id: params.activationId },
      signal: params.signal,
    });
    return { valid: data.valid, raw: data };
  } catch (error) {
    // An unknown key answers `200 { "valid": false }`; a 404 carries the same meaning, so
    // callers never have to branch on it.
    if (error instanceof RevenueError && error.code === 'not_found') {
      return { valid: false, raw: error.responseBody };
    }
    throw error;
  }
}

/**
 * Activates a license key on a device and returns the activation to persist locally. Needs no
 * API key.
 */
export async function activateLicenseKey(
  params: DodoPaymentsActivateLicenseKeyParams,
): Promise<LicenseKeyActivation> {
  const http = createHttpClient(params);
  // Form-encoded bodies are rejected with `415 INVALID_REQUEST_BODY`; HttpClient sends JSON.
  const { data } = await http.json<DodoLicenseKeyInstance>('/licenses/activate', {
    method: 'POST',
    body: { license_key: params.key, name: params.label },
    signal: params.signal,
  });
  return toLicenseKeyActivation(data);
}

/** Releases an activation so the seat can be reused. Needs no API key. */
export async function deactivateLicenseKey(
  params: DodoPaymentsDeactivateLicenseKeyParams,
): Promise<void> {
  const http = createHttpClient(params);
  // Answers 200 with an empty body, which `json` reports as `undefined`.
  await http.json<undefined>('/licenses/deactivate', {
    method: 'POST',
    body: { license_key: params.key, license_key_instance_id: params.activationId },
    signal: params.signal,
  });
}
