// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tableFromArrays } from 'apache-arrow';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from 'codemirror';
import { midiQueries } from '@byteql/midi';

vi.mock('@byteql/db', () => ({
  isSupportedParquetType: () => true,
  unsupportedParquetTypeMessage: (column: string, type: unknown) =>
    `Column "${column}" has unsupported Parquet type ${String(type)}; cast it explicitly in SQL.`,
}));

import { initialSessionState, type PagedResultState, type SessionState } from '../lib/session/state.js';
import type { AudioEngine } from '../lib/viewers/tone-engine.js';
import ResultGrid from './ResultGrid.svelte';
import Workbench from './Workbench.svelte';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

/**
 * jsdom gives every element a zero box, so the panes the layout budget measures are declared
 * here by class. These are the design's worked example: an 800 px workspace, 36 px toolbars,
 * 8 px divider tracks and a 40 px trace strip, which solves to Query 116 / dock 248.
 */
const measuredHeights = new Map<string, number>([
  ['grid-scroll', 360],
  ['workbench-main', 800],
  ['editor-heading', 36],
  ['results-heading', 36],
  ['query-notices', 0],
  ['query-resize-slot', 8],
  ['trace-dock-strip', 40],
]);
const measuredWidths = new Map<string, number>([
  ['grid-scroll', 960],
  ['workbench-main', 1216],
  ['app-shell', 1440],
]);

function measured(sizes: Map<string, number>) {
  return function (this: HTMLElement): number {
    for (const [token, value] of sizes) if (this.classList.contains(token)) return value;
    return 0;
  };
}

for (const property of ['clientHeight', 'offsetHeight'] as const) {
  Object.defineProperty(HTMLElement.prototype, property, {
    configurable: true,
    get: measured(measuredHeights),
  });
}
for (const property of ['clientWidth', 'offsetWidth'] as const) {
  Object.defineProperty(HTMLElement.prototype, property, {
    configurable: true,
    get: measured(measuredWidths),
  });
}

const sqlWorkspace = (): HTMLElement => document.querySelector('.sql-workspace') as HTMLElement;

/** jsdom has no PointerEvent constructor; the fields the resize action reads are set by hand. */
function pointer(target: HTMLElement, type: string, clientY: number, pointerId = 1): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    isPrimary: { value: true },
    button: { value: 0 },
    clientX: { value: 0 },
    clientY: { value: clientY },
  });
  target.dispatchEvent(event);
}

/** Reports a fresh measurement and waits for the observer's frame to reach the coordinator. */
async function remeasure(): Promise<void> {
  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
  });
  await tick();
}

/** Waits for the first measured frame to reach the coordinator. */
async function settleLayout(): Promise<void> {
  await vi.waitFor(() => expect(sqlWorkspace().style.getPropertyValue('--query-height')).toBe('116px'));
}

const textOf = (element: Element): string => element.textContent ?? '';

const result = tableFromArrays({
  record_id: [1n, 2n],
  label: ['alpha', 'beta'],
  optional: [null, 'available'],
  _src_file: ['capture.bin', 'capture.bin'],
  _src_start: [12n, 28n],
  _src_end: [20n, 41n],
});

const audioResult = tableFromArrays({
  seconds: [0.5, 1.25],
  note: [60, 60],
  velocity: [64, 0],
  kind: ['note_on', 'note_off'],
  channel: [0, 0],
});

const pagedResult = (
  window: PagedResultState['window'],
  overrides: Partial<PagedResultState> = {},
): PagedResultState => ({
  generation: 1,
  schema: window.schema,
  loadedRows: window.numRows,
  complete: true,
  loadingMore: false,
  windowStart: 0,
  window,
  completeTable: window,
  elapsedMs: 4.2,
  pageError: null,
  pageErrorRetryable: false,
  ...overrides,
});

const gridProps = (table: PagedResultState['window'], overrides: Record<string, unknown> = {}) => ({
  table,
  windowStart: 0,
  loadedRows: table.numRows,
  complete: true,
  loadingMore: false,
  pageError: null,
  pageErrorRetryable: false,
  onselect: vi.fn(),
  onloadmore: vi.fn(),
  onloadwindow: vi.fn(),
  onretry: vi.fn(),
  ...overrides,
});

const readyState = (): SessionState => ({
  phase: 'ready',
  source: { files: [{ name: 'capture.bin', size: 1536 }], totalSize: 1536 },
  format: { id: 'example_format', title: 'Example records' },
  progress: null,
  openStartedAt: null,
  tables: [
    {
      name: 'records',
      rowCount: 42,
      columns: [
        { name: 'record_id', type: 'int64', nullable: false },
        { name: '_src_start', type: 'uint64', nullable: false },
        { name: '_src_end', type: 'uint64', nullable: false },
      ],
    },
  ],
  issues: [],
  queries,
  capabilities: { audio: { enabled: true, reason: null } },
  sql: 'select * from records limit 100',
  result: pagedResult(result),
  queryError: null,
  selectedRow: null,
  fatalError: null,
  byteSelection: null,
  download: null,
});

