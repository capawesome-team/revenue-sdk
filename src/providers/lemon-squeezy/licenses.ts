import { RevenueError } from '../../errors.ts';
import { HttpClient, type ProviderErrorInfo } from '../../http.ts';
import type { BaseParams, LicenseKeyActivation, LicenseKeyValidation } from '../../types.ts';
import {
  BASE_URL,
  toLicenseKeyActivation,
  toLicenseKeyFromLicense,
  type LsLicense,
  type LsLicenseInstance,
  type LsLicenseMeta,
} from './common.ts';

/** Asserted against the `meta` of every license API response before a key counts as valid. */
export interface LemonSqueezyLicenseKeyExpectation {
  storeId: string | number;
  /** Narrows the check to one Lemon Squeezy product. */
  productId?: string | number;
  /** Narrows the check to one variant — the unified `Product`. */
  variantId?: string | number;
}

export interface LemonSqueezyLicenseKeyParams extends BaseParams {
  key: string;
  /** Required: Lemon Squeezy answers for any merchant's key, so the caller must assert ownership. */
  expect: LemonSqueezyLicenseKeyExpectation;
  /** Used verbatim. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface LemonSqueezyValidateLicenseKeyParams extends LemonSqueezyLicenseKeyParams {
  /** Narrows the check to a single activation and returns it. Lemon Squeezy calls this an instance. */
  activationId?: string;
}

export interface LemonSqueezyActivateLicenseKeyParams extends LemonSqueezyLicenseKeyParams {
  /** Names the device or instance being activated. Required by Lemon Squeezy. */
  label: string;
}

export interface LemonSqueezyDeactivateLicenseKeyParams extends LemonSqueezyLicenseKeyParams {
  /** The activation to remove — the `LicenseKeyActivation.id` returned by `activateLicenseKey`. */
  activationId: string;
}

interface LsLicenseResponse {
  valid?: boolean;
  activated?: boolean;
  deactivated?: boolean;
  error?: string | null;
  license_key?: LsLicense;
  instance?: LsLicenseInstance | null;
  meta?: LsLicenseMeta;
}

function mapError(status: number, body: unknown): ProviderErrorInfo {
  if (body === null || typeof body !== 'object') {
    return {};
  }
  // The license API reports a single `error` string instead of the JSON:API `errors` array.
  const { error } = body as { error?: unknown };
  return typeof error === 'string' ? { message: error } : {};
}

function createHttpClient(params: LemonSqueezyLicenseKeyParams): HttpClient {
  return new HttpClient({
    provider: 'lemon-squeezy',
    baseUrl: params.baseUrl ?? BASE_URL,
    fetchImpl: params.fetch,
    // The license API takes no credential, and a merchant API key must never reach a client app.
    // It is also not JSON:API — hence a client of its own, since `HttpClient` only fills in the
    // form content type when no default header already set one.
    authHeaders: () => ({}),
    defaultHeaders: { Accept: 'application/json' },
    mapError,
    // Error messages are Lemon Squeezy's own `error` string; the key never survives into one.
    secrets: () => [params.key],
  });
}

async function postLicenseRequest(
  path: string,
  form: URLSearchParams,
  params: LemonSqueezyLicenseKeyParams,
): Promise<LsLicenseResponse> {
  const { data } = await createHttpClient(params).json<LsLicenseResponse>(path, {
    method: 'POST',
    form,
    signal: params.signal,
  });
  return data;
}

/**
 * A rejected key answers with a 4XX that still carries the normal verdict body (e.g. 404 and
 * `{"valid":false,"error":"license_key not found."}`), which is an answer, not a failure.
 */
function toVerdictBody(error: unknown): LsLicenseResponse | undefined {
  const body = error instanceof RevenueError ? error.cause : undefined;
  return typeof body === 'object' && body !== null && 'valid' in body
    ? (body as LsLicenseResponse)
    : undefined;
}

function matchesExpectation(
  meta: LsLicenseMeta,
  expected: LemonSqueezyLicenseKeyExpectation,
): boolean {
  // Lemon Squeezy reports IDs as numbers while callers usually hold them as strings.
  const matches = (actual: number, wanted: string | number | undefined) =>
    wanted === undefined || String(actual) === String(wanted);
  return (
    matches(meta.store_id, expected.storeId) &&
    matches(meta.product_id, expected.productId) &&
    matches(meta.variant_id, expected.variantId)
  );
}

