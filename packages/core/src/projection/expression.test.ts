import { describe, expect, it, vi } from 'vitest';
import { ProjectionCompileError, compileExpression, evaluateExpression } from './expression.js';
import { parseProjectionSpec } from './spec.js';

const evaluate = (source: string, context: Parameters<typeof evaluateExpression>[1] = { _: null }) =>
  evaluateExpression(compileExpression(source), context);

describe('parseProjectionSpec', () => {
  it('parses a valid projection with explicit Arrow types', () => {
    const spec = parseProjectionSpec(`
version: '0.1'
format: midi
tables:
  - name: events
    rows: $.tracks[*].events[*]
    key: event_id
    state:
      tick:
        scope: $.tracks[*]
        init: 0
        update: tick + _.delta_time
    columns:
      event_id:
        expr: _index(1)
        type: int64
      delta_time:
        expr: _.delta_time
        type: uint32
        when: _.delta_time != null
`);

    expect(spec).toEqual({
      version: '0.1',
      format: 'midi',
      tables: [
        {
          name: 'events',
          rows: '$.tracks[*].events[*]',
          key: 'event_id',
          state: {
            tick: {
              scope: '$.tracks[*]',
              init: 0,
              update: 'tick + _.delta_time',
            },
          },
          columns: {
            event_id: { expr: '_index(1)', type: 'int64' },
            delta_time: {
              expr: '_.delta_time',
              type: 'uint32',
              when: '_.delta_time != null',
            },
          },
        },
      ],
    });
  });

  it.each([
    ['wrong version', "version: '1.0'\nformat: midi\ntables: []", 'version'],
    ['empty tables', "version: '0.1'\nformat: midi\ntables: []", 'tables'],
    [
      'unsafe table name',
      "version: '0.1'\nformat: midi\ntables:\n  - name: bad-name\n    rows: $\n    key: id\n    columns:\n      id: { expr: '1', type: int32 }",
      'tables.0.name',
    ],
    [
      'unsafe key name',
      "version: '0.1'\nformat: midi\ntables:\n  - name: rows\n    rows: $\n    key: bad-key\n    columns:\n      id: { expr: '1', type: int32 }",
      'tables.0.key',
    ],
    [
      'unsafe column name',
      "version: '0.1'\nformat: midi\ntables:\n  - name: rows\n    rows: $\n    key: id\n    columns:\n      bad-name: { expr: '1', type: int32 }",
      'tables.0.columns.bad-name',
    ],
    [
      'unsafe state name',
      "version: '0.1'\nformat: midi\ntables:\n  - name: rows\n    rows: $\n    key: id\n    state:\n      bad-name: { scope: $, init: 0, update: '1' }\n    columns:\n      id: { expr: '1', type: int32 }",
      'tables.0.state.bad-name',
    ],
    [
      'prototype-pollution state name',
      "version: '0.1'\nformat: midi\ntables:\n  - name: rows\n    rows: $\n    key: id\n    state:\n      constructor: { scope: $, init: 0, update: '1' }\n    columns:\n      id: { expr: '1', type: int32 }",
      'tables.0.state.constructor',
    ],
    [
      'missing column type',
      "version: '0.1'\nformat: midi\ntables:\n  - name: rows\n    rows: $\n    key: id\n    columns:\n      id: { expr: '1' }",
      'tables.0.columns.id.type',
    ],
    [
      'unknown column type',
      "version: '0.1'\nformat: midi\ntables:\n  - name: rows\n    rows: $\n    key: id\n    columns:\n      id: { expr: '1', type: float64 }",
      'tables.0.columns.id.type',
    ],
  ])('rejects %s with a stable structured error', (_name, yaml, path) => {
    expect.assertions(4);

    try {
      parseProjectionSpec(yaml);
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectionCompileError);
      expect(error).toMatchObject({ code: 'PROJECTION_SPEC_INVALID', path });
      expect((error as Error).message).toContain('PROJECTION_SPEC_INVALID');
      expect((error as Error).message).toContain(path);
    }
  });

  it('rejects duplicate table names', () => {
    expect(() =>
      parseProjectionSpec(`
version: '0.1'
format: midi
tables:
  - name: rows
    rows: $
    key: id
    columns:
      id: { expr: '1', type: int32 }
  - name: rows
    rows: $.other
    key: id
    columns:
      id: { expr: '2', type: int32 }
`),
    ).toThrowError(/PROJECTION_TABLE_DUPLICATE.*tables\.1\.name/);
  });

  it('wraps malformed YAML in a structured error', () => {
    expect(() => parseProjectionSpec('version: [')).toThrowError(/PROJECTION_YAML_INVALID/);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects raw prototype-pollution key %s in state and columns',
    (name) => {
      for (const section of ['state', 'columns'] as const) {
        const mapping =
          section === 'state'
            ? `${name}: { scope: $, init: 0, update: '1' }`
            : `${name}: { expr: '1', type: int32 }`;
        const yaml = `
version: '0.1'
format: midi
tables:
  - name: rows
    rows: $
    key: id
    ${section}:
      ${mapping}
    ${section === 'state' ? "columns:\n      id: { expr: '1', type: int32 }" : ''}
`;

        expect(() => parseProjectionSpec(yaml)).toThrowError(
          new ProjectionCompileError(
            'PROJECTION_SPEC_INVALID',
            `tables.0.${section}.${name}`,
            'must be an identifier-safe name',
          ),
        );
      }
    },
  );

  it.each([
    '_',
    '_root',
    '_parent',
    '_index',
    'enum_str',
    'to_i',
    'len',
    'u24be',
    'true',
    'false',
    'null',
    'and',
    'or',
    'not',
    'this',
    'globalThis',
  ])('rejects evaluator-reserved state name %s', (name) => {
    expect(() =>
      parseProjectionSpec(`
version: '0.1'
format: midi
tables:
  - name: rows
    rows: $
    key: id
    state:
      ${JSON.stringify(name)}: { scope: $, init: 0, update: '1' }
    columns:
      id: { expr: '1', type: int32 }
`),
    ).toThrowError(
      new ProjectionCompileError(
        'PROJECTION_SPEC_INVALID',
        `tables.0.state.${name}`,
        'state name is reserved by the expression evaluator',
      ),
    );
  });
});

