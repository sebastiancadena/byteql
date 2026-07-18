// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { tableFromArrays } from 'apache-arrow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from 'codemirror';

import type { SessionState } from '../lib/session/state.js';
import Workbench from './Workbench.svelte';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

const textOf = (element: Element): string => element.textContent ?? '';

const result = tableFromArrays({
  record_id: [1n, 2n],
  label: ['alpha', 'beta'],
  optional: [null, 'available'],
  _src_start: [12n, 28n],
  _src_end: [20n, 41n],
});

const readyState = (): SessionState => ({
  phase: 'ready',
  source: { name: 'capture.bin', size: 1536 },
  format: { id: 'example_format', title: 'Example records' },
  progress: null,
  tables: [
    {
      name: 'records',
      ipc: new Uint8Array(),
      rowCount: 42,
      columns: [
        { name: 'record_id', type: 'int64', nullable: false },
        { name: '_src_start', type: 'uint64', nullable: false },
        { name: '_src_end', type: 'uint64', nullable: false },
      ],
    },
  ],
  issues: [],
  sql: 'select * from records limit 100',
  result,
  queryElapsedMs: 4.2,
  queryError: null,
  selectedRow: null,
  fatalError: null,
});

class FakeController {
  state: SessionState;
  listeners = new Set<(state: SessionState) => void>();
  openFile = vi.fn(async () => undefined);
  openSample = vi.fn(async () => undefined);
  runQuery = vi.fn(async (sql: string) => {
    this.publish({ ...this.state, sql });
  });
  cancel = vi.fn(async () => undefined);
  selectResultRow = vi.fn((row: number | null) => {
    this.publish({ ...this.state, selectedRow: row });
  });

  constructor(state: SessionState) {
    this.state = state;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  publish(state: SessionState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

const queries = [
  {
    id: 'overview',
    title: 'Overview',
    sql: 'select * from records limit 100',
  },
  {
    id: 'recent',
    title: 'Recent records',
    sql: 'select * from records order by record_id desc limit 100',
  },
];

describe('Inspector Workbench', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('explains local processing and exposes accessible source actions in the empty state', async () => {
    const controller = new FakeController({
      ...readyState(),
      phase: 'idle',
      source: null,
      format: null,
      tables: [],
      sql: '',
      result: null,
      queryElapsedMs: null,
    });
    render(Workbench, { controller, queries });

    expect(screen.getByText(/files stay on this device/i)).toBeTruthy();
    const input = screen.getByLabelText('Open file');
    expect(input.getAttribute('type')).toBe('file');
    expect((screen.getByRole('button', { name: 'Try sample' }) as HTMLButtonElement).disabled).toBe(false);

    await fireEvent.click(screen.getByRole('button', { name: 'Try sample' }));
    expect(controller.openSample).toHaveBeenCalledOnce();
  });

  it('shows source context, pack metadata, query tools, results, and inspection landmarks', () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller, queries });

    const navigation = screen.getByRole('navigation', { name: 'Data explorer' });
    expect(within(navigation).getByText('capture.bin')).toBeTruthy();
    expect(within(navigation).getByText('Example records')).toBeTruthy();
    expect(within(navigation).getByText('records')).toBeTruthy();
    expect(within(navigation).getByText('42 rows')).toBeTruthy();
    expect(
      (within(navigation).getByRole('button', { name: 'Recent records' }) as HTMLButtonElement).disabled,
    ).toBe(false);

    const workspace = screen.getByRole('region', { name: 'SQL workspace' });
    expect(workspace).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'SQL query' })).toBeTruthy();
    expect(within(workspace).getByText('2 rows')).toBeTruthy();
    expect(screen.getByRole('grid', { name: 'Query results' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeTruthy();
  });

  it('runs the bounded overview when a source first becomes ready', async () => {
    const controller = new FakeController({
      ...readyState(),
      sql: '',
      result: null,
      queryElapsedMs: null,
    });
    render(Workbench, { controller, queries });

    await vi.waitFor(() => expect(controller.runQuery).toHaveBeenCalledWith(queries[0]!.sql));
    expect(controller.runQuery).toHaveBeenCalledOnce();
  });

  it('keeps permanent landmark labels format-neutral', () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller, queries });

    const labels = [
      screen.getByRole('banner').textContent,
      screen.getByRole('navigation', { name: 'Data explorer' }).getAttribute('aria-label'),
      screen.getByRole('region', { name: 'SQL workspace' }).getAttribute('aria-label'),
      screen.getByRole('complementary', { name: 'Inspector' }).getAttribute('aria-label'),
      screen.getByRole('contentinfo').textContent,
    ].join(' ');

    expect(labels).not.toMatch(/\b(?:midi|note|track|play)\b/iu);
  });

  it('selects rows with the keyboard and inspects provenance without changing SQL', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller, queries });

    const editor = screen.getByRole('textbox', { name: 'SQL query' });
    expect(textOf(editor)).toContain('select * from records limit 100');

    const firstRow = screen.getByRole('row', { name: /row 1/i });
    firstRow.focus();
    await fireEvent.keyDown(firstRow, { key: 'ArrowDown' });

    expect(controller.selectResultRow).toHaveBeenCalledWith(1);
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).getByText('_src_start')).toBeTruthy();
    expect(within(inspector).getByText('28')).toBeTruthy();
    expect(within(inspector).getByText('_src_end')).toBeTruthy();
    expect(within(inspector).getByText('41')).toBeTruthy();
    expect(within(inspector).getByText('optional')).toBeTruthy();
    expect(within(inspector).getByText('available')).toBeTruthy();
    expect(textOf(editor)).toContain('select * from records limit 100');
  });

  it('loads a pack query, executes with the keyboard, cancels work, and tears down its editor', async () => {
    const destroy = vi.spyOn(EditorView.prototype, 'destroy');
    const controller = new FakeController(readyState());
    const view = render(Workbench, { controller, queries });

    await fireEvent.click(screen.getByRole('button', { name: 'Recent records' }));
    const editor = screen.getByRole('textbox', { name: 'SQL query' });
    expect(textOf(editor)).toContain('order by record_id desc');
    await fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', ctrlKey: true });
    expect(controller.runQuery).toHaveBeenCalledWith(queries[1]!.sql);

    controller.publish({ ...controller.state, phase: 'querying' });
    await fireEvent.click(await screen.findByRole('button', { name: 'Cancel query' }));
    expect(controller.cancel).toHaveBeenCalledOnce();

    view.unmount();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('retains successful results and places a failed-query diagnostic beside the editor', () => {
    const controller = new FakeController({ ...readyState(), queryError: 'Unexpected token near FROM' });
    render(Workbench, { controller, queries });

    const workspace = screen.getByRole('region', { name: 'SQL workspace' });
    expect(textOf(within(workspace).getByRole('alert'))).toContain('Unexpected token near FROM');
    expect(within(workspace).getByRole('grid', { name: 'Query results' })).toBeTruthy();
    expect(within(workspace).getByText('2 rows')).toBeTruthy();
  });
});