/**
 * Rejects anything but a success on a key belonging to the caller's store. Activation and
 * deactivation report their outcome through the return type alone, so a refusal has to throw.
 */
function assertOwnedVerdict(
  payload: LsLicenseResponse,
  verdict: boolean | undefined,
  params: LemonSqueezyLicenseKeyParams,
  fallbackMessage: string,
): void {
  if (verdict !== true) {
    // A refusal usually arrives as a 4XX that `HttpClient` already turned into a `RevenueError`
    // (400 for a reached activation limit); a 2XX carrying a false verdict lands here instead.
    throw new RevenueError(payload.error || fallbackMessage, {
      code: 'validation',
      provider: 'lemon-squeezy',
      cause: payload,
      secrets: [params.key],
    });
  }
  // The license API is unscoped, so every merchant's key succeeds here. Lemon Squeezy's docs:
  // "verify that the store_id, product_id and/or variant_id from this response match […] If you
  // don't do this, someone using a license key from another Lemon Squeezy product could use it to
  // get access to your product." A foreign key does not exist as far as this caller is concerned,
  // so neither it nor its owner is described any further.
  if (payload.meta === undefined || !matchesExpectation(payload.meta, params.expect)) {
    throw new RevenueError('License key not found for this store', {
      code: 'not_found',
      provider: 'lemon-squeezy',
    });
  }
}

function toValidation(
  payload: LsLicenseResponse,
  expected: LemonSqueezyLicenseKeyExpectation,
): LicenseKeyValidation {
  const license = payload.license_key;
  const meta = payload.meta;
  // Same ownership guard as `assertOwnedVerdict`, reported as an invalid verdict rather than an
  // error: a foreign key is never handed back.
  if (
    payload.valid !== true ||
    license === undefined ||
    meta === undefined ||
    !matchesExpectation(meta, expected)
  ) {
    return { valid: false, raw: payload };
  }
  return {
    valid: true,
    licenseKey: toLicenseKeyFromLicense(license, meta),
    activation: payload.instance ? toLicenseKeyActivation(payload.instance) : undefined,
    raw: payload,
  };
}

/**
 * Validates a license key against Lemon Squeezy's public license API, which needs no credential.
 * Never throws for a rejected or foreign key — both are reported as `valid: false`.
 *
 * Test-mode keys are validated by the same host as live keys; `license_key.test_mode` on `raw` is
 * the only discriminator.
 */
export async function validateLicenseKey(
  params: LemonSqueezyValidateLicenseKeyParams,
): Promise<LicenseKeyValidation> {
  const form = new URLSearchParams({ license_key: params.key });
  if (params.activationId !== undefined) {
    form.set('instance_id', params.activationId);
  }
  let payload: LsLicenseResponse;
  try {
    payload = await postLicenseRequest('/v1/licenses/validate', form, params);
  } catch (error) {
    const body = toVerdictBody(error);
    if (body === undefined) {
      throw error;
    }
    payload = body;
  }
  return toValidation(payload, params.expect);
}

/**
 * Activates a license key for one instance and returns the activation to persist locally. Throws
 * `validation` once the activation limit is reached, and `not_found` for a key from another store.
 */
export async function activateLicenseKey(
  params: LemonSqueezyActivateLicenseKeyParams,
): Promise<LicenseKeyActivation> {
  const form = new URLSearchParams({ license_key: params.key, instance_name: params.label });
  const payload = await postLicenseRequest('/v1/licenses/activate', form, params);
  assertOwnedVerdict(payload, payload.activated, params, 'Lemon Squeezy refused the activation');
  const instance = payload.instance;
  if (!instance) {
    throw new RevenueError('Lemon Squeezy reported an activation without an instance', {
      code: 'provider_error',
      provider: 'lemon-squeezy',
    });
  }
  return toLicenseKeyActivation(instance);
}

/**
 * Deactivates one instance of a license key, freeing an activation. Throws `validation` when Lemon
 * Squeezy refuses, and `not_found` for a key from another store.
 */
export async function deactivateLicenseKey(
  params: LemonSqueezyDeactivateLicenseKeyParams,
): Promise<void> {
  const form = new URLSearchParams({ license_key: params.key, instance_id: params.activationId });
  const payload = await postLicenseRequest('/v1/licenses/deactivate', form, params);
  assertOwnedVerdict(
    payload,
    payload.deactivated,
    params,
    'Lemon Squeezy refused the deactivation',
  );
}
