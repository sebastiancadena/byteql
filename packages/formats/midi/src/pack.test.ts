import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { midiFormatPack } from './pack.js';

const fixtureUrl = (name: string): URL => new URL(`../test/fixtures/${name}`, import.meta.url);
const loadFixture = (name: string): Promise<Uint8Array> =>
  readFile(fixtureUrl(name)).then((bytes) => new Uint8Array(bytes));

// demo.mid: Type 1, PPQN division 480 (non-SMPTE), no malformed events -> zero issues,
// capabilities.audio enabled. See test/fixtures/manifest.md.
const validMidiBytes = (): Promise<Uint8Array> => loadFixture('demo.mid');

describe('midiFormatPack', () => {
  it('probes MThd headers with full confidence and rejects others', () => {
    expect(midiFormatPack.probe(Uint8Array.of(0x4d, 0x54, 0x68, 0x64, 0, 0))).toBe(1);
    expect(midiFormatPack.probe(Uint8Array.of(0x50, 0x4b, 3, 4))).toBeNull();
    expect(midiFormatPack.probe(Uint8Array.of(0x4d, 0x54))).toBeNull();
  });

  it('declares schemas for all four tables', () => {
    expect(midiFormatPack.schemas().map((schema) => schema.name)).toEqual([
      'header',
      'events',
      'tempo',
      'errors',
    ]);
    const events = midiFormatPack.schemas().find((schema) => schema.name === 'events')!;
    expect(events.columns.find((column) => column.name === 'note')!.nullable).toBe(true);
    expect(events.columns.find((column) => column.name === 'event_id')!.nullable).toBe(false);
  });

  it('streams every table as a batch, then null, then finish() reports capabilities', async () => {
    const source = midiFormatPack.open(await validMidiBytes(), { signal: new AbortController().signal });
    const batches = [];
    for (let batch = await source.nextBatch(); batch !== null; batch = await source.nextBatch()) {
      batches.push(batch);
    }
    expect(batches.map((batch) => batch.table)).toEqual(['header', 'events', 'tempo', 'errors']);
    expect(batches.every((batch) => batch.ipc instanceof Uint8Array)).toBe(true);
    const finish = source.finish();
    expect(finish.capabilities.audio).toEqual({ enabled: true, reason: null });
    expect(finish.issues).toEqual([]);
  });

  it('rejects when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const source = midiFormatPack.open(await validMidiBytes(), { signal: controller.signal });
    await expect(source.nextBatch()).rejects.toThrow();
  });

  it('rejects finish() after only a partial drain', async () => {
    const source = midiFormatPack.open(await validMidiBytes(), { signal: new AbortController().signal });
    const first = await source.nextBatch();
    expect(first?.table).toBe('header');
    expect(() => source.finish()).toThrow(/RECORD_SOURCE_NOT_DRAINED/);
  });
});
