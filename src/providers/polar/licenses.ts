import { RevenueError } from '../../errors.ts';
import { HttpClient } from '../../http.ts';
import type { BaseParams, LicenseKeyActivation, LicenseKeyValidation } from '../../types.ts';
import {
  mapError,
  toBaseUrl,
  toLicenseKey,
  toLicenseKeyActivation,
  type PolarLicenseKey,
  type PolarLicenseKeyActivation,
} from './common.ts';

interface PolarLicenseKeyParams extends BaseParams {
  /** The license key as the customer received it. */
  key: string;
  /** Your Polar organization ID — a public identifier, safe to ship inside an application. */
  organizationId: string;
  server?: 'production' | 'sandbox';
  /** Overrides `server`; used verbatim. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface PolarValidateLicenseKeyParams extends PolarLicenseKeyParams {
  /** Narrows the check to a single activation and returns it. */
  activationId?: string;
}

export interface PolarActivateLicenseKeyParams extends PolarLicenseKeyParams {
  /** Names the device or instance being activated. */
  label: string;
}

export interface PolarDeactivateLicenseKeyParams extends PolarLicenseKeyParams {
  activationId: string;
}

interface PolarValidatedLicenseKey extends PolarLicenseKey {
  activation?: PolarLicenseKeyActivation | null;
}

function createHttpClient(params: PolarLicenseKeyParams): HttpClient {
  return new HttpClient({
    provider: 'polar',
    baseUrl: toBaseUrl(params),
    fetchImpl: params.fetch,
    // The customer-portal routes take no credential and answer `401 invalid_token` when any
    // `Authorization` header is present, so none may be sent.
    authHeaders: () => ({}),
    mapError,
  });
}

/**
 * Validates a license key. Needs no API key — safe to call from a desktop, mobile or CLI
 * application. Polar answers 404 for every rejection (unknown, revoked, disabled, expired,
 * unmatched activation), which surfaces here as `valid: false` rather than an error.
 */
export async function validateLicenseKey(
  params: PolarValidateLicenseKeyParams,
): Promise<LicenseKeyValidation> {
  const http = createHttpClient(params);
  let licenseKey: PolarValidatedLicenseKey;
  try {
    const { data } = await http.json<PolarValidatedLicenseKey>(
      '/v1/customer-portal/license-keys/validate',
      {
        method: 'POST',
        body: {
          key: params.key,
          organization_id: params.organizationId,
          activation_id: params.activationId,
        },
        signal: params.signal,
      },
    );
    licenseKey = data;
  } catch (error) {
    if (error instanceof RevenueError && error.code === 'not_found') {
      return { valid: false, raw: error.responseBody };
    }
    throw error;
  }
  return {
    valid: true,
    licenseKey: toLicenseKey(licenseKey),
    activation: licenseKey.activation ? toLicenseKeyActivation(licenseKey.activation) : undefined,
    raw: licenseKey,
  };
}

/**
 * Activates a license key for one device or instance. Needs no API key. Throws `forbidden` when
 * the key has no activation limit configured or its limit is already reached.
 */
export async function activateLicenseKey(
  params: PolarActivateLicenseKeyParams,
): Promise<LicenseKeyActivation> {
  const http = createHttpClient(params);
  const { data } = await http.json<PolarLicenseKeyActivation>(
    '/v1/customer-portal/license-keys/activate',
    {
      method: 'POST',
      body: {
        key: params.key,
        organization_id: params.organizationId,
        label: params.label,
      },
      signal: params.signal,
    },
  );
  return toLicenseKeyActivation(data);
}

/** Releases a license key activation, freeing a slot. Needs no API key. */
export async function deactivateLicenseKey(params: PolarDeactivateLicenseKeyParams): Promise<void> {
  const http = createHttpClient(params);
  await http.raw('/v1/customer-portal/license-keys/deactivate', {
    method: 'POST',
    body: {
      key: params.key,
      organization_id: params.organizationId,
      activation_id: params.activationId,
    },
    signal: params.signal,
  });
}
