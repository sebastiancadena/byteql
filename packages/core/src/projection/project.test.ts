import { describe, expect, it } from 'vitest';
import { ProjectionCompileError } from './expression.js';
import { compileProjection, projectTree } from './project.js';
import type { ProjectionSpec } from './spec.js';

const projection = (table: ProjectionSpec['tables'][number]): ProjectionSpec => ({
  version: '0.1',
  format: 'test',
  tables: [table],
});

describe('compileProjection and projectTree', () => {
  it('traverses in document order, scopes state, filters rows, guards columns, and emits provenance', () => {
    const compiled = compileProjection(
      projection({
        name: 'events',
        rows: '$.tracks[*].events[*]',
        where: '_.include',
        key: 'event_id',
        state: {
          tick: { scope: '$.tracks[*]', init: 0, update: 'tick + _.delta' },
        },
        columns: {
          track: { expr: '_index(0)', type: 'int32' },
          event_index: { expr: '_index(1)', type: 'int32' },
          tick: { expr: 'tick', type: 'int64' },
          kind: { expr: '_.kind', type: 'utf8' },
          variant: { expr: '_.variant.value', type: 'int32' },
          guarded: { expr: '_.variant.value', type: 'int32', when: '_.kind == "variant"' },
        },
      }),
    );
    const root = {
      tracks: [
        {
          events: [
            { delta: 10, include: true, kind: 'base' },
            { delta: 5, include: true, kind: 'variant', variant: { value: 9 } },
          ],
        },
        {
          events: [
            { delta: 7, include: true, kind: 'base' },
            { delta: 100, include: false, kind: 'filtered' },
          ],
        },
      ],
    };
    const resolved: Array<{
      table: string;
      node: unknown;
      parents: readonly unknown[];
      indexes: readonly number[];
      ordinal: number;
    }> = [];

    const [table] = projectTree(compiled, root, {
      resolve(tableName, anchor) {
        resolved.push({ table: tableName, ...anchor });
        return { start: anchor.ordinal * 10 + 3, end: anchor.ordinal * 10 + 9 };
      },
    });

    expect(table).toBeDefined();
    expect(table!.name).toBe('events');
    expect(table!.rowCount).toBe(3);
    expect(table!.columns.event_id).toEqual([1n, 2n, 3n]);
    expect(table!.columns.track).toEqual([0, 0, 1]);
    expect(table!.columns.event_index).toEqual([0, 1, 0]);
    expect(table!.columns.tick).toEqual([10, 15, 7]);
    expect(table!.columns.kind).toEqual(['base', 'variant', 'base']);
    expect(table!.columns.variant).toEqual([null, 9, null]);
    expect(table!.columns.guarded).toEqual([null, 9, null]);
    expect(table!.columns._src_start).toEqual([3n, 13n, 23n]);
    expect(table!.columns._src_end).toEqual([9n, 19n, 29n]);
    expect(table!.types).toEqual({
      event_id: 'int64',
      track: 'int32',
      event_index: 'int32',
      tick: 'int64',
      kind: 'utf8',
      variant: 'int32',
      guarded: 'int32',
      _src_start: 'uint64',
      _src_end: 'uint64',
    });
    expect(Object.values(table!.columns).every((values) => values.length === table!.rowCount)).toBe(true);
    expect(resolved.map(({ table: name, indexes, ordinal }) => [name, indexes, ordinal])).toEqual([
      ['events', [0, 0], 0],
      ['events', [0, 1], 1],
      ['events', [1, 0], 2],
    ]);
    expect(resolved[0]!.node).toBe(root.tracks[0]!.events[0]);
    expect(resolved[0]!.parents).toEqual([root, root.tracks, root.tracks[0], root.tracks[0]!.events]);
  });

  it('updates state before where and keeps filtered anchors out of keys and provenance', () => {
    const compiled = compileProjection(
      projection({
        name: 'rows',
        rows: '$.items[*]',
        where: '_.keep',
        key: 'row_id',
        state: {
          total: { scope: '$', init: 0, update: 'total + _.amount' },
        },
        columns: { total: { expr: 'total', type: 'int64' } },
      }),
    );
    const calls: number[] = [];

    const [table] = projectTree(
      compiled,
      {
        items: [
          { amount: 2, keep: false },
          { amount: 3, keep: true },
        ],
      },
      {
        resolve(_table, anchor) {
          calls.push(anchor.ordinal);
          return { start: 20, end: 25 };
        },
      },
    );

    expect(table!.columns).toEqual({
      row_id: [1n],
      total: [5],
      _src_start: [20n],
      _src_end: [25n],
    });
    expect(calls).toEqual([1]);
  });

  it('uses only own data properties and skips sparse, inherited, and accessor array entries', () => {
    let getterCalls = 0;
    const tracks: unknown[] = [];
    tracks.length = 5;
    tracks[0] = { events: [{ value: 'first' }] };
    Object.defineProperty(tracks, '1', {
      configurable: true,
      get() {
        getterCalls += 1;
        return { events: [{ value: 'getter' }] };
      },
    });
    const inheritedTracks = Object.create(Array.prototype) as Record<string, unknown>;
    Object.defineProperty(inheritedTracks, '2', {
      configurable: true,
      enumerable: true,
      value: { events: [{ value: 'inherited' }] },
    });
    Object.setPrototypeOf(tracks, inheritedTracks);
    const events: unknown[] = [];
    events.length = 4;
    events[3] = { value: 'last' };
    Object.defineProperty(events, '1', {
      configurable: true,
      get() {
        getterCalls += 1;
        return { value: 'getter event' };
      },
    });
    tracks[4] = { events };

    const compiled = compileProjection(
      projection({
        name: 'rows',
        rows: '$.tracks[*].events[*]',
        key: 'id',
        columns: {
          track: { expr: '_index(0)', type: 'int32' },
          item: { expr: '_index(1)', type: 'int32' },
          value: { expr: '_.value', type: 'utf8' },
        },
      }),
    );
    const [table] = projectTree(
      compiled,
      { tracks },
      {
        resolve: () => ({ start: 0, end: 0 }),
      },
    );

    expect(table!.columns.track).toEqual([0, 4]);
    expect(table!.columns.item).toEqual([0, 3]);
    expect(table!.columns.value).toEqual(['first', 'last']);
    expect(getterCalls).toBe(0);
  });

  it('applies fixed indexes without adding them to wildcard index context', () => {
    const compiled = compileProjection(
      projection({
        name: 'rows',
        rows: '$.tracks[1].events[*]',
        key: 'id',
        columns: { wildcard_index: { expr: '_index(0)', type: 'int32' } },
      }),
    );
    const [table] = projectTree(
      compiled,
      { tracks: [{ events: [{ id: 0 }] }, { events: [{ id: 1 }, { id: 2 }] }] },
      { resolve: () => ({ start: 0, end: 1 }) },
    );

    expect(table!.columns.wildcard_index).toEqual([0, 1]);
  });

  it('treats fixed indexes outside the array length as absent even when an own property exists', () => {
    const tracks: unknown[] = [];
    Object.defineProperty(tracks, '4294967295', {
      configurable: true,
      value: { value: 'not an array element' },
    });
    const [table] = projectTree(
      compileProjection(
        projection({
          name: 'rows',
          rows: '$.tracks[4294967295]',
          key: 'id',
          columns: { value: { expr: '_.value', type: 'utf8' } },
        }),
      ),
      { tracks },
      { resolve: () => ({ start: 0, end: 0 }) },
    );

    expect(table!.rowCount).toBe(0);
  });

  it('does not invoke an accessor or inherited field while traversing a named step', () => {
    let getterCalls = 0;
    const root = Object.create({ inherited: [{ value: 1 }] }) as Record<string, unknown>;
    Object.defineProperty(root, 'accessor', {
      get() {
        getterCalls += 1;
        return [{ value: 2 }];
      },
    });

    for (const rows of ['$.inherited[*]', '$.accessor[*]']) {
      const [table] = projectTree(
        compileProjection(
          projection({
            name: 'rows',
            rows,
            key: 'id',
            columns: { value: { expr: '_.value', type: 'int32' } },
          }),
        ),
        root,
        { resolve: () => ({ start: 0, end: 0 }) },
      );
      expect(table!.rowCount).toBe(0);
      expect(Object.values(table!.columns).every((values) => values.length === 0)).toBe(true);
    }
    expect(getterCalls).toBe(0);
  });

  it.each([
    '$.tracks[]',
    '$.tracks[-1]',
    '$.tracks[1.5]',
    '$.tracks[9007199254740992]',
    '$.tracks["0"]',
    '$..tracks',
    '$.tracks.',
    '$.tracks()',
    '$.constructor',
    'tracks[*]',
  ])('rejects anchor syntax outside the closed grammar: %s', (rows) => {
    expect(() =>
      compileProjection(
        projection({
          name: 'rows',
          rows,
          key: 'id',
          columns: { value: { expr: '1', type: 'int32' } },
        }),
      ),
    ).toThrowError(ProjectionCompileError);
  });

  it.each([
    ['not a prefix', '$.tracks[*].other'],
    ['different fixed index', '$.tracks[1]'],
    ['longer than rows', '$.tracks[*].events[*].body'],
  ])('rejects a state scope that is %s', (_name, scope) => {
    expect(() =>
      compileProjection(
        projection({
          name: 'rows',
          rows: '$.tracks[0].events[*]',
          key: 'id',
          state: { tick: { scope, init: 0, update: 'tick + 1' } },
          columns: { tick: { expr: 'tick', type: 'int64' } },
        }),
      ),
    ).toThrowError(/PROJECTION_STATE_SCOPE_INVALID.*tables\.0\.state\.tick\.scope/);
  });

  it.each([
    ['where', 'missing', undefined, 'tables.0.where'],
    [
      'state update',
      undefined,
      { tick: { scope: '$', init: 0, update: 'missing + 1' } },
      'tables.0.state.tick.update',
    ],
  ])('rejects undeclared state references in %s', (_name, where, state, path) => {
    expect(() =>
      compileProjection(
        projection({
          name: 'rows',
          rows: '$.items[*]',
          ...(where === undefined ? {} : { where }),
          key: 'id',
          ...(state === undefined ? {} : { state }),
          columns: { value: { expr: '1', type: 'int32' } },
        }),
      ),
    ).toThrowError(new RegExp(`EXPRESSION_STATE_UNDECLARED.*${path.replaceAll('.', '\\.')}`));
  });

  it('rejects undeclared state references in column expressions and guards', () => {
    for (const column of [
      { expr: 'missing', type: 'int32' as const },
      { expr: '1', type: 'int32' as const, when: 'missing' },
    ]) {
      expect(() =>
        compileProjection(
          projection({
            name: 'rows',
            rows: '$.items[*]',
            key: 'id',
            columns: { value: column },
          }),
        ),
      ).toThrowError(/EXPRESSION_STATE_UNDECLARED.*tables\.0\.columns\.value/);
    }
  });

  it('allows every declared state register in expressions', () => {
    expect(() =>
      compileProjection(
        projection({
          name: 'rows',
          rows: '$.items[*]',
          where: 'left >= 0 and right >= 0',
          key: 'id',
          state: {
            left: { scope: '$', init: 0, update: 'left + _.value' },
            right: { scope: '$', init: 0, update: 'right + left' },
          },
          columns: { value: { expr: 'left + right', type: 'int32', when: 'right >= 0' } },
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['reserved key', '_src_start', { value: { expr: '1', type: 'int32' as const } }, 'key'],
    ['reserved column', 'id', { _src_end: { expr: '1', type: 'uint64' as const } }, 'columns._src_end'],
  ])('rejects a %s that would make output column lengths ambiguous', (_name, key, columns, path) => {
    expect(() =>
      compileProjection(
        projection({
          name: 'rows',
          rows: '$',
          key,
          columns,
        }),
      ),
    ).toThrowError(new RegExp(`PROJECTION_SPEC_INVALID.*tables\\.0\\.${path.replaceAll('.', '\\.')}`));
  });
});
