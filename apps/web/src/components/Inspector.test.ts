// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/svelte';
import { tableFromArrays } from 'apache-arrow';
import { afterEach, describe, expect, it } from 'vitest';

import Inspector from './Inspector.svelte';
import {
  emptyLabelResultTable,
  mixedDuplicateResultTable,
  withResultLabels,
} from './result-columns.test-support.js';

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
});
