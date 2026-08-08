import { expect } from 'vitest';
import type { WebhookEvent, WebhookEventType } from '../../src/types.ts';

/** Asserts the normalized type and narrows the event to that member of the union. */
export function expectEvent<T extends WebhookEventType>(
  event: WebhookEvent,
  type: T,
): Extract<WebhookEvent, { type: T }> {
  expect(event.type).toBe(type);
  return event as Extract<WebhookEvent, { type: T }>;
}
