// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ParseIssue } from '@byteql/core';

import { initialSessionState, type SessionState } from '../lib/session/state.js';
import Explorer from './Explorer.svelte';

const issue = (overrides: Partial<ParseIssue>): ParseIssue => ({
  stage: 'parsing',
  track: null,
  code: 'E0',
  message: 'problem',
  recoverable: true,
  sourceStart: null,
  sourceEnd: null,
  ...overrides,
});

function catalogState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    ...initialSessionState,
    phase: 'ready',
    source: {
      files: [
        { name: 'first.pcap', size: 2048 },
        { name: 'second.pcap', size: 512 },
      ],
      totalSize: 2560,
    },
    format: { id: 'pcap', title: 'Network capture' },
    tables: [
      {
        name: 'packets',
        rowCount: 300,
        columns: [
          { name: 'packet_id', type: 'int64', nullable: false },
          { name: 'length', type: 'int64', nullable: true },
        ],
      },
      { name: 'dns', rowCount: 12, columns: [{ name: 'query_name', type: 'utf8', nullable: true }] },
    ],
    queries: [
      { id: 'overview', title: 'Packet overview', kind: 'grid', sql: 'select * from packets' },
      { id: 'dns', title: 'DNS questions', kind: 'grid', sql: 'select * from dns' },
    ],
    ...overrides,
  };
}

function renderCatalog(overrides: Record<string, unknown> = {}) {
  const handlers = {
    onquery: vi.fn(),
    onbrowse: vi.fn(),
    onselectsource: vi.fn(),
  };
  const view = render(Explorer, { state: catalogState(), ...handlers, ...overrides });
  return { ...view, ...handlers };
}

describe('Explorer source catalog', () => {
  afterEach(cleanup);

  it('keeps the Data explorer landmark and names the visible section Sources', () => {
    renderCatalog();
    const navigation = screen.getByRole('navigation', { name: 'Data explorer' });
    expect(within(navigation).getByRole('heading', { name: 'Sources' })).toBeTruthy();
    expect(screen.queryByText('Capture map')).toBeNull();
    expect(screen.queryByText('Explorer')).toBeNull();
  });

  it('calls only onselectsource when a source row is chosen', async () => {
    const { onselectsource, onbrowse, onquery } = renderCatalog();

    await fireEvent.click(screen.getByRole('button', { name: /second\.pcap/u }));

    expect(onselectsource).toHaveBeenCalledExactlyOnceWith('second.pcap');
    // Choosing a source changes which bytes are shown; it never reruns or rewrites SQL.
    expect(onbrowse).not.toHaveBeenCalled();
    expect(onquery).not.toHaveBeenCalled();
  });

  it('marks the source whose bytes are on screen', () => {
    renderCatalog({ currentFile: 'second.pcap' });

    const current = screen.getByRole('button', { name: /second\.pcap/u });
    expect(current.textContent).toContain('Viewing bytes');
    expect(current.getAttribute('aria-current')).toBe('true');

    const other = screen.getByRole('button', { name: /first\.pcap/u });
    expect(other.textContent).not.toContain('Viewing bytes');
    expect(other.getAttribute('aria-current')).toBeNull();
  });

  it('calls only onbrowse from a table Browse action', async () => {
    const { onbrowse, onquery, onselectsource } = renderCatalog();

    await fireEvent.click(screen.getByRole('button', { name: 'Browse packets' }));

    expect(onbrowse).toHaveBeenCalledExactlyOnceWith('packets');
    expect(onquery).not.toHaveBeenCalled();
    expect(onselectsource).not.toHaveBeenCalled();
  });

  it('expands a schema independently of Browse', async () => {
    const { onbrowse } = renderCatalog();

    const disclosure = screen.getByRole('button', { name: /^packets/u });
    const schema = document.getElementById(disclosure.getAttribute('aria-controls')!)!;
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(schema.hasAttribute('hidden')).toBe(true);

    await fireEvent.click(disclosure);

    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(schema.hasAttribute('hidden')).toBe(false);
    expect(within(schema).getByText('packet_id')).toBeTruthy();
    // Expanding one table leaves the others closed and runs no query.
    expect(screen.getByRole('button', { name: /^dns/u }).getAttribute('aria-expanded')).toBe('false');
    expect(onbrowse).not.toHaveBeenCalled();

    await fireEvent.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(schema.hasAttribute('hidden')).toBe(true);
  });

  it('controls the schema list it owns without using table names as DOM ids', async () => {
    renderCatalog({
      state: catalogState({
        tables: [
          { name: 'weird name.1', rowCount: 1, columns: [{ name: 'a', type: 'utf8', nullable: false }] },
        ],
      }),
    });

    const disclosure = screen.getByRole('button', { name: /^weird name\.1/u });
    const controlled = disclosure.getAttribute('aria-controls')!;
    expect(controlled).not.toContain('weird name');
    const schema = document.getElementById(controlled)!;
    expect(schema).toBeTruthy();

    await fireEvent.click(disclosure);
    expect(schema.hasAttribute('hidden')).toBe(false);
    expect(within(schema).getByText('a')).toBeTruthy();
  });

  it('calls only onquery for an example query and names the section Example queries', async () => {
    const { onquery, onbrowse, onselectsource } = renderCatalog();

    expect(screen.getByRole('heading', { name: 'Example queries' })).toBeTruthy();
    expect(screen.queryByText('Saved queries')).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'DNS questions' }));

    expect(onquery).toHaveBeenCalledExactlyOnceWith('select * from dns');
    expect(onbrowse).not.toHaveBeenCalled();
    expect(onselectsource).not.toHaveBeenCalled();
  });

  it('caps the diagnostics list at 50 items and reports the remainder', () => {
    const issues = Array.from({ length: 63 }, (_, index) =>
      issue({ code: `E${index}`, message: `problem ${index}` }),
    );
    renderCatalog({ state: catalogState({ issues }) });

    const diagnostics = screen.getByLabelText('Parse diagnostics');
    expect(within(diagnostics).getByText('E0')).toBeTruthy();
    expect(within(diagnostics).getByText('E49')).toBeTruthy();
    expect(within(diagnostics).queryByText('E50')).toBeNull();
    expect(within(diagnostics).getByText('…and 13 more')).toBeTruthy();
  });

  it('omits the remainder line when every diagnostic is shown', () => {
    const issues = Array.from({ length: 3 }, (_, index) => issue({ code: `E${index}` }));
    renderCatalog({ state: catalogState({ issues }) });

    expect(screen.queryByText(/and \d+ more/u)).toBeNull();
  });

  it('keeps the Tables region and its count', () => {
    renderCatalog();
    const tables = screen.getByRole('region', { name: 'Tables' });
    expect(within(tables).getByText('300 rows')).toBeTruthy();
    expect(within(tables).getByText('2')).toBeTruthy();
  });
});
