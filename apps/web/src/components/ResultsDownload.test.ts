// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { Field, Int32, List, Schema, Utf8, tableFromArrays } from 'apache-arrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@byteql/db', () => ({
  isSupportedParquetType: () => true,
  unsupportedParquetTypeMessage: (column: string, type: unknown) =>
    `Column "${column}" has unsupported Parquet type ${String(type)}; cast it explicitly in SQL.`,
}));

import type { SessionController } from '../lib/session/controller.js';
import { initialSessionState, type SessionState } from '../lib/session/state.js';
import ResultsDownload from './ResultsDownload.svelte';
import {
  emptyLabelResultTable,
  mixedDuplicateResultTable,
  withResultLabels,
} from './result-columns.test-support.js';

const table = tableFromArrays({
  value: [1],
  _src_start: [4n],
  _src_end: [8n],
});

const resultState = (overrides: Partial<NonNullable<SessionState['result']>> = {}) => ({
  generation: 1,
  schema: table.schema,
  loadedRows: table.numRows,
  complete: true,
  loadingMore: false,
  windowStart: 0,
  window: table,
  completeTable: table,
  elapsedMs: 1,
  pageError: null,
  pageErrorRetryable: false,
  orderRevision: 0,
  sort: null,
  ...overrides,
});

const sessionState = (overrides: Partial<SessionState> = {}): SessionState => ({
  ...initialSessionState,
  phase: 'ready',
  source: { files: [{ name: 'capture.pcap', size: 32 }], totalSize: 32 },
  result: resultState(),
  resultIsCurrent: true,
  ...overrides,
});

const controllerDouble = () =>
  ({
    downloadResults: vi.fn(async () => undefined),
    cancelResultsDownload: vi.fn(async () => undefined),
    saveResultsDownload: vi.fn(),
    dismissResultsDownload: vi.fn(async () => undefined),
  }) as unknown as SessionController;

const exportState = (
  phase: NonNullable<SessionState['download']>['phase'],
  overrides: Partial<NonNullable<SessionState['download']>> = {},
): NonNullable<SessionState['download']> => ({
  generation: 4,
  phase,
  rows: 12,
  totalRows: null,
  bytes: 0,
  message: null,
  ...overrides,
});

const enableOpfs = (): void => {
  vi.stubGlobal('navigator', {
    platform: 'Linux',
    storage: { getDirectory: vi.fn() },
  });
};

/** Reads the Parquet preview table's data rows (header row excluded) as [column, label, name]. */
const previewRows = (dialog: HTMLElement): (string | null)[][] => {
  const table = within(dialog).queryByRole('table', { name: 'Parquet column names' });
  if (!table) return [];
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    );
};