class FakeController {
  state: SessionState;
  listeners = new Set<(state: SessionState) => void>();
  openFile = vi.fn(async () => undefined);
  openFiles = vi.fn(async () => undefined);
  openSample = vi.fn(async (id: string) => {
    void id;
  });
  runQuery = vi.fn(async (sql: string) => {
    this.publish({ ...this.state, sql });
  });
  cancel = vi.fn(async () => undefined);
  loadMoreResults = vi.fn(async () => undefined);
  loadResultWindow = vi.fn(async (globalRow: number) => {
    void globalRow;
  });
  retryResultPage = vi.fn(async () => undefined);
  downloadResults = vi.fn(async () => undefined);
  cancelResultsDownload = vi.fn(async () => undefined);
  saveResultsDownload = vi.fn();
  dismissResultsDownload = vi.fn(async () => undefined);
  selectResultRow = vi.fn((row: number | null) => {
    this.publish({ ...this.state, selectedRow: row });
  });
  sourceBlob: Blob | null = new Blob([new Uint8Array(64).map((_, i) => i)]);
  selectByteRange = vi.fn((range: { file: string; start: number; end: number } | null) => {
    this.publish({ ...this.state, byteSelection: range });
  });
  getSourceBlob = vi.fn((): Blob | null => this.sourceBlob);

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

const fakeAudioEngine = (): AudioEngine => ({
  load: vi.fn(async () => undefined),
  play: vi.fn(async () => undefined),
  pause: vi.fn(),
  stop: vi.fn(),
  seek: vi.fn(),
  positionSeconds: vi.fn(() => 0),
  dispose: vi.fn(),
});

const queries = [
  {
    id: 'overview',
    title: 'Overview',
    kind: 'grid' as const,
    sql: 'select * from records limit 100',
  },
  {
    id: 'recent',
    title: 'Recent records',
    kind: 'grid' as const,
    sql: 'select * from records order by record_id desc limit 100',
  },
];

let compactMode = false;
/** Compact mode is now measured, not matched: it follows the viewport and the dock's own width.
 * jsdom's 1024 px default would tab every render, so the wide shell is declared explicitly. */
let viewportWidth = 1440;
const addMediaListener = vi.fn();
const removeMediaListener = vi.fn();

describe('Inspector Workbench', () => {
  beforeEach(() => {
    // These renders share one localStorage, so the geometry preferences start from a known
    // baseline rather than from whatever the previous test happened to leave behind.
    localStorage.clear();
    localStorage.setItem('byteql.hexpane.collapsed', 'false');
    compactMode = false;
    viewportWidth = 1440;
    Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => viewportWidth });
    addMediaListener.mockClear();
    removeMediaListener.mockClear();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: compactMode,
        addEventListener: addMediaListener,
        removeEventListener: removeMediaListener,
      })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    measuredHeights.set('query-notices', 0);
    measuredHeights.set('workbench-main', 800);
    measuredWidths.set('workbench-main', 1216);
    measuredWidths.set('app-shell', 1440);
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
    });
    render(Workbench, { controller });

    expect(screen.getByText(/nothing is uploaded/i)).toBeTruthy();
    const input = screen.getByLabelText('Open file input');
    expect(input.getAttribute('type')).toBe('file');
    expect((screen.getByRole('button', { name: 'Try sample' }) as HTMLButtonElement).disabled).toBe(false);

    await fireEvent.click(screen.getByRole('button', { name: 'Try sample' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Network capture (pcap)' }));
    expect(controller.openSample).toHaveBeenCalledWith('pcap');
  });

  it('keeps the file action in the intake while idle and in the header once loaded', () => {
    const idleController = new FakeController({ ...initialSessionState, phase: 'idle' });
    render(Workbench, { controller: idleController });
    // Idle has exactly one Open file action, and it belongs to the intake surface.
    expect(screen.getAllByRole('button', { name: 'Open file' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /sources/iu })).toBeNull();
    expect(screen.queryByRole('button', { name: /values/iu })).toBeNull();
    cleanup();

    const readyController = new FakeController(readyState());
    render(Workbench, { controller: readyController });
    expect(screen.getByRole('button', { name: 'Open file' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide sources' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide values' })).toBeTruthy();
  });

  it('reaches the idle intake with Mod+O instead of a picker that is not mounted yet', async () => {
    const controller = new FakeController({ ...initialSessionState, phase: 'idle' });
    render(Workbench, { controller });
    const input = screen.getByLabelText<HTMLInputElement>('Open file input');
    const click = vi.spyOn(input, 'click');

    // jsdom has no File System Access API, so the intake path falls through to its own input.
    await fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    expect(click).toHaveBeenCalledOnce();
  });

  it('opens the loaded session picker with Mod+O', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    const picker = screen.getByLabelText<HTMLInputElement>('Open file picker');
    const click = vi.spyOn(picker, 'click');

    await fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    expect(click).toHaveBeenCalledOnce();
  });

  it('switches appearance from the header and keeps the choice on the root element', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    expect(document.documentElement.dataset.theme).not.toBe('dark');
    await fireEvent.click(screen.getByRole('button', { name: 'Use dark appearance' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('byteql.ui.theme.v1')).toBe('dark');

    await fireEvent.click(screen.getByRole('button', { name: 'Use light appearance' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('shows source context, pack metadata, query tools, results, and inspection landmarks', () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    const navigation = screen.getByRole('navigation', { name: 'Data explorer' });
    expect(within(navigation).getByRole('heading', { name: 'Sources' })).toBeTruthy();
    expect(within(navigation).getByText('capture.bin')).toBeTruthy();
    expect(within(navigation).getByText('Example records')).toBeTruthy();
    expect(within(navigation).getByText('records')).toBeTruthy();
    expect(within(navigation).getByText('42 rows')).toBeTruthy();
    expect(
      (within(navigation).getByRole('button', { name: 'Recent records' }) as HTMLButtonElement).disabled,
    ).toBe(false);

    const workspace = screen.getByRole('main', { name: 'Results' });
    expect(workspace).toBeTruthy();
    // One heading per tool: the duplicated eyebrow/title pairs are gone.
    expect(within(workspace).getByRole('heading', { name: 'Query' })).toBeTruthy();
    expect(within(workspace).getByRole('heading', { name: 'Results' })).toBeTruthy();
    expect(within(workspace).queryByText('Ask the capture')).toBeNull();
    expect(within(workspace).queryByText('Result set')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'SQL query' })).toBeTruthy();
    expect(within(workspace).getByText('2 rows')).toBeTruthy();
    expect(screen.getByRole('grid', { name: 'Query results' })).toBeTruthy();

    // Values and the trace strip now live inside the workspace's inspection dock, under one
    // heading each — the old eyebrow/title pairs are gone.
    expect(within(workspace).getByRole('region', { name: 'Source trace' })).toBeTruthy();
    const values = within(workspace).getByRole('complementary', { name: 'Inspector' });
    expect(within(values).getByRole('heading', { name: 'Values' })).toBeTruthy();
    expect(within(values).queryByText('Selected evidence')).toBeNull();
    expect(within(values).queryByText('Original source')).toBeNull();
  });

  it('places Download results beside the result count rather than inside the result grid', () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    const headingMeta = document.querySelector('.results-heading-meta') as HTMLElement;
    const download = within(headingMeta).getByRole('button', { name: 'Download results' });

    expect(within(headingMeta).getByText('2 rows')).toBeTruthy();
    expect(document.querySelector('.result-grid')?.contains(download)).toBe(false);
  });

  it('labels incomplete results as loaded with more available and exact results only at EOF', () => {
    const incomplete = new FakeController({
      ...readyState(),
      result: pagedResult(result, { loadedRows: 1_024, complete: false, completeTable: null }),
    });
    const incompleteView = render(Workbench, { controller: incomplete });
    const heading = document.querySelector('.results-heading') as HTMLElement;
    expect(within(heading).getByText('1,024 loaded · more available', { exact: true })).toBeTruthy();
    expect(screen.queryByText('1,024 rows', { exact: true })).toBeNull();
    incompleteView.unmount();

    const completeWindow = tableFromArrays({ value: Int32Array.from({ length: 300 }, (_, i) => i) });
    const complete = new FakeController({
      ...readyState(),
      result: pagedResult(completeWindow),
    });
    render(Workbench, { controller: complete });
    const completeHeading = document.querySelector('.results-heading') as HTMLElement;
    expect(within(completeHeading).getByText('300 rows', { exact: true })).toBeTruthy();
  });

  it('labels terminal page failures as loaded rows without claiming more are available', () => {
    const controller = new FakeController({
      ...readyState(),
      result: pagedResult(result, {
        loadedRows: 1_024,
        complete: false,
        completeTable: null,
        pageError: 'The cursor stopped. Run the query again to load more rows.',
        pageErrorRetryable: false,
      }),
    });
    render(Workbench, { controller });

    const heading = document.querySelector('.results-heading') as HTMLElement;
    expect(
      within(heading).getByText('1,024 loaded · The cursor stopped. Run the query again to load more rows.', {
        exact: true,
      }),
    ).toBeTruthy();
    expect(within(heading).queryByText(/more available/u)).toBeNull();
  });

  it('runs the bounded overview when a source first becomes ready', async () => {
    const controller = new FakeController({
      ...readyState(),
      sql: '',
      result: null,
    });
    render(Workbench, { controller });

    await vi.waitFor(() => expect(controller.runQuery).toHaveBeenCalledWith(queries[0]!.sql));
    expect(controller.runQuery).toHaveBeenCalledOnce();
  });

  it('keeps permanent landmark labels format-neutral', () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    const labels = [
      screen.getByRole('banner').textContent,
      screen.getByRole('navigation', { name: 'Data explorer' }).getAttribute('aria-label'),
      screen.getByRole('main', { name: 'Results' }).getAttribute('aria-label'),
      screen.getByRole('complementary', { name: 'Inspector' }).getAttribute('aria-label'),
      screen.getByRole('contentinfo').textContent,
    ].join(' ');

    expect(labels).not.toMatch(/\b(?:midi|note|track|play)\b/iu);
  });

  it('selects rows with the keyboard and inspects provenance without changing SQL', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    const editor = screen.getByRole('textbox', { name: 'SQL query' });
    expect(textOf(editor)).toContain('select * from records limit 100');

    const firstRow = screen.getByRole('row', { name: /row 1/i });
    firstRow.focus();
    await fireEvent.keyDown(firstRow, { key: 'ArrowDown' });

    expect(controller.selectResultRow).toHaveBeenCalledWith(1);
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    // [28, 41) shows its last included byte, 0x28 — not the exclusive end.
    expect(within(inspector).getByRole('button', { name: '0x0000001c–0x00000028 · 13 bytes' })).toBeTruthy();
    expect(within(inspector).getByText('optional')).toBeTruthy();
    expect(within(inspector).getByText('available')).toBeTruthy();
    expect(textOf(editor)).toContain('select * from records limit 100');
  });

  it('refuses to link a source range whose file is no longer in the session', async () => {
    const controller = new FakeController({
      ...readyState(),
      // The result still carries capture.bin provenance, but that file is gone.
      source: { files: [{ name: 'other.bin', size: 1536 }], totalSize: 1536 },
    });
    render(Workbench, { controller });

    const firstRow = screen.getByRole('row', { name: /row 1/i });
    firstRow.focus();
    await fireEvent.keyDown(firstRow, { key: 'ArrowDown' });

    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).queryByRole('button', { name: /0x/u })).toBeNull();
    expect(within(inspector).getByText('Source bytes are unavailable for this row.')).toBeTruthy();
  });

  it('keeps the schema headers and explains a zero-row result', () => {
    const empty = tableFromArrays({ record_id: [1n], label: ['alpha'] }).slice(0, 0);
    const controller = new FakeController({ ...readyState(), result: pagedResult(empty) });
    render(Workbench, { controller });

    // Not the intake screen: an empty result still describes its shape.
    expect(screen.getByRole('grid', { name: 'Query results' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /record_id/u })).toBeTruthy();
    expect(screen.getByText('No rows returned. Adjust the query and run again.')).toBeTruthy();
    expect(screen.queryByText(/nothing is uploaded/iu)).toBeNull();
  });

  it('marks the selected row as evidence only when its trace is validated', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    const workspace = screen.getByRole('main', { name: 'Results' });

    expect(workspace.getAttribute('data-trace-linked')).toBe('false');
    await fireEvent.click(screen.getByRole('row', { name: /^Row 1$/u }));
    expect(workspace.getAttribute('data-trace-linked')).toBe('true');

    // An aggregate has no provenance, so the bracket must not claim one.
    const aggregate = tableFromArrays({ n: [262n] });
    controller.publish({ ...controller.state, result: pagedResult(aggregate), selectedRow: 0 });
    await vi.waitFor(() => expect(workspace.getAttribute('data-trace-linked')).toBe('false'));
    expect(screen.getByText('This row has no source byte range.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Inspect source' })).toBeNull();
  });

  it('does not borrow a range for a row outside the decoded window', () => {
    const controller = new FakeController({
      ...readyState(),
      // The selection points past the loaded window, so no local row backs it.
      result: pagedResult(result, { windowStart: 0, loadedRows: 20_000, complete: false }),
      selectedRow: 16_500,
    });
    render(Workbench, { controller });

    expect(screen.getByText('Selected row is outside the loaded window.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Inspect source' })).toBeNull();
    expect(screen.getByRole('main', { name: 'Results' }).getAttribute('data-trace-linked')).toBe('false');
  });

  it('loads an example query into a focused editor without running it', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    await fireEvent.click(screen.getByRole('button', { name: 'Recent records' }));

    const editor = screen.getByRole('textbox', { name: 'SQL query' });
    expect(textOf(editor)).toContain('order by record_id desc');
    // Loading fills and focuses the editor; running stays an explicit action.
    expect(controller.runQuery).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(editor.contains(document.activeElement)).toBe(true));
  });

  it('switches which source the byte viewer shows without rerunning or rewriting SQL', async () => {
    const controller = new FakeController({
      ...readyState(),
      source: {
        files: [
          { name: 'capture.bin', size: 1536 },
          { name: 'second.bin', size: 640 },
        ],
        totalSize: 2176,
      },
    });
    render(Workbench, { controller });

    const navigation = screen.getByRole('navigation', { name: 'Data explorer' });
    const first = within(navigation).getByRole('button', { name: /capture\.bin/u });
    expect(first.getAttribute('aria-current')).toBe('true');

    await fireEvent.click(within(navigation).getByRole('button', { name: /second\.bin/u }));

    expect(
      within(navigation)
        .getByRole('button', { name: /second\.bin/u })
        .getAttribute('aria-current'),
    ).toBe('true');
    expect(controller.runQuery).not.toHaveBeenCalled();
    // Switching source drops the byte selection that belonged to the previous file.
    expect(controller.selectByteRange).toHaveBeenCalledWith(null);
  });

  it('loads a pack query, executes with the keyboard, cancels work, and tears down its editor', async () => {
    const destroy = vi.spyOn(EditorView.prototype, 'destroy');
    const controller = new FakeController(readyState());
    const view = render(Workbench, { controller });

    await fireEvent.click(screen.getByRole('button', { name: 'Recent records' }));
    const editor = screen.getByRole('textbox', { name: 'SQL query' });
    expect(editor.getAttribute('contenteditable')).toBe('true');
    expect(textOf(editor)).toContain('order by record_id desc');
    await fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', ctrlKey: true });
    expect(controller.runQuery).toHaveBeenCalledWith(queries[1]!.sql);

    controller.publish({ ...controller.state, phase: 'querying' });
    await vi.waitFor(() => expect(editor.getAttribute('contenteditable')).toBe('false'));
    await fireEvent.click(await screen.findByRole('button', { name: 'Cancel query' }));
    expect(controller.cancel).toHaveBeenCalledOnce();
    controller.publish({ ...controller.state, phase: 'ready' });
    await vi.waitFor(() => expect(editor.getAttribute('contenteditable')).toBe('true'));

    view.unmount();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('keeps every workspace pane in its own named area as diagnostics come and go', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    const areas = [
      'editor-heading',
      'query-pane',
      'query-notices',
      'query-resize-slot',
      'results-heading',
      'results-panel',
      'inspection-resize-slot',
      'trace-dock',
    ];
    const panes = (): string[] =>
      Array.from(sqlWorkspace().children).map((child) => child.classList[0] ?? '');
    expect(panes()).toEqual(areas);

    const notices = sqlWorkspace().querySelector('.query-notices');
    const dock = sqlWorkspace().querySelector('[data-trace-dock]');

    // A diagnostic grows the notices pane in place. It adds no pane and moves nothing.
    controller.publish({ ...controller.state, queryError: 'Unexpected token near FROM' });
    await vi.waitFor(() => expect(within(sqlWorkspace()).getByRole('alert')).toBeTruthy());
    expect(panes()).toEqual(areas);
    expect(sqlWorkspace().querySelector('.query-notices')).toBe(notices);
    expect(sqlWorkspace().querySelector('[data-trace-dock]')).toBe(dock);

    controller.publish({ ...controller.state, queryError: null });
    await vi.waitFor(() => expect(within(sqlWorkspace()).queryByRole('alert')).toBeNull());
    expect(panes()).toEqual(areas);
    expect(sqlWorkspace().querySelector('[data-trace-dock]')).toBe(dock);
  });

  it('solves the vertical budget from measured chrome and publishes it to the grid', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    // 800 px of workspace less 36 + 0 + 36 + 8 + 8 of chrome leaves a 712 px budget.
    expect(sqlWorkspace().style.getPropertyValue('--dock-height')).toBe('248px');

    const query = screen.getByRole('separator', { name: 'Resize query' });
    expect(query.getAttribute('aria-valuenow')).toBe('116');
    expect(query.getAttribute('aria-valuemin')).toBe('80');
    // 712 - 248 of dock - 128 of results minimum.
    expect(query.getAttribute('aria-valuemax')).toBe('336');
    expect(query.getAttribute('aria-controls')).toBe('query-pane');

    const inspection = screen.getByRole('separator', { name: 'Resize inspection' });
    expect(inspection.getAttribute('aria-valuenow')).toBe('248');
    // 40 of strip, no tab row, and a 112 px body floor.
    expect(inspection.getAttribute('aria-valuemin')).toBe('152');
    expect(inspection.getAttribute('aria-valuemax')).toBe('468');
    expect(inspection.getAttribute('aria-controls')).toBe('inspection-pane');
    expect(document.getElementById('inspection-pane')?.dataset.traceDock).toBe('');
  });

  it('measures once on mount, before any animation frame, without writing a preference', async () => {
    // No frame ever runs: whatever the workspace renders had to come from the mount-time
    // measurement, not from the observer's queued frame.
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);

    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await tick();

    // jsdom's 1024x768 viewport is wide and tall enough for the roomy defaults, so a fallback
    // that assumed a zero viewport would show the narrow 80 px editor instead.
    expect(sqlWorkspace().style.getPropertyValue('--query-height')).toBe('116px');
    expect(sqlWorkspace().style.getPropertyValue('--dock-height')).toBe('248px');
    expect(localStorage.getItem('byteql.ui.layout.v1')).toBeNull();
  });

  it('charges a wrapped notices row to the budget rather than to the panes', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    measuredHeights.set('query-notices', 48);
    window.dispatchEvent(new Event('resize'));

    const query = screen.getByRole('separator', { name: 'Resize query' });
    await vi.waitFor(() => expect(query.getAttribute('aria-valuemax')).toBe('288'));
    // The panes keep their sizes; only the space they may still claim shrank.
    expect(sqlWorkspace().style.getPropertyValue('--query-height')).toBe('116px');
    expect(sqlWorkspace().style.getPropertyValue('--dock-height')).toBe('248px');
  });

  it('keeps both dividers usable while a query is running', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    controller.publish({ ...controller.state, phase: 'querying' });
    const editor = screen.getByRole('textbox', { name: 'SQL query' });
    await vi.waitFor(() => expect(editor.getAttribute('contenteditable')).toBe('false'));

    for (const name of ['Resize query', 'Resize inspection']) {
      const separator = screen.getByRole('separator', { name });
      expect(separator.getAttribute('aria-disabled')).toBeNull();
      expect(separator.getAttribute('tabindex')).toBe('0');
    }

    await fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize query' }), {
      key: 'ArrowDown',
    });
    expect(sqlWorkspace().style.getPropertyValue('--query-height')).toBe('134px');
    expect(controller.runQuery).not.toHaveBeenCalled();
  });

  it('removes the inspection divider and its track when the dock is collapsed', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    await fireEvent.click(screen.getByRole('button', { name: 'Hide inspection' }));
    await vi.waitFor(() => expect(screen.queryByRole('separator', { name: 'Resize inspection' })).toBeNull());
    expect(document.querySelector('.inspection-resize-slot')).toBeNull();
    expect(sqlWorkspace().style.getPropertyValue('--dock-height')).toBe('auto');
    expect(sqlWorkspace().style.getPropertyValue('--inspection-gutter')).toBe('0px');
    // Query keeps its divider, and the collapsed dock keeps no height of its own.
    expect(screen.getByRole('separator', { name: 'Resize query' })).toBeTruthy();
    expect((document.querySelector('[data-trace-dock]') as HTMLElement).style.height).toBe('');
  });

  it('solves both widths from the measured shell and dock, and addresses their panes', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    const shell = document.querySelector('.app-shell') as HTMLElement;
    expect(shell.style.getPropertyValue('--sources-width')).toBe('224px');

    const sources = screen.getByRole('separator', { name: 'Resize sources' });
    expect(sources.getAttribute('aria-orientation')).toBe('vertical');
    expect(sources.getAttribute('aria-valuenow')).toBe('224');
    expect(sources.getAttribute('aria-valuemin')).toBe('192');
    // 1440 of shell less an 8 px track and the 640 px workspace floor, capped at 420.
    expect(sources.getAttribute('aria-valuemax')).toBe('420');
    expect(sources.getAttribute('aria-controls')).toBe('source-pane');
    expect(document.getElementById('source-pane')?.classList.contains('explorer-drawer')).toBe(true);

    const values = screen.getByRole('separator', { name: 'Resize values' });
    expect(values.getAttribute('aria-valuenow')).toBe('256');
    expect(values.getAttribute('aria-valuemin')).toBe('200');
    expect(values.getAttribute('aria-valuemax')).toBe('480');
    expect(values.getAttribute('aria-controls')).toBe('dock-panel-values');
    expect(document.getElementById('dock-panel-values')?.classList.contains('trace-values')).toBe(true);

    // A narrower shell republishes the limit rather than leaving a stale one on the separator.
    measuredWidths.set('app-shell', 1000);
    await remeasure();
    expect(sources.getAttribute('aria-valuemax')).toBe('352');
  });

  it('publishes a wider Sources column without disturbing the vertical budget', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    const shell = document.querySelector('.app-shell') as HTMLElement;
    const separator = screen.getByRole('separator', { name: 'Resize sources' });
    await fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true });

    expect(shell.style.getPropertyValue('--sources-width')).toBe('296px');
    expect(separator.getAttribute('aria-valuenow')).toBe('296');
    // A width is not a height: the solved vertical budget is untouched.
    expect(sqlWorkspace().style.getPropertyValue('--query-height')).toBe('116px');
    expect(sqlWorkspace().style.getPropertyValue('--dock-height')).toBe('248px');
    expect(JSON.parse(localStorage.getItem('byteql.ui.layout.v1')!)).toMatchObject({
      sourcesWidth: 296,
      queryHeight: null,
    });
  });

  it('publishes a wider Values column and charges it to Bytes alone', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    const dock = document.querySelector('[data-trace-dock]') as HTMLElement;
    const separator = screen.getByRole('separator', { name: 'Resize values' });
    await fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true });

    expect(dock.style.getPropertyValue('--values-width')).toBe('328px');
    expect(separator.getAttribute('aria-valuenow')).toBe('328');
    expect(sqlWorkspace().style.getPropertyValue('--dock-height')).toBe('248px');
    expect(JSON.parse(localStorage.getItem('byteql.ui.layout.v1')!)).toMatchObject({
      valuesWidth: 328,
      dockHeight: null,
    });
  });

  it('both width separators stop at the limits they publish', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    for (const name of ['Resize sources', 'Resize values']) {
      const separator = screen.getByRole('separator', { name });
      const min = separator.getAttribute('aria-valuemin');
      const max = separator.getAttribute('aria-valuemax');

      await fireEvent.keyDown(separator, { key: 'End' });
      expect(separator.getAttribute('aria-valuenow'), name).toBe(max);
      await fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true });
      expect(separator.getAttribute('aria-valuenow'), name).toBe(max);

      await fireEvent.keyDown(separator, { key: 'Home' });
      expect(separator.getAttribute('aria-valuenow'), name).toBe(min);
      await fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true });
      expect(separator.getAttribute('aria-valuenow'), name).toBe(min);
    }
  });

  it('takes the sources divider away with the collapsed column and restores its width', async () => {
    const user = userEvent.setup();
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    await fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize sources' }), {
      key: 'ArrowRight',
      shiftKey: true,
    });
    const shell = document.querySelector('.app-shell') as HTMLElement;
    expect(shell.style.getPropertyValue('--sources-width')).toBe('296px');

    await user.click(screen.getByRole('button', { name: 'Hide sources' }));
    // Absent from the DOM, not merely invisible: a hidden separator must not stay tabbable.
    expect(screen.queryByRole('separator', { name: 'Resize sources' })).toBeNull();
    expect(document.querySelector('.source-resize-slot')).toBeNull();
    expect(shell.classList.contains('sources-resizable')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Show sources' }));
    expect(screen.getByRole('separator', { name: 'Resize sources' }).getAttribute('aria-valuenow')).toBe(
      '296',
    );
    expect(shell.style.getPropertyValue('--sources-width')).toBe('296px');
  });

  it('hiding Values takes its divider away, and showing them restores its width', async () => {
    const user = userEvent.setup();
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    await fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize values' }), {
      key: 'ArrowRight',
      shiftKey: true,
    });

    await user.click(screen.getByRole('button', { name: 'Hide values' }));
    expect(screen.queryByRole('separator', { name: 'Resize values' })).toBeNull();
    expect(document.querySelector('.values-resize-slot')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show values' }));
    expect(screen.getByRole('separator', { name: 'Resize values' }).getAttribute('aria-valuenow')).toBe(
      '328',
    );
  });

  it('tabs the dock from the measured dock width, not from a viewport media query', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();
    expect(screen.queryByRole('tablist', { name: 'Inspection views' })).toBeNull();

    // Inside the 900-923 band the previous mode wins, so columns stay columns.
    measuredWidths.set('workbench-main', 910);
    await remeasure();
    expect(screen.queryByRole('tablist', { name: 'Inspection views' })).toBeNull();

    // A wide viewport with a dock too narrow for two columns: only a measurement can see this.
    measuredWidths.set('workbench-main', 880);
    await remeasure();
    expect(screen.getByRole('tablist', { name: 'Inspection views' })).toBeTruthy();
    expect(screen.queryByRole('separator', { name: 'Resize values' })).toBeNull();

    // The same banded width now keeps the tabs, because tabs are what came before it.
    measuredWidths.set('workbench-main', 910);
    await remeasure();
    expect(screen.getByRole('tablist', { name: 'Inspection views' })).toBeTruthy();

    measuredWidths.set('workbench-main', 924);
    await remeasure();
    expect(screen.queryByRole('tablist', { name: 'Inspection views' })).toBeNull();
    expect(screen.getByRole('separator', { name: 'Resize values' })).toBeTruthy();
  });

  it('keeps focus in the panel it was in when the dock becomes tabbed', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();
    controller.selectResultRow(0);
    await vi.waitFor(() => expect(document.querySelector('.provenance-link')).toBeTruthy());

    const link = document.querySelector('.provenance-link') as HTMLElement;
    link.focus();

    measuredWidths.set('workbench-main', 880);
    await remeasure();

    // The panel that held focus is the one the tabs open on, so the user keeps their place.
    expect(screen.getByRole('tab', { name: 'Values' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(link);
    expect(document.getElementById('dock-panel-values')?.hidden).toBe(false);
  });

  it('opens the tabs on Bytes when the user has put Values away', async () => {
    const user = userEvent.setup();
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    // Leave the compact tab on Values, then widen and hide Values from the header.
    measuredWidths.set('workbench-main', 880);
    await remeasure();
    await user.click(screen.getByRole('tab', { name: 'Values' }));
    measuredWidths.set('workbench-main', 1216);
    await remeasure();
    await user.click(screen.getByRole('button', { name: 'Hide values' }));
    expect(document.getElementById('dock-panel-values')?.hidden).toBe(true);

    measuredWidths.set('workbench-main', 880);
    await remeasure();

    // A narrower dock must not hand back what the user put away.
    expect(screen.getByRole('tab', { name: 'Bytes' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Values' }).getAttribute('aria-selected')).toBe('false');
    expect(document.getElementById('dock-panel-values')?.hidden).toBe(true);
  });

  it('keeps Values, and the focus inside them, when tabs opened them and the dock widens', async () => {
    const user = userEvent.setup();
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    // Hide Values on the wide layout, narrow, then ask for them again in tab mode.
    await user.click(screen.getByRole('button', { name: 'Hide values' }));
    measuredWidths.set('workbench-main', 880);
    await remeasure();
    await user.keyboard('{Control>}i{/Control}');
    expect(screen.getByRole('tab', { name: 'Values' }).getAttribute('aria-selected')).toBe('true');

    controller.selectResultRow(0);
    await vi.waitFor(() => expect(document.querySelector('.provenance-link')).toBeTruthy());
    const link = document.querySelector('.provenance-link') as HTMLElement;
    link.focus();

    measuredWidths.set('workbench-main', 1216);
    await remeasure();

    // Opening Values in tabs is the same request as showing them beside Bytes, so widening keeps
    // them on screen — and keeps the focus that was inside rather than dropping it on the body.
    expect(document.getElementById('dock-panel-values')?.hidden).toBe(false);
    expect(document.activeElement).toBe(link);
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole('separator', { name: 'Resize values' })).toBeTruthy();
  });

  it('moves focus off a separator the mode switch removes, and never merely for a width', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    const separator = screen.getByRole('separator', { name: 'Resize values' });
    separator.focus();

    // A width change alone leaves focus exactly where it was.
    await fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(separator);

    measuredWidths.set('workbench-main', 880);
    await remeasure();
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Bytes' })));
  });

  it('resets every panel size from the shortcuts dialog without touching the session', async () => {
    const user = userEvent.setup();
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    controller.selectResultRow(1);
    await fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize sources' }), {
      key: 'ArrowRight',
      shiftKey: true,
    });
    await fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize values' }), {
      key: 'ArrowRight',
      shiftKey: true,
    });
    await fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize query' }), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    await user.click(screen.getByRole('button', { name: 'Use dark appearance' }));
    controller.runQuery.mockClear();

    await user.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await user.click(within(dialog).getByRole('button', { name: 'Reset panel sizes' }));

    // The dialog stays open; only the sizes moved.
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
    const shell = document.querySelector('.app-shell') as HTMLElement;
    expect(shell.style.getPropertyValue('--sources-width')).toBe('224px');
    expect(sqlWorkspace().style.getPropertyValue('--query-height')).toBe('116px');
    expect(
      (document.querySelector('[data-trace-dock]') as HTMLElement).style.getPropertyValue('--values-width'),
    ).toBe('256px');
    expect(JSON.parse(localStorage.getItem('byteql.ui.layout.v1')!)).toEqual({
      version: 1,
      sourcesWidth: null,
      queryHeight: null,
      dockHeight: null,
      valuesWidth: null,
    });

    // Theme, dock collapse, tab and selection are not geometry and are left alone.
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.querySelector('[data-trace-dock]')?.getAttribute('data-dock-collapsed')).toBe('false');
    expect(controller.state.selectedRow).toBe(1);
    expect(controller.runQuery).not.toHaveBeenCalled();
  });

  it('offers no panel reset while the workspace is idle', async () => {
    const user = userEvent.setup();
    const controller = new FakeController({ ...readyState(), phase: 'idle', source: null, result: null });
    render(Workbench, { controller });

    await user.keyboard('?');
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).queryByRole('button', { name: 'Reset panel sizes' })).toBeNull();
  });

  it('still moves every divider when storage refuses to answer', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage blocked');
      },
      setItem: () => {
        throw new Error('storage blocked');
      },
      removeItem: () => {
        throw new Error('storage blocked');
      },
    });
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    await fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize sources' }), {
      key: 'ArrowRight',
      shiftKey: true,
    });
    await fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize values' }), {
      key: 'ArrowRight',
      shiftKey: true,
    });
    await fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize query' }), {
      key: 'ArrowDown',
    });

    const shell = document.querySelector('.app-shell') as HTMLElement;
    expect(shell.style.getPropertyValue('--sources-width')).toBe('296px');
    expect(
      (document.querySelector('[data-trace-dock]') as HTMLElement).style.getPropertyValue('--values-width'),
    ).toBe('328px');
    expect(sqlWorkspace().style.getPropertyValue('--query-height')).toBe('134px');
  });

  it('resizing runs no session work and leaves the editor document and history intact', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    const host = document.querySelector('.sql-editor') as HTMLElement;
    const view = EditorView.findFromDOM(host)!;
    const original = view.state.doc.toString();
    view.dispatch({ changes: { from: 0, to: original.length, insert: 'select 7' } });
    controller.runQuery.mockClear();
    controller.selectResultRow.mockClear();

    const separator = screen.getByRole('separator', { name: 'Resize query' });
    await fireEvent.keyDown(separator, { key: 'ArrowDown' });
    await fireEvent.keyDown(separator, { key: 'ArrowUp' });

    expect(controller.runQuery).not.toHaveBeenCalled();
    expect(controller.openFile).not.toHaveBeenCalled();
    expect(controller.openFiles).not.toHaveBeenCalled();
    expect(controller.selectResultRow).not.toHaveBeenCalled();

    // The same host, the same EditorView, the same document.
    expect(document.querySelector('.sql-editor')).toBe(host);
    expect(EditorView.findFromDOM(host)).toBe(view);
    expect(view.state.doc.toString()).toBe('select 7');

    // And the edit made before the resize is still undoable.
    await fireEvent.keyDown(view.contentDOM, { key: 'z', ctrlKey: true });
    expect(view.state.doc.toString()).toBe(original);
  });

  it('completes a drag that spans a result generation replacement', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });
    await settleLayout();

    const separator = screen.getByRole('separator', { name: 'Resize query' });
    Object.assign(separator, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    });

    pointer(separator, 'pointerdown', 400);
    controller.publish({
      ...controller.state,
      result: pagedResult(result, { generation: 2 }),
    });
    await vi.waitFor(() => expect(screen.getByRole('grid', { name: 'Query results' })).toBeTruthy());
    pointer(separator, 'pointerup', 460);

    // Dragging down 60 px grows Query by 60 and takes it from Results alone.
    await vi.waitFor(() => expect(sqlWorkspace().style.getPropertyValue('--query-height')).toBe('176px'));
    expect(sqlWorkspace().style.getPropertyValue('--dock-height')).toBe('248px');
    expect(controller.runQuery).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('byteql.ui.layout.v1')!)).toMatchObject({
      queryHeight: 176,
      dockHeight: 248,
    });
  });

  it('keeps the whole workbench visible instead of tabbing Results against Values', () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    // The old whole-workbench Results/Inspector tabs are gone; the dock tabs its own panels.
    expect(screen.queryByRole('tablist', { name: 'Workbench views' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Results' })).toBeNull();
    expect(screen.getByRole('grid', { name: 'Query results' })).toBeTruthy();
    expect(document.querySelector('[data-trace-dock]')).toBeTruthy();
    // Wide layout shows Values beside Bytes, both without tabs.
    expect(screen.queryByRole('tablist', { name: 'Inspection views' })).toBeNull();
    expect(document.querySelector('[data-hex-pane]')?.getAttribute('data-hex-layout')).toBe('embedded');
  });

  it('retains successful results and places a failed-query diagnostic beside the editor', () => {
    const controller = new FakeController({ ...readyState(), queryError: 'Unexpected token near FROM' });
    render(Workbench, { controller });

    const workspace = screen.getByRole('main', { name: 'Results' });
    expect(textOf(within(workspace).getByRole('alert'))).toContain('Unexpected token near FROM');
    expect(within(workspace).getByRole('grid', { name: 'Query results' })).toBeTruthy();
    expect(within(workspace).getByText('2 rows')).toBeTruthy();
  });

  it('renders every query supplied by the active format pack', () => {
    const controller = new FakeController({ ...readyState(), queries: midiQueries });
    render(Workbench, { controller });

    // "Example queries": these come from the format pack, not from a save/history feature.
    const exampleQueries = screen.getByRole('region', { name: 'Example queries' });
    expect(screen.queryByRole('region', { name: 'Saved queries' })).toBeNull();
    expect(
      within(exampleQueries)
        .getAllByRole('button')
        .map((button) => button.textContent?.trim()),
    ).toEqual(midiQueries.map((query) => query.title));
  });

  it('selects the pack play_all query through the saved-query path', async () => {
    const controller = new FakeController({ ...readyState(), queries: midiQueries });
    render(Workbench, { controller });

    await fireEvent.click(screen.getByRole('button', { name: 'Play all notes' }));
    expect(textOf(screen.getByRole('textbox', { name: 'SQL query' }))).toContain('as seconds');
    await fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    expect(controller.runQuery).toHaveBeenCalledWith(midiQueries.find(({ id }) => id === 'play_all')!.sql);
  });

  it('offers the trusted audio viewer only for compatible enabled results', async () => {
    const enabled = new FakeController({ ...readyState(), result: pagedResult(audioResult) });
    const enabledView = render(Workbench, { controller: enabled });
    expect(screen.queryByRole('status', { name: 'Format capability notice' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Open in…' }));
    expect(screen.getByRole('menuitem', { name: 'Audio playback' })).toBeTruthy();
    enabledView.unmount();

    const aggregate = new FakeController(readyState());
    const aggregateView = render(Workbench, { controller: aggregate });
    expect(screen.queryByRole('button', { name: 'Open in…' })).toBeNull();
    expect(screen.queryByRole('status', { name: 'Format capability notice' })).toBeNull();
    aggregateView.unmount();

    const reason = 'SMPTE time division is not supported by the Phase 0 player.';
    const smpte = new FakeController({
      ...readyState(),
      result: pagedResult(audioResult),
      capabilities: {
        audio: { enabled: false, reason },
      },
    });
    render(Workbench, { controller: smpte });
    expect(screen.queryByRole('button', { name: 'Open in…' })).toBeNull();
    expect(textOf(screen.getByRole('status', { name: 'Format capability notice' }))).toBe(reason);
  });

  it('refuses viewers for incomplete and oversized results instead of truncating', () => {
    const incomplete = new FakeController({
      ...readyState(),
      result: pagedResult(audioResult, { complete: false, completeTable: null }),
    });
    const incompleteView = render(Workbench, { controller: incomplete });
    expect(screen.queryByRole('button', { name: 'Open in…' })).toBeNull();
    incompleteView.unmount();

    const oversized = new FakeController({
      ...readyState(),
      result: pagedResult(audioResult, { complete: true, completeTable: null }),
    });
    render(Workbench, { controller: oversized });
    expect(screen.queryByRole('button', { name: 'Open in…' })).toBeNull();
  });

  it('shows the notice for any disabled pack capability, not only audio', () => {
    const reason = 'Hex preview is unavailable for this source.';
    const controller = new FakeController({
      ...readyState(),
      result: pagedResult(audioResult),
      capabilities: {
        audio: { enabled: true, reason: null },
        hex: { enabled: false, reason },
      },
    });
    render(Workbench, { controller });
    expect(textOf(screen.getByRole('status', { name: 'Format capability notice' }))).toBe(reason);
  });

  it('keeps an unsupported Type 2 failure on the fatal-error path without an audio notice', () => {
    const reason = 'MIDI Type 2 files are not supported.';
    const controller = new FakeController({ ...initialSessionState, phase: 'failed', fatalError: reason });
    render(Workbench, { controller });

    expect(textOf(screen.getByRole('alert'))).toBe(reason);
    expect(screen.queryByRole('status', { name: 'Format capability notice' })).toBeNull();
  });

  it('disposes the contextual viewer on close, result replacement, and session replacement', async () => {
    const engines = [fakeAudioEngine(), fakeAudioEngine(), fakeAudioEngine()];
    const engineFactory = vi.fn(() => engines.shift()!);
    const controller = new FakeController({ ...readyState(), result: pagedResult(audioResult) });
    render(Workbench, { controller, audioEngineFactory: engineFactory });

    async function openAudio(): Promise<AudioEngine> {
      await fireEvent.click(screen.getByRole('button', { name: 'Open in…' }));
      await fireEvent.click(screen.getByRole('menuitem', { name: 'Audio playback' }));
      expect(await screen.findByRole('heading', { name: 'Audio playback' })).toBeTruthy();
      return engineFactory.mock.results.at(-1)!.value;
    }

    const closed = await openAudio();
    await fireEvent.click(screen.getByRole('button', { name: 'Close audio viewer' }));
    expect(closed.dispose).toHaveBeenCalledOnce();

    const replaced = await openAudio();
    controller.publish({
      ...controller.state,
      result: pagedResult(tableFromArrays({ value: [1] }), { generation: 2 }),
    });
    await vi.waitFor(() => expect(replaced.dispose).toHaveBeenCalledOnce());

    controller.publish({ ...controller.state, result: pagedResult(audioResult, { generation: 3 }) });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Open in…' })).toBeTruthy());
    const sessionReplaced = await openAudio();
    controller.publish({
      ...initialSessionState,
      phase: 'opening',
      source: { files: [{ name: 'next.mid', size: 8 }], totalSize: 8 },
    });
    await vi.waitFor(() => expect(sessionReplaced.dispose).toHaveBeenCalledOnce());
  });

  it('closes and disposes the active viewer through the exported closeActiveViewer method', async () => {
    const engine = fakeAudioEngine();
    const controller = new FakeController({ ...readyState(), result: pagedResult(audioResult) });
    const view = render(Workbench, { controller, audioEngineFactory: () => engine });

    await fireEvent.click(screen.getByRole('button', { name: 'Open in…' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Audio playback' }));
    expect(await screen.findByRole('heading', { name: 'Audio playback' })).toBeTruthy();

    view.component.closeActiveViewer();
    await vi.waitFor(() => expect(screen.queryByRole('heading', { name: 'Audio playback' })).toBeNull());
    expect(engine.dispose).toHaveBeenCalledOnce();
  });

  it('uses desktop landmarks without hidden tab widgets and removes its media listener', () => {
    const controller = new FakeController(readyState());
    const view = render(Workbench, { controller });

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryAllByRole('tabpanel')).toEqual([]);
    expect(screen.getByRole('main', { name: 'Results' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeTruthy();
    expect(addMediaListener).toHaveBeenCalledWith('change', expect.any(Function));

    const listener = addMediaListener.mock.calls[0]![1];
    view.unmount();
    expect(removeMediaListener).toHaveBeenCalledWith('change', listener);
  });

  it('tabs Values against Bytes inside the dock on a compact layout', async () => {
    compactMode = true;
    viewportWidth = 1024;
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    const valuesTab = screen.getByRole('tab', { name: 'Values' });
    const bytesTab = screen.getByRole('tab', { name: 'Bytes' });
    const valuesPanel = document.getElementById(valuesTab.getAttribute('aria-controls')!)!;
    const bytesPanel = document.getElementById(bytesTab.getAttribute('aria-controls')!)!;

    // Results stay on screen: only the dock's two panels take turns.
    expect(screen.getByRole('grid', { name: 'Query results' })).toBeTruthy();
    expect(bytesTab.getAttribute('aria-selected')).toBe('true');
    expect(bytesPanel.hidden).toBe(false);
    expect(valuesPanel.hidden).toBe(true);

    await fireEvent.keyDown(bytesTab, { key: 'ArrowLeft' });
    expect(valuesTab.getAttribute('aria-selected')).toBe('true');
    expect(valuesPanel.hidden).toBe(false);
    expect(bytesPanel.hidden).toBe(true);
    expect(document.activeElement).toBe(valuesTab);

    // Both components stay mounted so switching tabs never resets their state.
    expect(valuesPanel.querySelector('.inspector')).toBeTruthy();
    expect(bytesPanel.querySelector('[data-hex-pane]')).toBeTruthy();
  });

  it('reveals the covering result row when the hex pane reports a byte click', async () => {
    const user = userEvent.setup();
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    const pane = document.querySelector('[data-hex-pane]') as HTMLElement;
    expect(pane).toBeTruthy();
    // 30 sits inside row 1's provenance range [28, 41); row 0 covers [12, 20).
    await user.type(within(pane).getByLabelText('Go to offset'), '30{Enter}');
    expect(pane.getAttribute('data-hex-caret')).toBe('30');

    within(pane).getByRole('application', { name: 'Hex viewer' }).focus();
    await user.keyboard('{Enter}');

    expect(controller.selectResultRow).toHaveBeenCalledWith(1);
  });

  it('runs the wrapped filter query from the hex pane filter action', async () => {
    const user = userEvent.setup();
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    const pane = document.querySelector('[data-hex-pane]') as HTMLElement;
    await user.type(within(pane).getByLabelText('Go to offset'), '30{Enter}');
    within(pane).getByRole('application', { name: 'Hex viewer' }).focus();
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await user.click(within(pane).getByRole('button', { name: 'Filter results to selection' }));

    expect(controller.runQuery).toHaveBeenCalled();
    const query = controller.runQuery.mock.calls.at(-1)![0];
    expect(query).toContain('select * from (');
    expect(query).toContain("where _src_file = 'capture.bin' and _src_start < ");
  });

  it('passes the selected row provenance to the hex pane as highlight', async () => {
    const controller = new FakeController({
      ...readyState(),
      result: pagedResult(
        tableFromArrays({
          record_id: [1n, 2n],
          _src_file: ['capture.bin', 'capture.bin'],
          _src_start: [12n, 800n],
          _src_end: [20n, 840n],
        }),
      ),
    });
    render(Workbench, { controller });

    await fireEvent.click(screen.getByRole('row', { name: /row 2/i }));
    expect(controller.selectResultRow).toHaveBeenCalledWith(1);

    const rowOfStart = Math.floor(800 / 16);
    await vi.waitFor(() => {
      const pane = document.querySelector('[data-hex-pane]') as HTMLElement;
      const firstRow = Number(pane.getAttribute('data-hex-first-row'));
      expect(firstRow).toBeGreaterThanOrEqual(rowOfStart - 8);
      expect(firstRow).toBeLessThanOrEqual(rowOfStart);
    });
  });

  it('browses a quoted table name without a hidden row limit', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    const navigation = screen.getByRole('navigation', { name: 'Data explorer' });
    await fireEvent.click(within(navigation).getByRole('button', { name: 'Browse records' }));

    expect(controller.runQuery).toHaveBeenCalledWith('select * from "records"');
  });

  it('maps global selection to the local inspector row while preserving the global label', () => {
    const controller = new FakeController({
      ...readyState(),
      result: pagedResult(result, { loadedRows: 40_000, windowStart: 20_000 }),
      selectedRow: 20_001,
    });
    render(Workbench, { controller });

    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).getByText('Row 20002')).toBeTruthy();
    expect(within(inspector).getByText('available')).toBeTruthy();
  });

  it('adds the window start when selecting a coverage row from the hex pane', async () => {
    const user = userEvent.setup();
    const controller = new FakeController({
      ...readyState(),
      result: pagedResult(result, { loadedRows: 40_000, windowStart: 20_000 }),
    });
    render(Workbench, { controller });
    const pane = document.querySelector('[data-hex-pane]') as HTMLElement;

    await user.type(within(pane).getByLabelText('Go to offset'), '30{Enter}');
    within(pane).getByRole('application', { name: 'Hex viewer' }).focus();
    await user.keyboard('{Enter}');

    expect(controller.selectResultRow).toHaveBeenCalledWith(20_001);
  });

  it('describes an uncovered byte against only the loaded window while incomplete', async () => {
    const user = userEvent.setup();
    const controller = new FakeController({
      ...readyState(),
      result: pagedResult(result, { loadedRows: 1_024, complete: false, completeTable: null }),
    });
    render(Workbench, { controller });
    const pane = document.querySelector('[data-hex-pane]') as HTMLElement;

    await user.type(within(pane).getByLabelText('Go to offset'), '50{Enter}');
    within(pane).getByRole('application', { name: 'Hex viewer' }).focus();
    await user.keyboard('{Enter}');

    expect(screen.getByText('No loaded result row covers this byte')).toBeTruthy();
  });

  it('opens a dropped file through the window-level drop overlay', async () => {
    const controller = new FakeController(readyState());
    const { container } = render(Workbench, { controller });
    const appShell = container.querySelector('.app-shell') as HTMLElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'dropped.bin');

    await fireEvent.dragEnter(appShell, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByText('Drop to open')).toBeTruthy();

    await fireEvent.drop(appShell, { dataTransfer: { files: [file] } });
    expect(controller.openFiles).toHaveBeenCalledWith([file]);
    expect(screen.queryByText('Drop to open')).toBeNull();
  });

  it('dropping multiple files opens them as one batch', async () => {
    const controller = new FakeController(readyState());
    const { container } = render(Workbench, { controller });
    const appShell = container.querySelector('.app-shell') as HTMLElement;
    const fileA = new File([new Uint8Array([1, 2, 3])], 'a.pcap');
    const fileB = new File([new Uint8Array([4, 5, 6])], 'b.pcap');

    await fireEvent.dragEnter(appShell, { dataTransfer: { types: ['Files'] } });
    await fireEvent.drop(appShell, { dataTransfer: { files: [fileA, fileB] } });
    expect(controller.openFiles).toHaveBeenCalledWith([fileA, fileB]);
  });

  it("selecting a row auto-switches the hex pane to that row's source file", async () => {
    const controller = new FakeController({
      ...readyState(),
      source: {
        files: [
          { name: 'a.pcap', size: 8 },
          { name: 'b.pcap', size: 8 },
        ],
        totalSize: 16,
      },
      result: pagedResult(
        tableFromArrays({
          record_id: [1n, 2n],
          _src_file: ['b.pcap', 'a.pcap'],
          _src_start: [4n, 4n],
          _src_end: [6n, 6n],
        }),
      ),
    });
    render(Workbench, { controller });

    await fireEvent.click(screen.getByRole('row', { name: /row 1/i }));
    expect(controller.selectResultRow).toHaveBeenCalledWith(0);

    const pane = document.querySelector('[data-hex-pane]') as HTMLElement;
    await vi.waitFor(() => {
      const select = within(pane).getByLabelText('Hex file') as HTMLSelectElement;
      expect(select.value).toBe('b.pcap');
    });
  });

  it('manually switching the hex file clears the byte selection', async () => {
    const controller = new FakeController({
      ...readyState(),
      source: {
        files: [
          { name: 'a.pcap', size: 8 },
          { name: 'b.pcap', size: 8 },
        ],
        totalSize: 16,
      },
      byteSelection: { file: 'a.pcap', start: 0, end: 2 },
    });
    render(Workbench, { controller });

    const pane = document.querySelector('[data-hex-pane]') as HTMLElement;
    const select = within(pane).getByLabelText('Hex file') as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'b.pcap' } });

    expect(controller.selectByteRange).toHaveBeenCalledWith(null);
  });

  it('does not snap a manual hex-file switch back to the still-selected row provenance file', async () => {
    const controller = new FakeController({
      ...readyState(),
      source: {
        files: [
          { name: 'a.pcap', size: 8 },
          { name: 'b.pcap', size: 8 },
        ],
        totalSize: 16,
      },
      result: pagedResult(
        tableFromArrays({
          record_id: [1n, 2n],
          _src_file: ['a.pcap', 'b.pcap'],
          _src_start: [4n, 4n],
          _src_end: [6n, 6n],
        }),
      ),
    });
    render(Workbench, { controller });

    // Select the row provenanced to a.pcap: the auto-switch effect follows it.
    await fireEvent.click(screen.getByRole('row', { name: /row 1/i }));
    expect(controller.selectResultRow).toHaveBeenCalledWith(0);

    const pane = document.querySelector('[data-hex-pane]') as HTMLElement;
    const select = within(pane).getByLabelText('Hex file') as HTMLSelectElement;
    await vi.waitFor(() => expect(select.value).toBe('a.pcap'));

    // Manually switch to b.pcap while the selected row's provenance is still a.pcap.
    await fireEvent.change(select, { target: { value: 'b.pcap' } });
    expect(controller.selectByteRange).toHaveBeenCalledWith(null);

    // The auto-switch effect must not read hexFile as a dependency and re-fire, snapping
    // the switcher back to a.pcap because rowHighlight.file is still 'a.pcap'.
    await vi.waitFor(() => expect(select.value).toBe('b.pcap'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(select.value).toBe('b.pcap');
  });

  it('opens the shortcuts overlay with ? and toggles panes with Mod+B / Mod+I', async () => {
    const user = userEvent.setup();
    const controller = new FakeController(readyState());
    const { container } = render(Workbench, { controller });
    const appShell = container.querySelector('.app-shell') as HTMLElement;

    await user.keyboard('?');
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();

    expect(appShell.classList.contains('explorer-collapsed')).toBe(false);
    await user.keyboard('{Control>}b{/Control}');
    expect(appShell.classList.contains('explorer-collapsed')).toBe(true);

    // Wide layout: Mod+I shows and hides Values beside Bytes.
    const dockBody = document.querySelector('.trace-dock-body')!;
    const valuesPanel = dockBody.querySelector('.trace-values') as HTMLElement;
    expect(valuesPanel.hidden).toBe(false);
    await user.keyboard('{Control>}i{/Control}');
    expect(valuesPanel.hidden).toBe(true);
    await user.keyboard('{Control>}i{/Control}');
    expect(valuesPanel.hidden).toBe(false);
  });

  it('opens the dock on Bytes and focuses goto with Mod+G', async () => {
    const user = userEvent.setup();
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    // Collapse the dock first, so the shortcut has to reopen it.
    await user.click(screen.getByRole('button', { name: 'Hide inspection' }));
    expect(document.querySelector('[data-trace-dock]')?.getAttribute('data-dock-collapsed')).toBe('true');

    await user.keyboard('{Control>}g{/Control}');
    expect(document.querySelector('[data-trace-dock]')?.getAttribute('data-dock-collapsed')).toBe('false');
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Go to offset')));
  });

  it('marks the workbench file picker input multi-select and forwards every picked file', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    const input = screen.getByLabelText<HTMLInputElement>('Open file picker');
    expect(input.multiple).toBe(true);

    const fileA = new File([new Uint8Array([1])], 'a.pcap');
    const fileB = new File([new Uint8Array([2])], 'b.pcap');
    await fireEvent.change(input, { target: { files: [fileA, fileB] } });
    expect(controller.openFiles).toHaveBeenCalledWith([fileA, fileB]);
  });

  it('opens the file picker with Mod+O and focuses the hex goto input with Mod+G', async () => {
    const user = userEvent.setup();
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    const input = screen.getByLabelText('Open file picker') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    await user.keyboard('{Control>}o{/Control}');
    expect(click).toHaveBeenCalledOnce();

    await user.keyboard('{Control>}g{/Control}');
    const pane = document.querySelector('[data-hex-pane]') as HTMLElement;
    expect(document.activeElement).toBe(within(pane).getByLabelText('Go to offset'));
  });

  it('ignores Mod+O when no session can receive the file picker', async () => {
    const user = userEvent.setup();
    const controller = new FakeController({ ...initialSessionState, phase: 'idle' });
    render(Workbench, { controller });

    await expect(user.keyboard('{Control>}o{/Control}')).resolves.not.toThrow();
    expect(screen.queryByLabelText('Open file picker')).toBeNull();
  });

  it('hides underscore columns behind the +N hidden chip', async () => {
    const table = tableFromArrays({
      note: [60, 61],
      _src_start: [12n, 28n],
      _src_end: [20n, 41n],
    });
    render(ResultGrid, gridProps(table));

    expect(screen.getByRole('columnheader', { name: /note/ })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: /_src_start/ })).toBeNull();

    const chip = screen.getByRole('button', { name: 'Toggle hidden columns' });
    expect(chip.textContent).toContain('+2 hidden');
    expect(chip.getAttribute('aria-pressed')).toBe('false');

    // aria-colcount reports the TOTAL field count so aria-colindex stays consistent with
    // original positions even while the two _src columns are hidden.
    expect(screen.getByRole('grid').getAttribute('aria-colcount')).toBe('3');

    await fireEvent.click(chip);
    expect(screen.getByRole('columnheader', { name: /_src_start/ })).toBeTruthy();
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('grid').getAttribute('aria-colcount')).toBe('3');
  });

  it('renders and selects rows by global index after a window rebase', async () => {
    const onselect = vi.fn();
    render(ResultGrid, gridProps(result, { windowStart: 20_000, loadedRows: 40_000, onselect }));

    await fireEvent.click(screen.getByRole('row', { name: 'Row 20001' }));

    expect(onselect).toHaveBeenCalledWith(20_000);
  });

  it('compensates the real scroll position in both rebase directions', async () => {
    const table = tableFromArrays({ value: Int32Array.from({ length: 100 }, (_, i) => i) });
    const props = gridProps(table, { loadedRows: 110 });
    const view = render(ResultGrid, props);
    const scroll = view.container.querySelector('.grid-scroll') as HTMLElement;
    scroll.scrollTop = 720;

    await view.rerender({ ...props, windowStart: 10 });
    expect(scroll.scrollTop).toBe(360);

    await view.rerender({ ...props, windowStart: 0 });
    expect(scroll.scrollTop).toBe(720);
  });

  it('requests forward demand once when scrolling into the loaded tail', async () => {
    const table = tableFromArrays({ value: Int32Array.from({ length: 100 }, (_, i) => i) });
    const onloadmore = vi.fn();
    const { container } = render(
      ResultGrid,
      gridProps(table, { complete: false, loadedRows: 100, onloadmore }),
    );
    const scroll = container.querySelector('.grid-scroll') as HTMLElement;
    scroll.scrollTop = 92 * 36;

    await fireEvent.scroll(scroll);
    await fireEvent.scroll(scroll);

    await vi.waitFor(() => expect(onloadmore).toHaveBeenCalledOnce());
  });

  it('does not dispatch a queued demand after the result grid is replaced', async () => {
    const queued = new Map<number, FrameRequestCallback>();
    let nextHandle = 0;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      const handle = ++nextHandle;
      queued.set(handle, callback);
      return handle;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((handle) => {
      queued.delete(handle);
    });

    const oldLoadMore = vi.fn();
    const first = render(
      ResultGrid,
      gridProps(tableFromArrays({ value: Int32Array.from({ length: 100 }, (_, i) => i) }), {
        complete: false,
        loadedRows: 100,
        onloadmore: oldLoadMore,
      }),
    );
    for (const initialCallback of queued.values()) initialCallback(0);
    queued.clear();
    const scroll = first.container.querySelector('.grid-scroll') as HTMLElement;
    scroll.scrollTop = 92 * 36;
    await fireEvent.scroll(scroll);
    expect(queued.size).toBeGreaterThan(0);

    first.unmount();
    for (const staleCallback of queued.values()) staleCallback(0);

    expect(oldLoadMore).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('requests the prior global row when an evicted window reaches its head', async () => {
    const table = tableFromArrays({ value: Int32Array.from({ length: 100 }, (_, i) => i) });
    const onloadwindow = vi.fn();
    render(
      ResultGrid,
      gridProps(table, { windowStart: 20_000, loadedRows: 40_000, complete: false, onloadwindow }),
    );

    await vi.waitFor(() => expect(onloadwindow).toHaveBeenCalledExactlyOnceWith(19_999));
  });

  it('offers page retry only for a retryable loading failure', async () => {
    const onretry = vi.fn();
    const retryable = render(
      ResultGrid,
      gridProps(result, {
        complete: false,
        loadedRows: 1_024,
        pageError: 'Local result storage is full.',
        pageErrorRetryable: true,
        onretry,
      }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Retry loading rows' }));
    expect(onretry).toHaveBeenCalledOnce();
    retryable.unmount();

    render(
      ResultGrid,
      gridProps(result, {
        complete: false,
        loadedRows: 1_024,
        pageError: 'The cursor stopped.',
        pageErrorRetryable: false,
      }),
    );
    expect(screen.queryByRole('button', { name: 'Retry loading rows' })).toBeNull();
    expect(screen.getByText('The cursor stopped.')).toBeTruthy();
  });
});
