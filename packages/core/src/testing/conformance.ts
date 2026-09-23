import { describe, expect, it } from 'vitest';

import { ipcToTable } from '../arrow/build.js';
import { memoryByteSource } from '../byte-source.js';
import { PROBE_HEAD_BYTES, type DefinedPack, type OpenWithOptions } from '../pack/define.js';
import { PackFatalError } from '../pack/framer.js';
import type { ArrowTypeName } from '../projection/spec.js';
import type { ParseResult, RecordSource, TableSchema } from '../protocol.js';
import { collectSource } from './collect.js';
import { goldenText } from './golden.js';
import type { FixtureCase } from './index.js';

export interface ConformanceOptions {
  fixtures: readonly FixtureCase[];
  /** Golden directory, relative to the calling test file; default './goldens'. */
  goldens?: string;
  fuzz?: { seed: number; truncations: number; flips: number; maxBytes?: number };
  /** Per-test timeout in ms; default 60_000. */
  timeoutMs?: number;
}

export const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** `ArrowTypeName` -> the exact `String(field.type)` `projectedTableToArrow` produces for it. */
const ARROW_TYPE_STRINGS: Record<ArrowTypeName, string> = {
  int8: 'Int8',
  uint8: 'Uint8',
  int16: 'Int16',
  uint16: 'Uint16',
  int32: 'Int32',
  uint32: 'Uint32',
  int64: 'Int64',
  uint64: 'Uint64',
  bool: 'Bool',
  utf8: 'Utf8',
  timestamp_us: 'Timestamp<MICROSECOND>',
  binary: 'Binary',
  src_ranges: 'List<Struct<{start:Uint64, end:Uint64}>>',
};

const arrowTypeString = (type: string): string => {
  const mapped = ARROW_TYPE_STRINGS[type as ArrowTypeName] as string | undefined;
  expect(mapped, `unknown ArrowTypeName ${JSON.stringify(type)} in declared schema`).toBeDefined();
  return mapped!;
};

/** Names, order, and Arrow types of an emitted Arrow schema against the pack's declared schema. */
const assertSchemaShape = (
  schema: TableSchema,
  fields: readonly { name: string; type: unknown }[],
  label: string,
): void => {
  expect(
    fields.map((f) => f.name),
    `${label}: column names/order`,
  ).toEqual(schema.columns.map((c) => c.name));
  expect(
    fields.map((f) => String(f.type)),
    `${label}: column Arrow types`,
  ).toEqual(schema.columns.map((c) => arrowTypeString(c.type)));
};

/** Wraps a RecordSource so every batch it emits is schema-checked before the caller sees it. */
const withBatchSchemaCheck = (pack: DefinedPack, inner: RecordSource): RecordSource => {
  const schemas = new Map(pack.schemas().map((s) => [s.name, s]));
  return {
    async nextBatch() {
      const batch = await inner.nextBatch();
      if (batch) {
        const schema = schemas.get(batch.table);
        expect(schema, `undeclared table ${batch.table} in batch`).toBeDefined();
        assertSchemaShape(schema!, ipcToTable(batch.ipc).schema.fields, `batch ${batch.table}`);
      }
      return batch;
    },
    finish: () => inner.finish(),
  };
};

const run = (pack: DefinedPack, bytes: Uint8Array, container: string, tuning: OpenWithOptions = {}) =>
  collectSource(pack, bytes, {
    open: (source, opts) =>
      withBatchSchemaCheck(pack, pack.openWith(source, opts, { container, strictFields: true, ...tuning })),
  });

