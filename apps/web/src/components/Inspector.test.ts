// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import Inspector from './Inspector.svelte';
import { emptyLabelResultTable, mixedDuplicateResultTable } from './result-columns.test-support.js';

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
});
