import { readFile } from 'node:fs/promises';

import { ipcToTable, parseProjectionSpec, type TableTransfer } from '@byteql/core';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { midiFile } from '../test/fixtures.js';
import { parseAndProjectMidi } from './project-midi.js';

const fixtureUrl = (name: string): URL => new URL(`../test/fixtures/${name}`, import.meta.url);
const packUrl = (name: string): URL => new URL(`../${name}`, import.meta.url);
const loadFixture = (name: string): Promise<Uint8Array> =>
  readFile(fixtureUrl(name)).then((bytes) => new Uint8Array(bytes));

const transfer = (tables: readonly TableTransfer[], name: string): TableTransfer => {
  const found = tables.find((table) => table.name === name);
  if (!found) throw new Error(`missing table ${name}`);
  return found;
};

const rows = (table: TableTransfer): Record<string, unknown>[] => {
  const arrow = ipcToTable(table.ipc);
  return Array.from({ length: arrow.numRows }, (_, rowIndex) =>
    Object.fromEntries(
      arrow.schema.fields.map((field, columnIndex) => [
        field.name,
        arrow.getChildAt(columnIndex)?.get(rowIndex) ?? null,
      ]),
    ),
  );
};

interface ExpectedEvent {
  event_id: bigint;
  track: number;
  event_index: number;
  delta_time: bigint;
  tick: bigint;
  kind: string;
  channel?: number;
  note?: number;
  velocity?: number;
  controller?: number;
  value?: number;
  program?: number;
  pressure?: number;
  bend?: number;
  start: bigint;
  end: bigint;
}

const event = ({ start, end, ...values }: ExpectedEvent): Record<string, unknown> => ({
  ...values,
  channel: values.channel ?? null,
  note: values.note ?? null,
  velocity: values.velocity ?? null,
  controller: values.controller ?? null,
  value: values.value ?? null,
  program: values.program ?? null,
  pressure: values.pressure ?? null,
  bend: values.bend ?? null,
  _src_start: start,
  _src_end: end,
});

const expectedHeader = (format: number, numTracks: number, division: number) => ({
  header_id: 1n,
  format,
  num_tracks: numTracks,
  division,
  _src_start: 0n,
  _src_end: 14n,
});

describe('MIDI format pack', () => {
  it('compiles the declarative tables and declares the complete relational schema', async () => {
    const source = await readFile(packUrl('midi.tables.yaml'), 'utf8');
    const spec = parseProjectionSpec(source);

    expect(spec.tables.map((table) => table.name)).toEqual(['header', 'events', 'tempo']);
    expect(Object.keys(spec.tables[1]!.columns)).toEqual([
      'track',
      'event_index',
      'delta_time',
      'tick',
      'kind',
      'channel',
      'note',
      'velocity',
      'controller',
      'value',
      'program',
      'pressure',
      'bend',
    ]);
    expect(spec.tables[1]!.state?.tick?.scope).toBe('$.tracks[*]');
    expect(spec.tables[2]!.state?.tick?.scope).toBe('$.tracks[*]');
  });

  it('declares all bounded queries and the required cumulative tempo semantics', async () => {
    const pack = parseYaml(await readFile(packUrl('queries.yaml'), 'utf8')) as {
      queries: Array<{ id: string; kind: 'grid' | 'playback'; sql: string }>;
    };

    expect(pack.queries.map((query) => query.id)).toEqual([
      'overview',
      'play_all',
      'drums',
      'bassline',
      'note_histogram',
    ]);
    for (const query of pack.queries) {
      expect(query.sql, query.id).toMatch(/\blimit\s+\d+\s*;?\s*$/iu);
    }
    for (const id of ['play_all', 'drums', 'bassline']) {
      const sql = pack.queries.find((query) => query.id === id)!.sql;
      expect(sql).toContain('select 0, 500000, 0');
      expect(sql).toContain('partition by tick order by tempo_id desc');
      expect(sql).toContain('lag(us_per_quarter, 1, 500000)');
      expect(sql).toContain('sum((tick - previous_tick) * previous_tempo / h.division / 1000000.0)');
      expect(sql).toContain('asof join tempo_map tm on e.tick >= tm.tick');
      expect(sql).toContain('(e.tick - tm.tick) * tm.us_per_quarter / h.division / 1000000.0');
      expect(sql).toMatch(/order by seconds, e\.event_id\s+limit 100000;/u);
    }
    expect(pack.queries.find((query) => query.id === 'drums')!.sql).toContain('e.channel = 9');
    expect(pack.queries.find((query) => query.id === 'bassline')!.sql).toContain('e.note < 48');
  });
});