describe('projection expressions', () => {
  it('evaluates arithmetic paths and snake-case aliases', () => {
    expect(
      evaluate('_.delta_time * 2 + _parent.offset', {
        _: { deltaTime: 6 },
        _parent: { offset: 3 },
      }),
    ).toBe(15);
  });

  it('evaluates word booleans, unary not, ternaries, and bitwise operators', () => {
    expect(evaluate('not false and (true or false) ? (5 << 2) | 3 : 0')).toBe(23);
  });

  it('evaluates the closed builtin set and wildcard indexes', () => {
    expect(evaluate('_index(1)', { _: null, indexes: [4, 7] })).toBe(7);
    expect(evaluate('_index(3)', { _: null, indexes: [4, 7] })).toBeNull();
    expect(evaluate('enum_str(_.kind)', { _: { kind: 9 } })).toBe('9');
    expect(evaluate('to_i(_.value)', { _: { value: '42' } })).toBe(42);
    expect(evaluate('len(_.bytes)', { _: { bytes: new Uint8Array(3) } })).toBe(3);
    expect(
      evaluate('u24be(_.bytes)', {
        _: { bytes: Uint8Array.of(0x12, 0x34, 0x56) },
      }),
    ).toBe(0x123456);
  });

  it('ip4_str formats a 4-byte address', () => {
    expect(evaluate('ip4_str(_.a)', { _: { a: new Uint8Array([192, 168, 0, 1]) } })).toBe('192.168.0.1');
  });

  it('ip4_str returns null on wrong length', () => {
    expect(evaluate('ip4_str(_.a)', { _: { a: new Uint8Array([1, 2, 3]) } })).toBeNull();
  });

  it('ip6_str compresses the longest zero run', () => {
    const addr = new Uint8Array(16);
    addr[0] = 0x20;
    addr[1] = 0x01;
    addr[15] = 0x01;
    expect(evaluate('ip6_str(_.a)', { _: { a: addr } })).toBe('2001::1');
  });

  it('ip6_str formats all-zero address as ::', () => {
    const addr = new Uint8Array(16);
    expect(evaluate('ip6_str(_.a)', { _: { a: addr } })).toBe('::');
  });

  it('ip6_str compresses a leading zero run', () => {
    const addr = new Uint8Array(16);
    addr[12] = 0x12;
    addr[13] = 0x34;
    addr[14] = 0x56;
    addr[15] = 0x78;
    expect(evaluate('ip6_str(_.a)', { _: { a: addr } })).toBe('::1234:5678');
  });

  it('ip6_str compresses a trailing zero run', () => {
    const addr = new Uint8Array(16);
    addr[0] = 0x12;
    addr[1] = 0x34;
    addr[2] = 0x56;
    addr[3] = 0x78;
    expect(evaluate('ip6_str(_.a)', { _: { a: addr } })).toBe('1234:5678::');
  });

  it('ip6_str does not compress single zero group', () => {
    const addr = new Uint8Array(16);
    addr[0] = 0x12;
    addr[1] = 0x34;
    addr[4] = 0x56;
    addr[5] = 0x78;
    addr[8] = 0x9a;
    addr[9] = 0xbc;
    addr[12] = 0xde;
    addr[13] = 0xf0;
    expect(evaluate('ip6_str(_.a)', { _: { a: addr } })).toBe('1234:0:5678:0:9abc:0:def0:0');
  });

  it('dos_dttm decodes a packed DOS date/time to epoch microseconds', () => {
    // 2021-06-15 12:30:44 UTC.
    const date = (41 << 9) | (6 << 5) | 15; // year-1980=41, month=6, day=15
    const time = (12 << 11) | (30 << 5) | 22; // hour=12, minute=30, second/2=22
    const packed = date * 65536 + time;
    expect(evaluate('dos_dttm(_.p)', { _: { p: packed } })).toBe(Date.UTC(2021, 5, 15, 12, 30, 44) * 1000);
  });

  it('dos_dttm returns null for a zero or invalid date', () => {
    expect(evaluate('dos_dttm(_.p)', { _: { p: 0 } })).toBeNull();
    expect(evaluate('dos_dttm(_.p)', { _: { p: null } })).toBeNull();
    // month 0 is invalid (DOS months are 1-12).
    expect(evaluate('dos_dttm(_.p)', { _: { p: (41 << 9) * 65536 } })).toBeNull();
  });

  it('reads wildcard indexes only from own data properties', () => {
    const inherited = new Array<number>(1);
    Object.setPrototypeOf(inherited, { 0: 9 });
    const getter = vi.fn(() => 9);
    const accessor = new Array<number>(1);
    Object.defineProperty(accessor, '0', { configurable: true, get: getter });

    expect(evaluate('_index(0)', { _: null, indexes: inherited })).toBeNull();
    expect(evaluate('_index(0)', { _: null, indexes: accessor })).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects invalid and out-of-range wildcard index arguments before lookup', () => {
    const indexes = [4, 7];
    Object.defineProperties(indexes, {
      '-1': { value: 91 },
      '0.5': { value: 92 },
      '9007199254740992': { value: 93 },
    });
    const inheritedGetter = vi.fn(() => 94);
    Object.setPrototypeOf(
      indexes,
      Object.create(Array.prototype, {
        2: { get: inheritedGetter },
      }),
    );

    expect(evaluate('_index(-1)', { _: null, indexes })).toBeNull();
    expect(evaluate('_index(0.5)', { _: null, indexes })).toBeNull();
    expect(evaluate('_index(9007199254740992)', { _: null, indexes })).toBeNull();
    expect(evaluate('_index(2)', { _: null, indexes })).toBeNull();
    expect(evaluate('_index(_.position)', { _: { position: 1n }, indexes })).toBeNull();
    expect(inheritedGetter).not.toHaveBeenCalled();
  });

  it('propagates null through member, arithmetic, unary, and builtin operations', () => {
    expect(evaluate('_.missing.value + 1', { _: {} })).toBeNull();
    expect(evaluate('_.present', { _: { present: undefined } })).toBeNull();
    expect(evaluate('-_.missing', { _: {} })).toBeNull();
    expect(evaluate('enum_str(_.missing)', { _: {} })).toBeNull();
    expect(evaluate('u24be(_.short)', { _: { short: Uint8Array.of(1, 2) } })).toBeNull();
  });

  it('short-circuits boolean operators without evaluating the other operand', () => {
    expect(evaluate('false and _.missing.value', { _: {} })).toBe(false);
    expect(evaluate('true or _.missing.value', { _: {} })).toBe(true);
    expect(evaluate('null or 8')).toBe(8);
  });

  it('reads declared state only from the own state map', () => {
    const inherited = Object.create({ hidden: 5 }) as Record<string, unknown>;
    inherited.tick = 12;

    expect(evaluate('tick + 1', { _: null, state: inherited })).toBe(13);
    expect(evaluate('hidden', { _: null, state: inherited })).toBeNull();
  });

  it('preserves bigint arithmetic and bitwise results', () => {
    expect(evaluate('_.left + _.right', { _: { left: 7n, right: 5n } })).toBe(12n);
    expect(evaluate('_.left << 2', { _: { left: 3n } })).toBe(12n);
  });

  it('compares bigint fields against numeric literals consistently with ordering operators', () => {
    expect(evaluate('_.big == 5', { _: { big: 5n } })).toBe(true);
    expect(evaluate('_.big == 5', { _: { big: 6n } })).toBe(false);
    expect(evaluate('_.big != 5', { _: { big: 6n } })).toBe(true);
    expect(evaluate('_.big >= 5', { _: { big: 5n } })).toBe(true);
    expect(evaluate('_.text == "5"', { _: { text: '5' } })).toBe(true);
    expect(evaluate('_.num == "5"', { _: { num: 5 } })).toBe(false);
  });

  it('does not read inherited members or invoke property getters', () => {
    const getter = vi.fn(() => 9);
    const value = Object.create({ inherited: 7 }) as Record<string, unknown>;
    Object.defineProperty(value, 'danger', { enumerable: true, get: getter });

    expect(evaluate('_.inherited', { _: value })).toBeNull();
    expect(evaluate('_.danger', { _: value })).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    'value = 1',
    '[1, 2]',
    '{ value: 1 }',
    '_.body.constructor("return 1")()',
    '_.body["value"]',
    'unknown_call(1)',
    '_.method()',
    'this.value',
    'globalThis.value',
    '__proto__',
    '_index',
    'and',
    'or',
    '_.constructor',
    '_.prototype',
    '_.__proto__',
  ])('rejects forbidden syntax: %s', (source) => {
    expect(() => compileExpression(source)).toThrowError(
      /EXPRESSION_(?:PARSE_ERROR|NODE_FORBIDDEN|CALL_FORBIDDEN|IDENTIFIER_FORBIDDEN|MEMBER_FORBIDDEN)/,
    );
  });

  it('rejects executable member calls with the stable node error code', () => {
    expect(() => compileExpression('_.body.constructor("return 1")()')).toThrowError(
      /EXPRESSION_NODE_FORBIDDEN/,
    );
  });

  describe('hex literals', () => {
    it('evaluates a hex literal', () => {
      expect(evaluateExpression(compileExpression('0x0800'), { _: null })).toBe(2048);
    });

    it('evaluates an uppercase-marker hex literal', () => {
      expect(evaluateExpression(compileExpression('0XFF'), { _: null })).toBe(255);
    });

    it('compares a field against a hex literal', () => {
      const expr = compileExpression('_.ether_type == 0x0800');
      expect(evaluateExpression(expr, { _: { ether_type: 2048 } })).toBe(true);
      expect(evaluateExpression(expr, { _: { ether_type: 2049 } })).toBe(false);
    });

    it('promotes hex literals beyond the safe integer range to bigint', () => {
      // 0x20000000000000 === 2 ** 53, one above MAX_SAFE_INTEGER.
      expect(evaluateExpression(compileExpression('0x20000000000000'), { _: null })).toBe(9007199254740992n);
    });

    it('mixes hex literals with arithmetic and bitwise operators', () => {
      expect(evaluateExpression(compileExpression('(0xF0 & 0x9F) >> 4'), { _: null })).toBe(9);
    });

    it('rejects a hex marker with no digits', () => {
      expect(() => compileExpression('0x')).toThrow(ProjectionCompileError);
      expect(() => compileExpression('0x == 1')).toThrow(ProjectionCompileError);
    });
  });
});
