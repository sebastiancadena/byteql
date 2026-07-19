// @vitest-environment jsdom

import { cleanup, render, within } from '@testing-library/svelte';
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
      progress: { completed: 50e6, total: 100e6, label: 'Projecting tables', bytes: 50e6 },
      openStartedAt: Date.now() - 5000,
    });
    const { container } = render(StatusBar, { state });

    expect(within(container).getByText(/50%/)).toBeTruthy();
    expect(within(container).getByText(/10\.0 MB\/s/)).toBeTruthy();
  });

  it('status bar omits the rate before it is meaningful and when total is null', () => {
    // Elapsed time is far below the 500 ms threshold, so the rate is not yet meaningful.
    const early = render(StatusBar, {
      state: stateWith({
        phase: 'projecting',
        progress: { completed: 50e6, total: 100e6, label: 'Projecting tables', bytes: 50e6 },
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
        progress: { completed: 3, total: null, label: 'Parsing tracks', bytes: 0 },
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
        progress: { completed: 250_000, total: 500_000, label: 'Parsing header', bytes: 250_000 },
        openStartedAt: Date.now() - 5000,
      }),
    });
    expect(within(subMegabyte.container).getByText(/50%/)).toBeTruthy();
    expect(subMegabyte.container.textContent).not.toMatch(/MB\/s/);
  });
});
