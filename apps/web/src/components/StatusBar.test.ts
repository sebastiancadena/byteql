// @vitest-environment jsdom

import { cleanup, render, within } from '@testing-library/svelte';
import { tableFromArrays } from 'apache-arrow';
import { afterEach, describe, expect, it } from 'vitest';

import { initialSessionState, type SessionState } from '../lib/session/state.js';
import StatusBar from './StatusBar.svelte';

const stateWith = (overrides: Partial<SessionState>): SessionState => ({
  ...initialSessionState,
  ...overrides,
});

describe('StatusBar progress readout', () => {
  afterEach(() => {
    cleanup();
  });

  it('status bar shows percentage and rate during a bytes-based parse', () => {
    const state = stateWith({
      phase: 'projecting',
      progress: {
        completed: 50e6,
        total: 100e6,
        label: 'Projecting tables',
        bytes: 50e6,
        fileIndex: 1,
        fileCount: 1,
      },
      openStartedAt: Date.now() - 5000,
    });
    const { container } = render(StatusBar, { state });

    expect(within(container).getByText(/50%/)).toBeTruthy();
    expect(within(container).getByText(/10\.0 MB\/s/)).toBeTruthy();
  });

  it('labels paged timing as streaming before EOF and total after EOF', () => {
    const window = tableFromArrays({ value: Int32Array.from([1]) });
    const result = {
      generation: 1,
      schema: window.schema,
      loadedRows: 1_024,
      complete: false,
      loadingMore: false,
      windowStart: 0,
      window,
      completeTable: null,
      elapsedMs: 12.5,
      pageError: null,
      pageErrorRetryable: false,
    };
    const streaming = render(StatusBar, { state: stateWith({ phase: 'ready', result }) });
    expect(within(streaming.container).getByText('1,024 loaded · more available')).toBeTruthy();
    expect(within(streaming.container).getByText('12.5 ms streaming')).toBeTruthy();
    streaming.unmount();

    const complete = render(StatusBar, {
      state: stateWith({ phase: 'ready', result: { ...result, complete: true } }),
    });
    expect(within(complete.container).getByText('1,024 rows')).toBeTruthy();
    expect(within(complete.container).getByText('12.5 ms total')).toBeTruthy();
  });

  it('status bar omits the rate before it is meaningful and when total is null', () => {
    // Elapsed time is far below the 500 ms threshold, so the rate is not yet meaningful.
    const early = render(StatusBar, {
      state: stateWith({
        phase: 'projecting',
        progress: {
          completed: 50e6,
          total: 100e6,
          label: 'Projecting tables',
          bytes: 50e6,
          fileIndex: 1,
          fileCount: 1,
        },
        openStartedAt: Date.now(),
      }),
    });
    expect(within(early.container).getByText(/50%/)).toBeTruthy();
    expect(early.container.textContent).not.toMatch(/MB\/s/);
    early.unmount();

    // Track-count based progress (MIDI) has no byte total: no percentage, no rate.
    const trackBased = render(StatusBar, {
      state: stateWith({
        phase: 'parsing',
        progress: {
          completed: 3,
          total: null,
          label: 'Parsing tracks',
          bytes: 0,
          fileIndex: 1,
          fileCount: 1,
        },
        openStartedAt: Date.now() - 5000,
      }),
    });
    expect(trackBased.container.textContent).not.toMatch(/%/);
    expect(trackBased.container.textContent).not.toMatch(/MB\/s/);
    expect(trackBased.container.textContent).toContain('Parsing tracks');
    trackBased.unmount();

    // Sub-megabyte totals: percentage is generic and still shown, but MB/s doesn't apply.
    const subMegabyte = render(StatusBar, {
      state: stateWith({
        phase: 'parsing',
        progress: {
          completed: 250_000,
          total: 500_000,
          label: 'Parsing header',
          bytes: 250_000,
          fileIndex: 1,
          fileCount: 1,
        },
        openStartedAt: Date.now() - 5000,
      }),
    });
    expect(within(subMegabyte.container).getByText(/50%/)).toBeTruthy();
    expect(subMegabyte.container.textContent).not.toMatch(/MB\/s/);
  });

  it('status bar guards against NaN when total is zero', () => {
    const state = stateWith({
      phase: 'parsing',
      progress: { completed: 0, total: 0, label: 'Parsing MIDI', bytes: 0, fileIndex: 1, fileCount: 1 },
      openStartedAt: Date.now() - 5000,
    });
    const { container } = render(StatusBar, { state });

    expect(container.textContent).not.toMatch(/NaN/);
    expect(container.textContent).not.toMatch(/%/);
    expect(container.textContent).toContain('Parsing MIDI');
  });

  it('status bar clamps percentage to 100 when completed exceeds total', () => {
    const state = stateWith({
      phase: 'parsing',
      progress: { completed: 150, total: 100, label: 'Parsing', bytes: 150, fileIndex: 1, fileCount: 1 },
      openStartedAt: Date.now() - 5000,
    });
    const { container } = render(StatusBar, { state });

    expect(within(container).getByText(/100%/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/150%/);
  });

  it('shows the byte selection readout', () => {
    const state = { ...initialSessionState, byteSelection: { file: 'capture.pcap', start: 0x40, end: 0x78 } };
    const { getByText } = render(StatusBar, { props: { state } });
    expect(getByText('0x40–0x77 · 56 bytes')).toBeTruthy();
  });

  it('shows the batch position marker only when a batch has more than one file', () => {
    const withMarker = render(StatusBar, {
      state: stateWith({
        phase: 'parsing',
        progress: { completed: 50, total: 100, label: 'Parsing', bytes: 0, fileIndex: 2, fileCount: 5 },
      }),
    });
    expect(within(withMarker.container).getByText(/\(2\/5\)/u)).toBeTruthy();
    withMarker.unmount();

    const withoutMarker = render(StatusBar, {
      state: stateWith({
        phase: 'parsing',
        progress: { completed: 50, total: 100, label: 'Parsing', bytes: 0, fileIndex: 1, fileCount: 1 },
      }),
    });
    expect(withoutMarker.container.textContent).not.toMatch(/\(1\/1\)/u);
  });

  it('shows a batch summary once ready, including a skipped count when files were skipped', () => {
    const ready = render(StatusBar, {
      state: stateWith({
        phase: 'ready',
        source: {
          files: [
            { name: 'a.pcap', size: 1_200_000 },
            { name: 'b.pcap', size: 1_100_000 },
          ],
          totalSize: 2_300_000,
        },
        issues: [
          {
            stage: 'framing',
            track: null,
            code: 'FILE_SKIPPED',
            message: 'c.pcap was skipped: unrecognized format.',
            recoverable: true,
            sourceStart: null,
            sourceEnd: null,
          },
        ],
      }),
    });
    expect(within(ready.container).getByText('2 files · 2.3 MB · 1 skipped')).toBeTruthy();
    ready.unmount();

    const readyNoSkips = render(StatusBar, {
      state: stateWith({
        phase: 'ready',
        source: {
          files: [
            { name: 'a.pcap', size: 1_200_000 },
            { name: 'b.pcap', size: 1_100_000 },
          ],
          totalSize: 2_300_000,
        },
      }),
    });
    expect(within(readyNoSkips.container).getByText('2 files · 2.3 MB')).toBeTruthy();
    readyNoSkips.unmount();

    const singleFile = render(StatusBar, {
      state: stateWith({
        phase: 'ready',
        source: { files: [{ name: 'a.pcap', size: 1_200_000 }], totalSize: 1_200_000 },
      }),
    });
    expect(singleFile.container.textContent).not.toMatch(/files ·/u);
  });
});
