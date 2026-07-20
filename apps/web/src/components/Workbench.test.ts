// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tableFromArrays } from 'apache-arrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from 'codemirror';
import { midiQueries } from '@byteql/midi';

import { initialSessionState, type SessionState } from '../lib/session/state.js';
import type { AudioEngine } from '../lib/viewers/tone-engine.js';
import ResultGrid from './ResultGrid.svelte';
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

const audioResult = tableFromArrays({
  seconds: [0.5, 1.25],
  note: [60, 60],
  velocity: [64, 0],
  kind: ['note_on', 'note_off'],
  channel: [0, 0],
});

const readyState = (): SessionState => ({
  phase: 'ready',
  source: { name: 'capture.bin', size: 1536 },
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
  result,
  queryElapsedMs: 4.2,
  queryError: null,
  selectedRow: null,
  fatalError: null,
  byteSelection: null,
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
  sourceBlob: Blob | null = new Blob([new Uint8Array(64).map((_, i) => i)]);
  selectByteRange = vi.fn((range: { start: number; end: number } | null) => {
    this.publish({ ...this.state, byteSelection: range });
  });
  getSourceBlob = vi.fn(() => this.sourceBlob);

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
const addMediaListener = vi.fn();
const removeMediaListener = vi.fn();

describe('Inspector Workbench', () => {
  beforeEach(() => {
    compactMode = false;
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
    render(Workbench, { controller });

    expect(screen.getByText(/files never leave this browser/i)).toBeTruthy();
    const input = screen.getByLabelText('Open file');
    expect(input.getAttribute('type')).toBe('file');
    expect((screen.getByRole('button', { name: 'Try sample' }) as HTMLButtonElement).disabled).toBe(false);

    await fireEvent.click(screen.getByRole('button', { name: 'Try sample' }));
    expect(controller.openSample).toHaveBeenCalledOnce();
  });

  it('hides the header Open button when no session can receive the picker click', () => {
    const idleController = new FakeController({ ...initialSessionState, phase: 'idle' });
    render(Workbench, { controller: idleController });
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    cleanup();

    const readyController = new FakeController(readyState());
    render(Workbench, { controller: readyController });
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
  });

  it('shows source context, pack metadata, query tools, results, and inspection landmarks', () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    const navigation = screen.getByRole('navigation', { name: 'Data explorer' });
    expect(within(navigation).getByText('Capture map')).toBeTruthy();
    expect(within(navigation).getByText('capture.bin')).toBeTruthy();
    expect(within(navigation).getByText('Example records')).toBeTruthy();
    expect(within(navigation).getByText('records')).toBeTruthy();
    expect(within(navigation).getByText('42 rows')).toBeTruthy();
    expect(
      (within(navigation).getByRole('button', { name: 'Recent records' }) as HTMLButtonElement).disabled,
    ).toBe(false);

    const workspace = screen.getByRole('main', { name: 'Results' });
    expect(workspace).toBeTruthy();
    expect(within(workspace).getByRole('heading', { name: 'Ask the capture' })).toBeTruthy();
    expect(within(workspace).getByText('Result set')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'SQL query' })).toBeTruthy();
    expect(within(workspace).getByText('2 rows')).toBeTruthy();
    expect(screen.getByRole('grid', { name: 'Query results' })).toBeTruthy();
    expect(
      within(screen.getByRole('complementary', { name: 'Inspector' })).getByText('Selected evidence'),
    ).toBeTruthy();
  });

  it('runs the bounded overview when a source first becomes ready', async () => {
    const controller = new FakeController({
      ...readyState(),
      sql: '',
      result: null,
      queryElapsedMs: null,
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
    expect(within(inspector).getByRole('button', { name: '0x1c – 0x29' })).toBeTruthy();
    expect(within(inspector).getByText('optional')).toBeTruthy();
    expect(within(inspector).getByText('available')).toBeTruthy();
    expect(textOf(editor)).toContain('select * from records limit 100');
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

    const savedQueries = screen.getByRole('region', { name: 'Saved queries' });
    expect(
      within(savedQueries)
        .getAllByRole('button')
        .map((button) => button.textContent?.trim()),
    ).toEqual(midiQueries.map((query) => `↗ ${query.title}`));
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
    const enabled = new FakeController({ ...readyState(), result: audioResult });
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
      result: audioResult,
      capabilities: {
        audio: { enabled: false, reason },
      },
    });
    render(Workbench, { controller: smpte });
    expect(screen.queryByRole('button', { name: 'Open in…' })).toBeNull();
    expect(textOf(screen.getByRole('status', { name: 'Format capability notice' }))).toBe(reason);
  });

  it('shows the notice for any disabled pack capability, not only audio', () => {
    const reason = 'Hex preview is unavailable for this source.';
    const controller = new FakeController({
      ...readyState(),
      result: audioResult,
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
    const controller = new FakeController({ ...readyState(), result: audioResult });
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
    controller.publish({ ...controller.state, result: tableFromArrays({ value: [1] }) });
    await vi.waitFor(() => expect(replaced.dispose).toHaveBeenCalledOnce());

    controller.publish({ ...controller.state, result: audioResult });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Open in…' })).toBeTruthy());
    const sessionReplaced = await openAudio();
    controller.publish({ ...initialSessionState, phase: 'opening', source: { name: 'next.mid', size: 8 } });
    await vi.waitFor(() => expect(sessionReplaced.dispose).toHaveBeenCalledOnce());
  });

  it('closes and disposes the active viewer through the exported closeActiveViewer method', async () => {
    const engine = fakeAudioEngine();
    const controller = new FakeController({ ...readyState(), result: audioResult });
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

  it('exposes only the active compact panel and tabs into that panel', async () => {
    compactMode = true;
    const user = userEvent.setup();
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    const resultsTab = screen.getByRole('tab', { name: 'Results' });
    const inspectorTab = screen.getByRole('tab', { name: 'Inspector' });
    const resultsPanel = screen.getByRole('tabpanel', { name: 'Results' });
    const inspectorPanel = document.getElementById('workbench-panel-inspector')!;

    expect(resultsTab.getAttribute('aria-controls')).toBe(resultsPanel.id);
    expect(inspectorTab.getAttribute('aria-controls')).toBe(inspectorPanel.id);
    expect(inspectorPanel.getAttribute('role')).toBe('tabpanel');
    expect(inspectorPanel.getAttribute('aria-labelledby')).toBe(inspectorTab.id);
    expect(screen.queryByRole('tabpanel', { name: 'Inspector' })).toBeNull();
    expect(resultsTab.getAttribute('aria-selected')).toBe('true');
    expect(resultsTab.getAttribute('tabindex')).toBe('0');
    expect(inspectorTab.getAttribute('tabindex')).toBe('-1');
    expect((resultsPanel as HTMLElement).hidden).toBe(false);
    expect(resultsPanel.getAttribute('tabindex')).toBe('0');
    expect((inspectorPanel as HTMLElement).hidden).toBe(true);
    expect(inspectorPanel.getAttribute('tabindex')).toBe('-1');

    resultsTab.focus();
    await user.tab();
    expect(document.activeElement).toBe(resultsPanel);

    resultsTab.focus();
    await fireEvent.keyDown(resultsTab, { key: 'ArrowRight' });
    expect(inspectorTab.getAttribute('aria-selected')).toBe('true');
    expect(inspectorTab.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(inspectorTab);
    expect((resultsPanel as HTMLElement).hidden).toBe(true);
    expect(resultsPanel.getAttribute('tabindex')).toBe('-1');
    expect((inspectorPanel as HTMLElement).hidden).toBe(false);
    expect(inspectorPanel.getAttribute('tabindex')).toBe('0');
    await user.tab();
    expect(document.activeElement).toBe(inspectorPanel);

    inspectorTab.focus();
    await fireEvent.keyDown(inspectorTab, { key: 'Home' });
    expect(resultsTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(resultsTab);

    await fireEvent.keyDown(resultsTab, { key: 'End' });
    expect(inspectorTab.getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(inspectorTab, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(resultsTab);
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
    expect(query).toContain('where _src_start < ');
  });

  it('passes the selected row provenance to the hex pane as highlight', async () => {
    const controller = new FakeController({
      ...readyState(),
      result: tableFromArrays({
        record_id: [1n, 2n],
        _src_start: [12n, 800n],
        _src_end: [20n, 840n],
      }),
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

  it('browses a table from the explorer with select * limit 10000', async () => {
    const controller = new FakeController(readyState());
    render(Workbench, { controller });

    const navigation = screen.getByRole('navigation', { name: 'Data explorer' });
    await fireEvent.click(within(navigation).getByRole('button', { name: 'Browse records' }));

    expect(controller.runQuery).toHaveBeenCalledWith('select * from records limit 10000');
  });

  it('opens a dropped file through the window-level drop overlay', async () => {
    const controller = new FakeController(readyState());
    const { container } = render(Workbench, { controller });
    const appShell = container.querySelector('.app-shell') as HTMLElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'dropped.bin');

    await fireEvent.dragEnter(appShell, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByText('Drop to open')).toBeTruthy();

    await fireEvent.drop(appShell, { dataTransfer: { files: [file] } });
    expect(controller.openFile).toHaveBeenCalledWith(file);
    expect(screen.queryByText('Drop to open')).toBeNull();
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

    expect(appShell.classList.contains('inspector-collapsed')).toBe(false);
    await user.keyboard('{Control>}i{/Control}');
    expect(appShell.classList.contains('inspector-collapsed')).toBe(true);
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
    render(ResultGrid, { table, onselect: vi.fn() });

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
});
