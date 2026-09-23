import { describe, expect, it } from 'vitest';

import { ipcToTable } from '../arrow/build.js';
import { memoryByteSource } from '../byte-source.js';
import type { DefinedPack, OpenWithOptions } from '../pack/define.js';
import { PackFatalError } from '../pack/framer.js';
import type { ParseResult, RecordSource } from '../protocol.js';
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

const run = (pack: DefinedPack, bytes: Uint8Array, container: string, tuning: OpenWithOptions = {}) =>
  collectSource(pack, bytes, {
    open: (source, opts) => pack.openWith(source, opts, { container, strictFields: true, ...tuning }),
  });

const rowsOf = (result: ParseResult): Record<string, string> =>
  Object.fromEntries(
    result.tables.map((t) => [
      t.name,
      JSON.stringify(ipcToTable(t.ipc).toArray(), (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
    ]),
  );

/** Invariant checks over a finished result: declared schema, strict fields, provenance bounds. */
export const assertTableInvariants = (pack: DefinedPack, result: ParseResult, size: number): void => {
  const schemas = new Map(pack.schemas().map((s) => [s.name, s]));
  for (const transfer of result.tables) {
    const schema = schemas.get(transfer.name);
    expect(schema, `undeclared table ${transfer.name}`).toBeDefined();
    const table = ipcToTable(transfer.ipc);
    expect(table.schema.fields.map((f) => f.name)).toEqual(schema!.columns.map((c) => c.name));
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
        expect(piece.start >= previous && piece.end <= end && piece.start < piece.end).toBe(true);
        previous = piece.end;
      }
    }
  }
};

/**
 * Drives one mutated input to completion: resolves when the pack either finishes cleanly or
 * throws `PackFatalError`, and rejects (mentioning "unclassified") for anything else — an
 * unclassified crash is what fuzzing exists to catch.
 */
export const runFuzzCase = async (pack: DefinedPack, bytes: Uint8Array, container: string): Promise<void> => {
  try {
    const source: RecordSource = pack.openWith(
      memoryByteSource(bytes),
      { signal: new AbortController().signal },
      { container, strictFields: true },
    );
    for (let b = await source.nextBatch(); b; b = await source.nextBatch()) {
      /* drain */
    }
    source.finish();
  } catch (error) {
    if (error instanceof PackFatalError) return;
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
          expect(pack.probeContainer(bytes.subarray(0, 4096))?.container).toBe(fixture.container);
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
          const baseline = rowsOf(await run(pack, bytes, fixture.container));
          expect(rowsOf(await run(pack, bytes, fixture.container))).toEqual(baseline);
          const chunkSizes = bytes.byteLength <= maxBytes ? [1, 7] : [4093];
          for (const chunkBytes of chunkSizes) {
            const tuned = await run(pack, bytes, fixture.container, {
              chunkBytes,
              flushRowThreshold: 1,
              yieldInterval: 1,
            });
            expect(rowsOf(tuned), `chunkBytes=${chunkBytes}`).toEqual(baseline);
          }
        });

        it('aborts cleanly', { timeout }, async () => {
          const bytes = await fixture.load();
          const controller = new AbortController();
          const source = pack.openWith(
            memoryByteSource(bytes),
            { signal: controller.signal },
            { container: fixture.container },
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
              await runFuzzCase(
                pack,
                bytes.slice(0, Math.floor((bytes.byteLength * i) / (fuzz.truncations + 1))),
                fixture.container,
              );
            }
            for (let i = 0; i < fuzz.flips; i += 1) {
              const mutant = bytes.slice();
              const at = Math.floor(random() * mutant.byteLength);
              mutant[at] = mutant[at]! ^ (1 + Math.floor(random() * 255));
              await runFuzzCase(pack, mutant, fixture.container);
              const result = await run(pack, mutant, fixture.container).catch((error: unknown) => {
                if (error instanceof PackFatalError) return null;
                throw error;
              });
              if (result) assertTableInvariants(pack, result, mutant.byteLength);
            }
          });
        }
      });
    }
  });
};