const rowsOf = (result: ParseResult): Record<string, string> =>
  Object.fromEntries(
    result.tables.map((t) => [
      t.name,
      JSON.stringify(ipcToTable(t.ipc).toArray(), (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
    ]),
  );

/** Table rows, issues, and capabilities — the full comparable surface of a `ParseResult`. */
const snapshotOf = (
  result: ParseResult,
): {
  tables: Record<string, string>;
  issues: ParseResult['issues'];
  capabilities: ParseResult['capabilities'];
} => ({
  tables: rowsOf(result),
  issues: result.issues,
  capabilities: result.capabilities,
});

/**
 * Invariant checks over a finished result: declared schema (names, order, and Arrow types),
 * strict-field nullability, and provenance bounds (including `_src_ranges` pieces). Must be
 * called from inside a running vitest test — it asserts via the ambient `expect`.
 */
export const assertTableInvariants = (pack: DefinedPack, result: ParseResult, size: number): void => {
  const schemas = new Map(pack.schemas().map((s) => [s.name, s]));
  for (const transfer of result.tables) {
    const schema = schemas.get(transfer.name);
    expect(schema, `undeclared table ${transfer.name}`).toBeDefined();
    const table = ipcToTable(transfer.ipc);
    assertSchemaShape(schema!, table.schema.fields, `table ${transfer.name}`);
    for (const column of schema!.columns) {
      const vector = table.getChild(column.name)!;
      if (!column.nullable) {
        expect(vector.nullCount, `${transfer.name}.${column.name} is declared non-null`).toBe(0);
      }
    }
    const starts = table.getChild('_src_start');
    const ends = table.getChild('_src_end');
    const ranges = table.getChild('_src_ranges');
    for (let row = 0; row < table.numRows; row += 1) {
      const start = starts?.get(row) as bigint | null;
      const end = ends?.get(row) as bigint | null;
      if (start === null || end === null || start === undefined || end === undefined) continue;
      expect(
        start <= end && end <= BigInt(size),
        `${transfer.name} row ${row} provenance out of bounds`,
      ).toBe(true);
      const pieces = ranges?.get(row);
      if (!pieces) continue;
      let previous = start;
      for (const piece of pieces.toArray() as { start: bigint; end: bigint }[]) {
        expect(
          piece.start >= previous && piece.end <= end && piece.start < piece.end,
          `${transfer.name} row ${row} _src_ranges piece out of bounds/order`,
        ).toBe(true);
        previous = piece.end;
      }
    }
  }
};

/**
 * Drives one mutated input to completion: resolves to the collected `ParseResult` when the pack
 * finishes cleanly, resolves to `null` when it throws `PackFatalError` (a classified, accepted
 * failure), and rejects (mentioning "unclassified") for anything else — an unclassified crash is
 * what fuzzing exists to catch. Every batch the run emits is schema-checked as it's drained (see
 * `withBatchSchemaCheck`), on top of whatever invariant checks the caller runs on the result.
 */
export const runFuzzCase = async (
  pack: DefinedPack,
  bytes: Uint8Array,
  container: string,
): Promise<ParseResult | null> => {
  try {
    return await run(pack, bytes, container);
  } catch (error) {
    if (error instanceof PackFatalError) return null;
    throw new Error(
      `unclassified failure on mutated input: ${error instanceof Error ? error.stack : String(error)}`,
      { cause: error },
    );
  }
};

/**
 * The shared conformance suite every pack's `test/conformance.test.ts` calls: probe → container,
 * schema/nullability/strict-field/provenance-bounds invariants, chunk/drain invariance,
 * determinism, clean abort, golden snapshots, and (for fixtures at or under `fuzz.maxBytes`)
 * seeded truncate/flip fuzzing.
 */
export const describePackConformance = (pack: DefinedPack, options: ConformanceOptions): void => {
  const goldens = options.goldens ?? './goldens';
  const timeout = options.timeoutMs ?? 60_000;
  const maxBytes = options.fuzz?.maxBytes ?? 65_536;
  describe(`${pack.id} conformance`, () => {
    for (const fixture of options.fixtures) {
      describe(fixture.name, () => {
        it('probes to this pack and container', async () => {
          const bytes = await fixture.load();
          expect(pack.probeContainer(bytes.subarray(0, PROBE_HEAD_BYTES))?.container).toBe(fixture.container);
        });

        it('matches its golden, schemas, strict fields, and provenance bounds', { timeout }, async () => {
          const bytes = await fixture.load();
          const result = await run(pack, bytes, fixture.container);
          assertTableInvariants(pack, result, bytes.byteLength);
          await expect(await goldenText(result)).toMatchFileSnapshot(
            `${goldens}/${fixture.name}.golden.json`,
          );
        });

        it('is deterministic and chunk/drain invariant', { timeout }, async () => {
          const bytes = await fixture.load();
          const baseline = snapshotOf(await run(pack, bytes, fixture.container));
          expect(snapshotOf(await run(pack, bytes, fixture.container))).toEqual(baseline);
          const chunkSizes = bytes.byteLength <= maxBytes ? [1, 7] : [4093];
          for (const chunkBytes of chunkSizes) {
            const tuned = await run(pack, bytes, fixture.container, {
              chunkBytes,
              flushRowThreshold: 1,
              yieldInterval: 1,
            });
            expect(snapshotOf(tuned), `chunkBytes=${chunkBytes}`).toEqual(baseline);
          }
        });

        it('aborts cleanly', { timeout }, async () => {
          const bytes = await fixture.load();
          const controller = new AbortController();
          const source = pack.openWith(
            memoryByteSource(bytes),
            { signal: controller.signal },
            { container: fixture.container, strictFields: true },
          );
          await source.nextBatch();
          controller.abort();
          await expect(source.nextBatch()).rejects.toMatchObject({ name: 'AbortError' });
        });

        if (options.fuzz) {
          const fuzz = options.fuzz;
          it('survives seeded truncations and byte flips', { timeout: timeout * 4 }, async () => {
            const bytes = await fixture.load();
            if (bytes.byteLength > maxBytes || bytes.byteLength === 0) return;
            const random = mulberry32(fuzz.seed);
            for (let i = 1; i <= fuzz.truncations; i += 1) {
              const mutant = bytes.slice(0, Math.floor((bytes.byteLength * i) / (fuzz.truncations + 1)));
              const result = await runFuzzCase(pack, mutant, fixture.container);
              if (result) assertTableInvariants(pack, result, mutant.byteLength);
            }
            for (let i = 0; i < fuzz.flips; i += 1) {
              const mutant = bytes.slice();
              const at = Math.floor(random() * mutant.byteLength);
              mutant[at] = mutant[at]! ^ (1 + Math.floor(random() * 255));
              const result = await runFuzzCase(pack, mutant, fixture.container);
              if (result) assertTableInvariants(pack, result, mutant.byteLength);
            }
          });
        }
      });
    }
  });
};
