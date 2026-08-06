/**
 * Encodes a params object into Stripe's form-encoded wire format:
 * - nested objects use bracket notation (`subscription_data[metadata][org]`)
 * - arrays use explicit sequential indices (`items[0][price]`)
 * - `undefined` values are omitted entirely
 * - `null` becomes an empty string (Stripe's "unset" semantics)
 * - booleans become the literal strings `true`/`false`
 * - `Date` values become Unix seconds
 */
export function encodeForm(params: Record<string, unknown>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    append(form, key, value);
  }
  return form;
}

function append(form: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (value === null) {
    form.append(key, '');
    return;
  }
  if (value instanceof Date) {
    form.append(key, String(Math.floor(value.getTime() / 1000)));
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      append(form, `${key}[${index}]`, value[index]);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      append(form, `${key}[${childKey}]`, childValue);
    }
    return;
  }
  form.append(key, String(value));
}