describe('parseAndProjectMidi', () => {
  it('projects exact Type 0 rows and disables audio for SMPTE division', async () => {
    const result = await parseAndProjectMidi(
      await loadFixture('basic-type0.mid'),
      new AbortController().signal,
    );

    expect(result.capabilities.audio).toEqual({
      enabled: false,
      reason: 'SMPTE time division is not supported by the Phase 0 player.',
    });
    expect(rows(transfer(result.tables, 'header'))).toEqual([expectedHeader(0, 1, -6360)]);
    expect(rows(transfer(result.tables, 'events'))).toEqual([
      event({
        event_id: 1n,
        track: 0,
        event_index: 0,
        delta_time: 0n,
        tick: 0n,
        kind: 'meta',
        start: 22n,
        end: 29n,
      }),
      event({
        event_id: 2n,
        track: 0,
        event_index: 1,
        delta_time: 0n,
        tick: 0n,
        kind: 'program_change',
        channel: 0,
        program: 5,
        start: 29n,
        end: 32n,
      }),
      event({
        event_id: 3n,
        track: 0,
        event_index: 2,
        delta_time: 0n,
        tick: 0n,
        kind: 'note_on',
        channel: 0,
        note: 60,
        velocity: 100,
        start: 32n,
        end: 36n,
      }),
      event({
        event_id: 4n,
        track: 0,
        event_index: 3,
        delta_time: 480n,
        tick: 480n,
        kind: 'note_off',
        channel: 0,
        note: 60,
        velocity: 0,
        start: 36n,
        end: 40n,
      }),
      event({
        event_id: 5n,
        track: 0,
        event_index: 4,
        delta_time: 0n,
        tick: 480n,
        kind: 'meta',
        start: 40n,
        end: 44n,
      }),
    ]);
    expect(rows(transfer(result.tables, 'tempo'))).toEqual([
      { tempo_id: 1n, track: 0, tick: 0n, us_per_quarter: 500000, _src_start: 22n, _src_end: 29n },
    ]);
    expect(result.issues).toEqual([]);
  });

  it('projects running status, multi-byte deltas, tempo changes, and all event variants', async () => {
    const result = await parseAndProjectMidi(
      await loadFixture('running-status-type1.mid'),
      new AbortController().signal,
    );

    expect(result.capabilities.audio).toEqual({ enabled: true, reason: null });
    expect(rows(transfer(result.tables, 'header'))).toEqual([expectedHeader(1, 2, 480)]);
    expect(rows(transfer(result.tables, 'events'))).toEqual([
      event({
        event_id: 1n,
        track: 0,
        event_index: 0,
        delta_time: 0n,
        tick: 0n,
        kind: 'meta',
        start: 22n,
        end: 29n,
      }),
      event({
        event_id: 2n,
        track: 0,
        event_index: 1,
        delta_time: 480n,
        tick: 480n,
        kind: 'meta',
        start: 29n,
        end: 37n,
      }),
      event({
        event_id: 3n,
        track: 0,
        event_index: 2,
        delta_time: 0n,
        tick: 480n,
        kind: 'meta',
        start: 37n,
        end: 41n,
      }),
      event({
        event_id: 4n,
        track: 1,
        event_index: 0,
        delta_time: 0n,
        tick: 0n,
        kind: 'note_on',
        channel: 9,
        note: 36,
        velocity: 100,
        start: 49n,
        end: 53n,
      }),
      event({
        event_id: 5n,
        track: 1,
        event_index: 1,
        delta_time: 128n,
        tick: 128n,
        kind: 'note_on',
        channel: 9,
        note: 38,
        velocity: 90,
        start: 53n,
        end: 57n,
      }),
      event({
        event_id: 6n,
        track: 1,
        event_index: 2,
        delta_time: 128n,
        tick: 256n,
        kind: 'note_off',
        channel: 9,
        note: 36,
        velocity: 0,
        start: 57n,
        end: 61n,
      }),
      event({
        event_id: 7n,
        track: 1,
        event_index: 3,
        delta_time: 0n,
        tick: 256n,
        kind: 'program_change',
        channel: 2,
        program: 33,
        start: 61n,
        end: 64n,
      }),
      event({
        event_id: 8n,
        track: 1,
        event_index: 4,
        delta_time: 0n,
        tick: 256n,
        kind: 'program_change',
        channel: 2,
        program: 34,
        start: 64n,
        end: 66n,
      }),
      event({
        event_id: 9n,
        track: 1,
        event_index: 5,
        delta_time: 0n,
        tick: 256n,
        kind: 'sysex',
        start: 66n,
        end: 72n,
      }),
      event({
        event_id: 10n,
        track: 1,
        event_index: 6,
        delta_time: 0n,
        tick: 256n,
        kind: 'meta',
        start: 72n,
        end: 76n,
      }),
    ]);
    expect(rows(transfer(result.tables, 'tempo'))).toEqual([
      { tempo_id: 1n, track: 0, tick: 0n, us_per_quarter: 500000, _src_start: 22n, _src_end: 29n },
      { tempo_id: 2n, track: 0, tick: 480n, us_per_quarter: 400000, _src_start: 29n, _src_end: 37n },
    ]);
  });

  it('projects every channel-event variant into its nullable columns', async () => {
    const bytes = midiFile({
      format: 0,
      division: 480,
      tracks: [
        Uint8Array.of(
          0x00,
          0x80,
          0x3c,
          0x20,
          0x00,
          0xa1,
          0x3d,
          0x40,
          0x00,
          0xb2,
          0x07,
          0x64,
          0x00,
          0xd3,
          0x45,
          0x00,
          0xe4,
          0x00,
          0x40,
          0x00,
          0xe5,
          0x00,
          0x00,
          0x00,
          0xe6,
          0x7f,
          0x7f,
          0x00,
          0xff,
          0x2f,
          0x00,
        ),
      ],
    });
    const result = await parseAndProjectMidi(bytes, new AbortController().signal);

    expect(rows(transfer(result.tables, 'events'))).toEqual([
      event({
        event_id: 1n,
        track: 0,
        event_index: 0,
        delta_time: 0n,
        tick: 0n,
        kind: 'note_off',
        channel: 0,
        note: 60,
        velocity: 32,
        start: 22n,
        end: 26n,
      }),
      event({
        event_id: 2n,
        track: 0,
        event_index: 1,
        delta_time: 0n,
        tick: 0n,
        kind: 'polyphonic_pressure',
        channel: 1,
        note: 61,
        pressure: 64,
        start: 26n,
        end: 30n,
      }),
      event({
        event_id: 3n,
        track: 0,
        event_index: 2,
        delta_time: 0n,
        tick: 0n,
        kind: 'controller',
        channel: 2,
        controller: 7,
        value: 100,
        start: 30n,
        end: 34n,
      }),
      event({
        event_id: 4n,
        track: 0,
        event_index: 3,
        delta_time: 0n,
        tick: 0n,
        kind: 'channel_pressure',
        channel: 3,
        pressure: 69,
        start: 34n,
        end: 37n,
      }),
      event({
        event_id: 5n,
        track: 0,
        event_index: 4,
        delta_time: 0n,
        tick: 0n,
        kind: 'pitch_bend',
        channel: 4,
        bend: 0,
        start: 37n,
        end: 41n,
      }),
      event({
        event_id: 6n,
        track: 0,
        event_index: 5,
        delta_time: 0n,
        tick: 0n,
        kind: 'pitch_bend',
        channel: 5,
        bend: -8192,
        start: 41n,
        end: 45n,
      }),
      event({
        event_id: 7n,
        track: 0,
        event_index: 6,
        delta_time: 0n,
        tick: 0n,
        kind: 'pitch_bend',
        channel: 6,
        bend: 8191,
        start: 45n,
        end: 49n,
      }),
      event({
        event_id: 8n,
        track: 0,
        event_index: 7,
        delta_time: 0n,
        tick: 0n,
        kind: 'meta',
        start: 49n,
        end: 53n,
      }),
    ]);
  });

  it('parses escaped F7 SysEx through its payload and preserves following-event provenance', async () => {
    const bytes = midiFile({
      format: 0,
      division: 480,
      tracks: [Uint8Array.of(0x00, 0xf7, 0x03, 0x01, 0x02, 0x03, 0x00, 0xff, 0x2f, 0x00)],
    });

    const result = await parseAndProjectMidi(bytes, new AbortController().signal);

    expect(result.issues).toEqual([]);
    expect(rows(transfer(result.tables, 'events'))).toEqual([
      event({
        event_id: 1n,
        track: 0,
        event_index: 0,
        delta_time: 0n,
        tick: 0n,
        kind: 'sysex',
        start: 22n,
        end: 28n,
      }),
      event({
        event_id: 2n,
        track: 0,
        event_index: 1,
        delta_time: 0n,
        tick: 0n,
        kind: 'meta',
        start: 28n,
        end: 32n,
      }),
    ]);
  });

  it('keeps invalid-length tempo metadata as an event but omits it from the tempo table', async () => {
    const bytes = midiFile({
      format: 0,
      division: 480,
      tracks: [
        Uint8Array.of(0x00, 0xff, 0x51, 0x02, 0x07, 0xa1, 0x00, 0x90, 0x3c, 0x40, 0x00, 0xff, 0x2f, 0x00),
      ],
    });

    const result = await parseAndProjectMidi(bytes, new AbortController().signal);

    expect(result.issues).toEqual([]);
    expect(rows(transfer(result.tables, 'events'))).toEqual([
      event({
        event_id: 1n,
        track: 0,
        event_index: 0,
        delta_time: 0n,
        tick: 0n,
        kind: 'meta',
        start: 22n,
        end: 28n,
      }),
      event({
        event_id: 2n,
        track: 0,
        event_index: 1,
        delta_time: 0n,
        tick: 0n,
        kind: 'note_on',
        channel: 0,
        note: 60,
        velocity: 64,
        start: 28n,
        end: 32n,
      }),
      event({
        event_id: 3n,
        track: 0,
        event_index: 2,
        delta_time: 0n,
        tick: 0n,
        kind: 'meta',
        start: 32n,
        end: 36n,
      }),
    ]);
    expect(rows(transfer(result.tables, 'tempo'))).toEqual([]);
  });

  it('keeps a malformed track prefix, continues with the next track, and emits one exact error row', async () => {
    const result = await parseAndProjectMidi(
      await loadFixture('malformed-then-valid.mid'),
      new AbortController().signal,
    );

    expect(rows(transfer(result.tables, 'events'))).toEqual([
      event({
        event_id: 1n,
        track: 0,
        event_index: 0,
        delta_time: 0n,
        tick: 0n,
        kind: 'note_on',
        channel: 0,
        note: 60,
        velocity: 64,
        start: 22n,
        end: 26n,
      }),
      event({
        event_id: 2n,
        track: 1,
        event_index: 0,
        delta_time: 0n,
        tick: 0n,
        kind: 'note_on',
        channel: 1,
        note: 65,
        velocity: 80,
        start: 37n,
        end: 41n,
      }),
      event({
        event_id: 3n,
        track: 1,
        event_index: 1,
        delta_time: 0n,
        tick: 0n,
        kind: 'meta',
        start: 41n,
        end: 45n,
      }),
    ]);
    expect(result.issues).toEqual([
      {
        stage: 'normalizing',
        track: 0,
        code: 'UNSUPPORTED_STATUS',
        message: 'UNSUPPORTED_STATUS at offset 27: unsupported system status 0xf1',
        recoverable: true,
        sourceStart: 27,
        sourceEnd: 28,
      },
    ]);
    expect(rows(transfer(result.tables, 'errors'))).toEqual([
      {
        error_id: 1n,
        stage: 'normalizing',
        track: 0,
        code: 'UNSUPPORTED_STATUS',
        message: 'UNSUPPORTED_STATUS at offset 27: unsupported system status 0xf1',
        recoverable: true,
        _src_start: 27n,
        _src_end: 28n,
      },
    ]);
  });

  it('projects the demo fixture in original track order with exact offsets', async () => {
    const result = await parseAndProjectMidi(await loadFixture('demo.mid'), new AbortController().signal);
    const projected = rows(transfer(result.tables, 'events'));

    expect(projected).toHaveLength(14);
    expect(
      projected.map((row) => [
        row.event_id,
        row.track,
        row.event_index,
        row.tick,
        row.kind,
        row._src_start,
        row._src_end,
      ]),
    ).toEqual([
      [1n, 0, 0, 0n, 'meta', 22n, 29n],
      [2n, 0, 1, 960n, 'meta', 29n, 37n],
      [3n, 0, 2, 960n, 'meta', 37n, 41n],
      [4n, 1, 0, 0n, 'program_change', 49n, 52n],
      [5n, 1, 1, 0n, 'note_on', 52n, 56n],
      [6n, 1, 2, 480n, 'note_off', 56n, 60n],
      [7n, 1, 3, 480n, 'note_on', 60n, 63n],
      [8n, 1, 4, 960n, 'note_off', 63n, 67n],
      [9n, 1, 5, 960n, 'meta', 67n, 71n],
      [10n, 2, 0, 0n, 'note_on', 79n, 83n],
      [11n, 2, 1, 240n, 'note_off', 83n, 87n],
      [12n, 2, 2, 240n, 'note_on', 87n, 90n],
      [13n, 2, 3, 480n, 'note_off', 90n, 94n],
      [14n, 2, 4, 480n, 'meta', 94n, 98n],
    ]);
    expect(rows(transfer(result.tables, 'tempo'))).toEqual([
      { tempo_id: 1n, track: 0, tick: 0n, us_per_quarter: 500000, _src_start: 22n, _src_end: 29n },
      { tempo_id: 2n, track: 0, tick: 960n, us_per_quarter: 400000, _src_start: 29n, _src_end: 37n },
    ]);
  });

  it('always emits a schema-stable empty errors table', async () => {
    const result = await parseAndProjectMidi(await loadFixture('demo.mid'), new AbortController().signal);
    const errors = transfer(result.tables, 'errors');

    expect(errors.rowCount).toBe(0);
    expect(errors.columns).toEqual([
      { name: 'error_id', type: 'Int64', nullable: false },
      { name: 'stage', type: 'Utf8', nullable: false },
      { name: 'track', type: 'Int32', nullable: true },
      { name: 'code', type: 'Utf8', nullable: false },
      { name: 'message', type: 'Utf8', nullable: false },
      { name: 'recoverable', type: 'Bool', nullable: false },
      { name: '_src_start', type: 'Uint64', nullable: true },
      { name: '_src_end', type: 'Uint64', nullable: true },
    ]);
    expect(rows(errors)).toEqual([]);
  });

  it('rejects Type 2 as unsupported rather than corrupt', async () => {
    const bytes = midiFile({ format: 2, division: 480, tracks: [Uint8Array.of(0, 0xff, 0x2f, 0)] });

    await expect(parseAndProjectMidi(bytes, new AbortController().signal)).rejects.toMatchObject({
      code: 'UNSUPPORTED_MIDI_TYPE',
      offset: 8,
    });
  });

  it('observes AbortSignal after yielding between tracks', async () => {
    const controller = new AbortController();
    const parsing = parseAndProjectMidi(await loadFixture('demo.mid'), controller.signal);
    setTimeout(() => controller.abort(), 0);

    await expect(parsing).rejects.toMatchObject({ name: 'AbortError' });
  });
});