describe('ResultsDownload', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('defaults to CSV with provenance and sends selected Parquet options', async () => {
    enableOpfs();
    const user = userEvent.setup();
    const controller = controllerDouble();
    render(ResultsDownload, { controller, session: sessionState() });

    const opener = screen.getByRole('button', { name: 'Download results' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Download results' });
    const format = within(dialog).getByRole('combobox', { name: 'Format' }) as HTMLSelectElement;
    const provenance = within(dialog).getByRole('checkbox', {
      name: /include hidden columns and byte provenance/i,
    }) as HTMLInputElement;

    expect(format.value).toBe('csv');
    expect(provenance.checked).toBe(true);

    await user.selectOptions(format, 'parquet');
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    expect(controller.downloadResults).toHaveBeenCalledWith({
      format: 'parquet',
      includeProvenance: true,
    });
  });

  it('moves focus into the dialog and closes on Escape immediately after opening', async () => {
    enableOpfs();
    const user = userEvent.setup();
    render(ResultsDownload, { controller: controllerDouble(), session: sessionState() });

    const opener = screen.getByRole('button', { name: 'Download results' });
    await user.tab();
    expect(document.activeElement).toBe(opener);
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Download results' });

    expect(document.activeElement).toBe(dialog);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Download results' })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('dismisses on an outside click and returns focus, without trapping Tab', async () => {
    enableOpfs();
    const user = userEvent.setup();
    render(ResultsDownload, { controller: controllerDouble(), session: sessionState() });

    const opener = screen.getByRole('button', { name: 'Download results' });
    await user.click(opener);
    expect(screen.getByRole('dialog', { name: 'Download results' })).toBeTruthy();
    // Nonmodal: it must not claim modality over the workspace behind it.
    expect(screen.getByRole('dialog', { name: 'Download results' }).getAttribute('aria-modal')).toBeNull();

    await fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Download results' })).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('stays open for a click inside its own panel', async () => {
    enableOpfs();
    const user = userEvent.setup();
    render(ResultsDownload, { controller: controllerDouble(), session: sessionState() });

    await user.click(screen.getByRole('button', { name: 'Download results' }));
    const dialog = screen.getByRole('dialog', { name: 'Download results' });
    await fireEvent.pointerDown(dialog);
    expect(screen.getByRole('dialog', { name: 'Download results' })).toBeTruthy();
  });

  it('disables the control without a result but keeps a zero-row result exportable', async () => {
    enableOpfs();
    const controller = controllerDouble();
    const noResult = render(ResultsDownload, {
      controller,
      session: sessionState({ result: null }),
    });

    const unavailable = screen.getByRole('button', { name: 'Download results' }) as HTMLButtonElement;
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText(/run a query before downloading results/i)).toBeTruthy();
    noResult.unmount();

    render(ResultsDownload, {
      controller,
      session: sessionState({ result: resultState({ loadedRows: 0 }) }),
    });
    expect((screen.getByRole('button', { name: 'Download results' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('explains that provenance exclusion removes every hidden underscore alias', async () => {
    enableOpfs();
    const user = userEvent.setup();
    const controller = controllerDouble();
    const hiddenOnly = tableFromArrays({ _custom_alias: ['private'], _src_start: [1n] });
    render(ResultsDownload, {
      controller,
      session: sessionState({
        result: resultState({ schema: hiddenOnly.schema, window: hiddenOnly, completeTable: hiddenOnly }),
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Download results' }));
    const dialog = screen.getByRole('dialog', { name: 'Download results' });
    expect(within(dialog).getByText(/all columns whose names start with.*_/i)).toBeTruthy();
    expect(within(dialog).getByText(/custom aliases/i)).toBeTruthy();

    await user.click(
      within(dialog).getByRole('checkbox', { name: /include hidden columns and byte provenance/i }),
    );
    expect((within(dialog).getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(within(dialog).getByText(/at least one column must be selected/i)).toBeTruthy();
  });

  it('keeps Parquet enabled for case-colliding labels and previews the renamed file column', async () => {
    enableOpfs();
    const user = userEvent.setup();
    const duplicateSchema = new Schema([
      new Field('Value', new Int32(), true),
      new Field('value', new Int32(), true),
    ]);
    render(ResultsDownload, {
      controller: controllerDouble(),
      session: sessionState({ result: resultState({ schema: duplicateSchema }) }),
    });

    await user.click(screen.getByRole('button', { name: 'Download results' }));
    const dialog = screen.getByRole('dialog', { name: 'Download results' });
    expect((within(dialog).getByRole('option', { name: 'Parquet' }) as HTMLOptionElement).disabled).toBe(
      false,
    );

    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Format' }), 'parquet');

    expect(within(dialog).getByRole('heading', { name: 'Parquet column names' })).toBeTruthy();
    expect(previewRows(dialog)).toEqual([['2', 'value', 'value_2']]);
  });

  describe('Parquet column preview', () => {
    it('shows a row only for the label the allocator actually renames', async () => {
      enableOpfs();
      const user = userEvent.setup();
      const duplicate = mixedDuplicateResultTable();
      render(ResultsDownload, {
        controller: controllerDouble(),
        session: sessionState({
          result: resultState({ schema: duplicate.schema, window: duplicate, completeTable: duplicate }),
        }),
      });

      await user.click(screen.getByRole('button', { name: 'Download results' }));
      const dialog = screen.getByRole('dialog', { name: 'Download results' });
      await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Format' }), 'parquet');

      expect(previewRows(dialog)).toEqual([['2', 'dup', 'dup_2']]);
    });

    it('jumps past a suffix already reserved by another selected label', async () => {
      enableOpfs();
      const user = userEvent.setup();
      const suffixed = withResultLabels(
        tableFromArrays({
          c0: Int32Array.from([1]),
          c1: Int32Array.from([2]),
          c2: Int32Array.from([3]),
        }),
        ['dup', 'dup', 'dup_2'],
      );
      render(ResultsDownload, {
        controller: controllerDouble(),
        session: sessionState({
          result: resultState({ schema: suffixed.schema, window: suffixed, completeTable: suffixed }),
        }),
      });

      await user.click(screen.getByRole('button', { name: 'Download results' }));
      const dialog = screen.getByRole('dialog', { name: 'Download results' });
      await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Format' }), 'parquet');

      expect(previewRows(dialog)).toEqual([['2', 'dup', 'dup_3']]);
    });

    it('shows the positional fallback name for an empty SQL label', async () => {
      enableOpfs();
      const user = userEvent.setup();
      const empty = emptyLabelResultTable();
      render(ResultsDownload, {
        controller: controllerDouble(),
        session: sessionState({
          result: resultState({ schema: empty.schema, window: empty, completeTable: empty }),
        }),
      });

      await user.click(screen.getByRole('button', { name: 'Download results' }));
      const dialog = screen.getByRole('dialog', { name: 'Download results' });
      await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Format' }), 'parquet');

      expect(previewRows(dialog)).toEqual([['1', '(empty)', 'column_1']]);
    });

    it('renders no mapping for unique labels, and none at all while CSV is selected', async () => {
      enableOpfs();
      const user = userEvent.setup();
      render(ResultsDownload, {
        controller: controllerDouble(),
        session: sessionState({ result: resultState() }),
      });

      await user.click(screen.getByRole('button', { name: 'Download results' }));
      const dialog = screen.getByRole('dialog', { name: 'Download results' });
      await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Format' }), 'parquet');
      expect(screen.queryByRole('heading', { name: 'Parquet column names' })).toBeNull();
      cleanup();

      const duplicate = mixedDuplicateResultTable();
      render(ResultsDownload, {
        controller: controllerDouble(),
        session: sessionState({
          result: resultState({ schema: duplicate.schema, window: duplicate, completeTable: duplicate }),
        }),
      });
      await user.click(screen.getByRole('button', { name: 'Download results' }));
      expect(screen.getByRole('dialog', { name: 'Download results' })).toBeTruthy();
      // CSV is the default format: duplicate labels exist, but the preview is Parquet-only.
      expect(screen.queryByRole('heading', { name: 'Parquet column names' })).toBeNull();
    });

    it('stays empty while validation fails even though the labels would collide', async () => {
      // Parquet must be selected while it is still genuinely enabled (OPFS available), otherwise
      // user-event's selectOptions silently no-ops on a disabled <option> and never dispatches a
      // change event, leaving options.format untouched and the assertions passing for the wrong
      // reason. Only after Parquet is confirmed selected does the session flip resultIsCurrent to
      // false, so validation fails while Parquet stays the active format.
      enableOpfs();
      const user = userEvent.setup();
      const controller = controllerDouble();
      const duplicateSchema = new Schema([
        new Field('Value', new Int32(), true),
        new Field('value', new Int32(), true),
      ]);
      const view = render(ResultsDownload, {
        controller,
        session: sessionState({ result: resultState({ schema: duplicateSchema }) }),
      });

      await user.click(screen.getByRole('button', { name: 'Download results' }));
      const dialog = screen.getByRole('dialog', { name: 'Download results' });
      const format = within(dialog).getByRole('combobox', { name: 'Format' }) as HTMLSelectElement;
      await user.selectOptions(format, 'parquet');
      expect(format.value).toBe('parquet');
      expect(previewRows(dialog)).toEqual([['2', 'value', 'value_2']]);

      await view.rerender({
        controller,
        session: sessionState({
          result: resultState({ schema: duplicateSchema }),
          resultIsCurrent: false,
        }),
      });

      // Guard: the state this test names is only reached if the format is still Parquet.
      expect(format.value).toBe('parquet');
      expect(screen.queryByRole('heading', { name: 'Parquet column names' })).toBeNull();
      expect(previewRows(dialog)).toEqual([]);
    });

    it('changes consistently when hidden columns are toggled', async () => {
      enableOpfs();
      const user = userEvent.setup();
      const hidden = withResultLabels(
        tableFromArrays({
          c0: Int32Array.from([1]),
          c1: Int32Array.from([2]),
          c2: Int32Array.from([3]),
        }),
        ['name', '_meta', '_meta'],
      );
      render(ResultsDownload, {
        controller: controllerDouble(),
        session: sessionState({
          result: resultState({ schema: hidden.schema, window: hidden, completeTable: hidden }),
        }),
      });

      await user.click(screen.getByRole('button', { name: 'Download results' }));
      const dialog = screen.getByRole('dialog', { name: 'Download results' });
      await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Format' }), 'parquet');

      expect(previewRows(dialog)).toEqual([['3', '_meta', '_meta_2']]);

      const provenance = within(dialog).getByRole('checkbox', {
        name: /include hidden columns and byte provenance/i,
      });
      await user.click(provenance);
      expect(screen.queryByRole('heading', { name: 'Parquet column names' })).toBeNull();

      await user.click(provenance);
      expect(previewRows(dialog)).toEqual([['3', '_meta', '_meta_2']]);
    });

    it('renders an untrusted label as inert text in both the label and file name cells', async () => {
      enableOpfs();
      const user = userEvent.setup();
      const label = '<img src=x onerror="alert(1)">';
      const untrusted = withResultLabels(tableFromArrays({ c0: ['a'], c1: ['b'] }), [label, label]);
      render(ResultsDownload, {
        controller: controllerDouble(),
        session: sessionState({
          result: resultState({ schema: untrusted.schema, window: untrusted, completeTable: untrusted }),
        }),
      });

      await user.click(screen.getByRole('button', { name: 'Download results' }));
      const dialog = screen.getByRole('dialog', { name: 'Download results' });
      await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Format' }), 'parquet');

      expect(previewRows(dialog)).toEqual([['2', label, `${label}_2`]]);
      expect(dialog.querySelector('img')).toBeNull();
    });

    it('describes the Download button by the preview and still triggers exactly one download by keyboard', async () => {
      enableOpfs();
      const user = userEvent.setup();
      const duplicate = mixedDuplicateResultTable();
      const controller = controllerDouble();
      render(ResultsDownload, {
        controller,
        session: sessionState({
          result: resultState({ schema: duplicate.schema, window: duplicate, completeTable: duplicate }),
        }),
      });

      await user.click(screen.getByRole('button', { name: 'Download results' }));
      const dialog = screen.getByRole('dialog', { name: 'Download results' });
      await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Format' }), 'parquet');

      const heading = within(dialog).getByRole('heading', { name: 'Parquet column names' });
      const previewRegion = heading.parentElement as HTMLElement;
      const downloadButton = within(dialog).getByRole('button', { name: 'Download' });
      expect(downloadButton.getAttribute('aria-describedby')?.split(/\s+/u)).toContain(previewRegion.id);

      const provenance = within(dialog).getByRole('checkbox', {
        name: /include hidden columns and byte provenance/i,
      });
      provenance.focus();
      await user.tab();
      expect(document.activeElement).toBe(downloadButton);
      await user.keyboard('{Enter}');

      expect(controller.downloadResults).toHaveBeenCalledOnce();
      expect(controller.downloadResults).toHaveBeenCalledWith({ format: 'parquet', includeProvenance: true });
    });
  });

  it('disables Parquet when OPFS is unavailable and explains the browser requirement', async () => {
    vi.stubGlobal('navigator', { platform: 'Linux', storage: {} });
    const user = userEvent.setup();
    render(ResultsDownload, { controller: controllerDouble(), session: sessionState() });

    await user.click(screen.getByRole('button', { name: 'Download results' }));
    const dialog = screen.getByRole('dialog', { name: 'Download results' });
    expect((within(dialog).getByRole('option', { name: 'Parquet' }) as HTMLOptionElement).disabled).toBe(
      true,
    );
    const explanation = within(dialog).getByText(/parquet.*opfs.*not available/i);
    const format = within(dialog).getByRole('combobox', { name: 'Format' });
    expect(explanation.id).toBe('results-download-parquet-disabled-reason');
    expect(format.getAttribute('aria-describedby')?.split(/\s+/u)).toContain(explanation.id);
  });

  it('disables schema-incompatible CSV with column-specific cast guidance', async () => {
    enableOpfs();
    const user = userEvent.setup();
    const nestedSchema = new Schema([
      new Field('events', new List(new Field('item', new Utf8(), true)), true),
    ]);
    render(ResultsDownload, {
      controller: controllerDouble(),
      session: sessionState({ result: resultState({ schema: nestedSchema }) }),
    });

    await user.click(screen.getByRole('button', { name: 'Download results' }));
    const dialog = screen.getByRole('dialog', { name: 'Download results' });
    expect((within(dialog).getByRole('option', { name: 'CSV' }) as HTMLOptionElement).disabled).toBe(true);
    expect(within(dialog).getByText(/csv.*events.*cast/i)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('blocks downloads while a sort is replacing the order on display', async () => {
    enableOpfs();
    const { getByRole, getByText } = render(ResultsDownload, {
      controller: controllerDouble(),
      session: sessionState({
        sorting: {
          requestId: 1,
          queryGeneration: 1,
          fromRevision: 0,
          requestedSort: { columnIndex: 0, direction: 'asc' },
          phase: 'sorting',
          rows: 0,
          totalRows: 3,
          message: 'Sorting all 3 rows…',
        },
      }),
    });
    await fireEvent.click(getByRole('button', { name: 'Download results' }));

    expect(getByText(/Finish or cancel the sort/iu)).toBeTruthy();
    expect((getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks downloads of a result left visible after a failed query', async () => {
    enableOpfs();
    const { getByRole, getByText } = render(ResultsDownload, {
      controller: controllerDouble(),
      session: sessionState({ resultIsCurrent: false }),
    });
    await fireEvent.click(getByRole('button', { name: 'Download results' }));

    expect(getByText(/Run the query again/iu)).toBeTruthy();
    expect((getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks unresolved result-page errors with retry or rerun guidance', async () => {
    enableOpfs();
    const user = userEvent.setup();
    render(ResultsDownload, {
      controller: controllerDouble(),
      session: sessionState({
        result: resultState({
          pageError: 'Local result storage is full.',
          pageErrorRetryable: true,
        }),
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Download results' }));
    const dialog = screen.getByRole('dialog', { name: 'Download results' });
    expect((within(dialog).getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(within(dialog).getByText(/retry or rerun.*before downloading/i)).toBeTruthy();
  });

  it.each([
    ['picking', 'Choosing where to save…'],
    ['loading', 'Loading remaining rows…'],
    ['encoding', 'Preparing Parquet file…'],
    ['saving', 'Saving file…'],
  ] as const)('shows non-percentage progress and Cancel during %s', async (phase, statusMessage) => {
    enableOpfs();
    const user = userEvent.setup();
    const controller = controllerDouble();
    render(ResultsDownload, {
      controller,
      session: sessionState({
        download: exportState(phase, { message: phase === 'picking' ? null : statusMessage }),
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Download results' }));
    const dialog = screen.getByRole('dialog', { name: 'Download results' });
    const status = within(dialog).getByRole('status');
    expect(status.textContent).toContain(statusMessage);
    expect(status.textContent).not.toContain('%');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(controller.cancelResultsDownload).toHaveBeenCalledOnce();
  });

  it('shows Cancelling while cancellation settles', async () => {
    enableOpfs();
    const user = userEvent.setup();
    render(ResultsDownload, {
      controller: controllerDouble(),
      session: sessionState({
        download: exportState('cancelling', { message: 'Cancelling download…' }),
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Download results' }));
    const cancelling = within(screen.getByRole('dialog', { name: 'Download results' })).getByRole('button', {
      name: 'Cancelling…',
    }) as HTMLButtonElement;
    expect(cancelling.disabled).toBe(true);
  });

  it('offers fallback Save, reports browser handoff accurately, and dismisses terminal states', async () => {
    enableOpfs();
    const user = userEvent.setup();
    const controller = controllerDouble();
    const view = render(ResultsDownload, {
      controller,
      session: sessionState({
        download: exportState('ready-to-save', {
          message: 'File ready. Choose Save file to download it.',
          totalRows: 12,
        }),
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Download results' }));
    let dialog = screen.getByRole('dialog', { name: 'Download results' });
    await user.click(within(dialog).getByRole('button', { name: 'Save file' }));
    expect(controller.saveResultsDownload).toHaveBeenCalledOnce();
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    expect(controller.dismissResultsDownload).toHaveBeenCalledOnce();

    await view.rerender({
      controller,
      session: sessionState({
        download: exportState('saved', { message: 'Download handed to the browser.' }),
      }),
    });
    dialog = screen.getByRole('dialog', { name: 'Download results' });
    expect(within(dialog).getByRole('status').textContent).toContain('Download handed to the browser.');
    expect(within(dialog).getByRole('status').textContent).not.toMatch(/saved to disk|finished saving/i);
  });

  it('renders export failures as alerts, catches controller rejections, and dismisses errors', async () => {
    enableOpfs();
    const user = userEvent.setup();
    const controller = controllerDouble();
    const view = render(ResultsDownload, {
      controller,
      session: sessionState({
        download: exportState('failed', { message: 'Local storage is full.' }),
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Download results' }));
    const dialog = screen.getByRole('dialog', { name: 'Download results' });
    expect(within(dialog).getByRole('alert').textContent).toContain('Local storage is full.');
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    expect(controller.dismissResultsDownload).toHaveBeenCalledOnce();

    vi.mocked(controller.downloadResults).mockRejectedValueOnce(new Error('Controller boundary failed.'));
    await view.rerender({ controller, session: sessionState() });
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Controller boundary failed.');
  });
});
