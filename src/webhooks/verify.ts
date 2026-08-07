export type WebhookHeaders = Headers | Record<string, string>;

export type WebhookInput = { request: Request } | { headers: WebhookHeaders; body: string };

export type VerifyWebhookParams = WebhookInput & { secret: string };

export interface IncomingWebhook {
  /** Header names lowercased. */
  headers: Record<string, string>;
  /** The raw request body — signatures are computed over these exact bytes. */
  body: string;
}

function lowercaseHeaders(headers: WebhookHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key.toLowerCase()] = value;
    });
  } else {
    for (const [key, value] of Object.entries(headers)) {
      result[key.toLowerCase()] = value;
    }
  }
  return result;
}

export async function toIncomingWebhook(input: WebhookInput): Promise<IncomingWebhook> {
  if ('request' in input) {
    const request = input.request.clone();
    return { headers: lowercaseHeaders(request.headers), body: await request.text() };
  }
  return { headers: lowercaseHeaders(input.headers), body: input.body };
}

export async function hmacSha256(key: string | Uint8Array, message: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const keyBytes = typeof key === 'string' ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return new Uint8Array(signature);
}

export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

export function isTimestampWithinTolerance(
  timestampSeconds: number,
  toleranceSeconds: number,
  nowMilliseconds = Date.now(),
): boolean {
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }
  const skew = Math.floor(nowMilliseconds / 1000) - timestampSeconds;
  return skew <= toleranceSeconds && skew >= -toleranceSeconds;
}
