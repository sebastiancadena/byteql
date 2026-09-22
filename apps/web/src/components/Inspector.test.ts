// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/svelte';
import { Field, List, Struct, Table, Uint64, tableFromArrays, vectorFromArray } from 'apache-arrow';
import { afterEach, describe, expect, it } from 'vitest';

import Inspector from './Inspector.svelte';
import {
  emptyLabelResultTable,
  mixedDuplicateResultTable,
  withResultLabels,
} from '../test-support/result-columns.js';

function ambiguousProvenanceTable(duplicateLabel: '_src_file' | '_src_start' | '_src_end') {
  const duplicateValue =
    duplicateLabel === '_src_file'
      ? ['other.pcap']
      : duplicateLabel === '_src_start'
        ? BigUint64Array.from([14n])
        : BigUint64Array.from([26n]);
  return withResultLabels(
    tableFromArrays({
      c0: ['capture.pcap'],
      c1: BigUint64Array.from([12n]),
      c2: BigUint64Array.from([24n]),
      c3: duplicateValue,
    }),
    ['_src_file', '_src_start', '_src_end', duplicateLabel],
  );
}

describe('Inspector result columns', () => {
  afterEach(cleanup);

  it('renders repeated SQL labels and mixed-type values by column position', () => {
    render(Inspector, { table: mixedDuplicateResultTable(), selectedRow: 0 });

    expect(screen.getAllByText('dup')).toHaveLength(2);
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('ten')).toBeTruthy();
  });

  it('renders a schema-only repeated-label result without duplicate keys', () => {
    render(Inspector, { table: mixedDuplicateResultTable() });

    expect(screen.getAllByText('dup')).toHaveLength(2);
    expect(screen.getByText('Int32')).toBeTruthy();
    expect(screen.getByText('Utf8')).toBeTruthy();
  });

  it('preserves an empty SQL label without showing its physical field name', () => {
    render(Inspector, { table: emptyLabelResultTable(), selectedRow: 0 });

    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.queryByText('c0')).toBeNull();
  });

  it.each(['_src_file', '_src_start', '_src_end'] as const)(
    'explains ambiguous %s provenance while retaining every source value',
    (duplicateLabel) => {
      render(Inspector, { table: ambiguousProvenanceTable(duplicateLabel), selectedRow: 0 });

      const values = screen.getByRole('heading', { name: 'Field values' }).parentElement!;
      const provenance = screen.getByRole('heading', { name: 'Provenance' }).parentElement!;
      expect(
        within(provenance).getByText('Byte provenance is ambiguous because source columns are repeated.'),
      ).toBeTruthy();
      expect(within(values).queryByText('_src_start')).toBeNull();
      expect(within(values).queryByText('_src_end')).toBeNull();
      expect(within(provenance).getAllByText('_src_start')).toHaveLength(
        duplicateLabel === '_src_start' ? 2 : 1,
      );
      expect(within(provenance).getAllByText('_src_end')).toHaveLength(duplicateLabel === '_src_end' ? 2 : 1);
      expect(screen.getAllByText(duplicateLabel === '_src_start' ? '14' : '12')).not.toHaveLength(0);
      expect(screen.getAllByText(duplicateLabel === '_src_end' ? '26' : '24')).not.toHaveLength(0);
      if (duplicateLabel === '_src_file') {
        expect(within(values).getByText('capture.pcap')).toBeTruthy();
        expect(within(values).getByText('other.pcap')).toBeTruthy();
      }
    },
  );

  it('lists each exact piece for a reassembled row, alongside its bounding span', () => {
    const rangesType = new List(
      new Field(
        'item',
        new Struct([new Field('start', new Uint64(), true), new Field('end', new Uint64(), true)]),
        true,
      ),
    );
    const base = tableFromArrays({
      _src_file: ['capture.pcap'],
      _src_start: BigUint64Array.from([10n]),
      _src_end: BigUint64Array.from([60n]),
    });
    const ranges = vectorFromArray(
      [
        [
          { start: 10n, end: 20n },
          { start: 50n, end: 60n },
        ],
      ],
      rangesType,
    );
    const table = base.assign(new Table({ _src_ranges: ranges }));

    render(Inspector, { table, selectedRow: 0 });

    const provenance = screen.getByRole('heading', { name: 'Provenance' }).parentElement!;
    expect(within(provenance).getByText('Bytes 10–60 · bounding span · exact: 2 ranges')).toBeTruthy();
    expect(within(provenance).getByText('10-20')).toBeTruthy();
    expect(within(provenance).getByText('50-60')).toBeTruthy();
  });

  function reassembledRangesTable(pieceCount = 2) {
    const rangesType = new List(
      new Field(
        'item',
        new Struct([new Field('start', new Uint64(), true), new Field('end', new Uint64(), true)]),
        true,
      ),
    );
    const base = tableFromArrays({
      _src_file: ['capture.pcap'],
      _src_start: BigUint64Array.from([10n]),
      _src_end: BigUint64Array.from([10n + BigInt(pieceCount) * 20n]),
    });
    const pieces = Array.from({ length: pieceCount }, (_, i) => ({
      start: BigInt(10 + i * 20),
      end: BigInt(20 + i * 20),
    }));
    const ranges = vectorFromArray([pieces], rangesType);
    return base.assign(new Table({ _src_ranges: ranges }));
  }

  it('caps the rendered piece list at 50 with a "more" summary item', () => {
    render(Inspector, { table: reassembledRangesTable(55), selectedRow: 0 });

    const provenance = screen.getByRole('heading', { name: 'Provenance' }).parentElement!;
    expect(within(provenance).getAllByRole('listitem')).toHaveLength(51);
    expect(within(provenance).getByText('… +5 more')).toBeTruthy();
  });

  it('hides exact pieces when the file is not among known sources', () => {
    render(Inspector, {
      table: reassembledRangesTable(),
      selectedRow: 0,
      sourceFiles: [{ name: 'other.pcap', size: 1000 }],
    });

    const provenance = screen.getByRole('heading', { name: 'Provenance' }).parentElement!;
    expect(within(provenance).getByText('Source bytes are unavailable for this row.')).toBeTruthy();
    expect(within(provenance).queryByText('10-20')).toBeNull();
  });

  it('hides exact pieces when the bounding span exceeds the known file size', () => {
    render(Inspector, {
      table: reassembledRangesTable(),
      selectedRow: 0,
      sourceFiles: [{ name: 'capture.pcap', size: 30 }],
    });

    const provenance = screen.getByRole('heading', { name: 'Provenance' }).parentElement!;
    expect(within(provenance).getByText('Source bytes are unavailable for this row.')).toBeTruthy();
    expect(within(provenance).queryByText('10-20')).toBeNull();
  });
});
