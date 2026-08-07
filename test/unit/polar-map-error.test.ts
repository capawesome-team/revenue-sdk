import { describe, expect, it } from 'vitest';
import { mapError } from '../../src/providers/polar/common.ts';

const EMAIL = 'not-an-email@example.com';

function entry(loc: unknown[], msg: string) {
  return { type: 'value_error', loc, msg, input: EMAIL, ctx: { reason: 'invalid' } };
}

describe('polar mapError', () => {
  it('ignores bodies that carry no usable detail', () => {
    expect(mapError(500, null)).toEqual({});
    expect(mapError(500, 'Internal Server Error')).toEqual({});
    expect(mapError(422, {})).toEqual({});
    expect(mapError(422, { detail: 42 })).toEqual({});
    expect(mapError(422, { detail: [] })).toEqual({});
  });

  it('uses a string detail verbatim', () => {
    expect(mapError(404, { detail: 'Not found' })).toEqual({ message: 'Not found' });
  });

  it('prefixes a string detail with the error code', () => {
    expect(mapError(404, { error: 'ResourceNotFound', detail: 'Not found' })).toEqual({
      message: 'ResourceNotFound: Not found',
    });
  });

  it('summarizes a Pydantic validation array without echoing the submitted input', () => {
    const { message } = mapError(422, {
      detail: [entry(['body', 'customer_email'], 'value is not a valid email address')],
    });
    expect(message).toBe('body.customer_email: value is not a valid email address');
    expect(message).not.toContain(EMAIL);
  });

  it('joins several entries and renders array indices in the path', () => {
    expect(
      mapError(422, {
        detail: [
          entry(['body', 'products', 0], 'Input should be a valid string'),
          entry(['body', 'amount'], 'Input should be greater than 0'),
        ],
      }),
    ).toEqual({
      message:
        'body.products.0: Input should be a valid string; body.amount: Input should be greater than 0',
    });
  });

  it('caps the summary at three entries and reports the omitted ones', () => {
    const { message } = mapError(422, {
      detail: [
        entry(['body', 'a'], 'first'),
        entry(['body', 'b'], 'second'),
        entry(['body', 'c'], 'third'),
        entry(['body', 'd'], 'fourth'),
        entry(['body', 'e'], 'fifth'),
      ],
    });
    expect(message).toBe('body.a: first; body.b: second; body.c: third (+2 more)');
    expect(message).not.toContain('fourth');
  });

  it('survives malformed entries instead of emitting undefined or [object Object]', () => {
    const { message } = mapError(422, {
      detail: [
        null,
        'boom',
        { loc: ['body', 'name'] },
        { msg: 42, loc: ['body', 'other'] },
        { msg: 'field required' },
        entry(['body', 'email'], 'value is not a valid email address'),
        { msg: 'nested', loc: ['body', { deep: true }, 'name'] },
      ],
    });
    expect(message).toBe(
      'field required; body.email: value is not a valid email address; body.name: nested',
    );
    expect(message).not.toContain('undefined');
    expect(message).not.toContain('[object Object]');
  });

  it('returns no message when every entry is malformed', () => {
    expect(mapError(422, { detail: [null, 'boom', { loc: ['body'] }] })).toEqual({});
  });
});
