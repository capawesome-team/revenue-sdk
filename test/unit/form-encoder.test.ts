import { describe, expect, it } from 'vitest';
import { encodeForm } from '../../src/providers/stripe/form-encoder.ts';

describe('encodeForm', () => {
  it('encodes flat scalars', () => {
    expect(encodeForm({ mode: 'subscription', limit: 10 }).toString()).toBe(
      'mode=subscription&limit=10',
    );
  });

  it('encodes nested objects with bracket notation', () => {
    const form = encodeForm({ subscription_data: { metadata: { org_id: 'org_1' } } });
    expect(form.toString()).toBe(
      encodeURIComponent('subscription_data[metadata][org_id]').replace(/%20/g, '+') + '=org_1',
    );
    expect(form.get('subscription_data[metadata][org_id]')).toBe('org_1');
  });

  it('encodes arrays with explicit sequential indices', () => {
    const form = encodeForm({
      line_items: [
        { price: 'price_1', quantity: 1 },
        { price: 'price_2', quantity: 2 },
      ],
    });
    expect(form.get('line_items[0][price]')).toBe('price_1');
    expect(form.get('line_items[0][quantity]')).toBe('1');
    expect(form.get('line_items[1][price]')).toBe('price_2');
    expect(form.get('line_items[1][quantity]')).toBe('2');
  });

  it('encodes scalar arrays with indices', () => {
    const form = encodeForm({ expand: ['customer', 'subscription'] });
    expect(form.get('expand[0]')).toBe('customer');
    expect(form.get('expand[1]')).toBe('subscription');
  });

  it('omits undefined values entirely', () => {
    const form = encodeForm({ a: 'x', b: undefined, nested: { c: undefined } });
    expect(form.toString()).toBe('a=x');
  });

  it('serializes null as an empty string (unset semantics)', () => {
    const form = encodeForm({ cancel_at: null });
    expect(form.toString()).toBe('cancel_at=');
  });

  it('serializes booleans as literal strings', () => {
    const form = encodeForm({ cancel_at_period_end: true, active: false });
    expect(form.get('cancel_at_period_end')).toBe('true');
    expect(form.get('active')).toBe('false');
  });

  it('serializes Date values as unix seconds', () => {
    const form = encodeForm({ trial_end: new Date('2026-08-06T00:00:00Z') });
    expect(form.get('trial_end')).toBe(
      String(Math.floor(Date.parse('2026-08-06T00:00:00Z') / 1000)),
    );
  });

  it('keeps mixed indices sequential when entries are skipped', () => {
    const form = encodeForm({ items: [{ id: 'si_1', deleted: true }, { price: 'price_2' }] });
    expect(form.get('items[0][id]')).toBe('si_1');
    expect(form.get('items[0][deleted]')).toBe('true');
    expect(form.get('items[1][price]')).toBe('price_2');
  });
});
