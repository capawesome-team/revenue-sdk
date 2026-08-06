import type { Metadata, ReportUsageParams } from '../types.ts';

export function toDate(value: string | null | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Folds the `value` shorthand into the event properties; an explicit `value` wins over `metadata.value`. */
export function toUsagePayload(params: ReportUsageParams): Metadata | undefined {
  if (params.value === undefined) {
    return params.metadata;
  }
  return { ...params.metadata, value: params.value };
}

export function toMetadata(value: unknown): Metadata | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, entry]) =>
      typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean',
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries) as Metadata;
}
