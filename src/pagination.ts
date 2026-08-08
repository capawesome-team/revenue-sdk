import { decodeBase64Url, encodeBase64Url } from './base64.ts';
import { RevenueError } from './errors.ts';
import type { ProviderName } from './types.ts';

interface CursorEnvelope<T> {
  p: ProviderName;
  s: T;
}

export function encodeCursor<T>(provider: ProviderName, state: T): string {
  const envelope: CursorEnvelope<T> = { p: provider, s: state };
  return encodeBase64Url(JSON.stringify(envelope));
}

export function decodeCursor<T>(provider: ProviderName, cursor: string): T {
  let envelope: CursorEnvelope<T>;
  try {
    envelope = JSON.parse(decodeBase64Url(cursor)) as CursorEnvelope<T>;
  } catch (error) {
    throw new RevenueError('Received a malformed pagination cursor', {
      code: 'validation',
      provider,
      cause: error,
    });
  }
  if (envelope === null || typeof envelope !== 'object' || envelope.p !== provider) {
    throw new RevenueError('Received a pagination cursor from another provider', {
      code: 'validation',
      provider,
    });
  }
  return envelope.s;
}

/**
 * Guards cursors that carry next-page URLs: a forged cursor must not be able to redirect an
 * authenticated request (and its credentials) to another host.
 */
export function assertSameOriginUrl(provider: ProviderName, baseUrl: string, url: string): void {
  let target: URL;
  try {
    target = new URL(url);
  } catch (error) {
    throw new RevenueError('Received an invalid pagination URL', {
      code: 'validation',
      provider,
      cause: error,
    });
  }
  if (target.origin !== new URL(baseUrl).origin) {
    throw new RevenueError('Refusing to follow a pagination URL on another origin', {
      code: 'validation',
      provider,
    });
  }
}

export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  // A non-finite limit would reach the wire as `limit=NaN`; the client rejects one before it gets
  // here, so this only guards an adapter called directly.
  if (limit === undefined || !Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

interface PageNumberCursorState {
  page: number;
}

export interface PageNumberCursorOptions {
  /** The first page number: 1 on most providers, 0 on Dodo Payments. */
  startPage: number;
  defaultLimit: number;
  maxLimit: number;
  /** Query parameter carrying the page number, e.g. `page` or `page[number]`. */
  pageKey: string;
  /** Query parameter carrying the page size, e.g. `limit` or `page[size]`. */
  limitKey: string;
}

export interface PageNumberCursorPage {
  page: number;
  limit: number;
  query: Record<string, number>;
}

export interface PageNumberCursor {
  read(cursor: string | undefined, limit: number | undefined): PageNumberCursorPage;
  next(page: number, hasMore: boolean): string | undefined;
}

/** Cursor codec for providers that paginate by page number rather than by record. */
export function pageNumberCursor(
  provider: ProviderName,
  options: PageNumberCursorOptions,
): PageNumberCursor {
  return {
    read(cursor, limit) {
      const page = cursor
        ? decodeCursor<PageNumberCursorState>(provider, cursor).page
        : options.startPage;
      const size = clampLimit(limit, options.defaultLimit, options.maxLimit);
      return {
        page,
        limit: size,
        query: { [options.pageKey]: page, [options.limitKey]: size },
      };
    },
    next(page, hasMore) {
      return hasMore
        ? encodeCursor<PageNumberCursorState>(provider, { page: page + 1 })
        : undefined;
    },
  };
}
