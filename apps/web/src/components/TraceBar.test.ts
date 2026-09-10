// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TraceSummary } from '../lib/ui/trace.js';
import TraceBar from './TraceBar.svelte';

const linked: TraceSummary = {
  kind: 'linked',
  row: 2,
  range: { file: 'capture.pcap', start: 98, end: 196 },
  label: '0x00000062–0x000000c3 · 98 bytes',
};

function renderBar(overrides: Record<string, unknown> = {}) {
  const handlers = { onreveal: vi.fn(), ontoggle: vi.fn() };
  const view = render(TraceBar, { summary: linked, collapsed: false, ...handlers, ...overrides });
  return { ...view, ...handlers };
}

describe('TraceBar', () => {
  afterEach(cleanup);

  it('is a labelled region that reports which trace state it is in', () => {
    const { container } = renderBar();
    const region = screen.getByRole('region', { name: 'Source trace' });
    expect(region).toBeTruthy();
    expect(container.querySelector('[data-trace-state="linked"]')).toBeTruthy();
  });

  it('reads a linked row as row, file, then range', () => {
    renderBar();
    const region = screen.getByRole('region', { name: 'Source trace' });
    expect(within(region).getByText('Row 2')).toBeTruthy();
    expect(within(region).getByText('capture.pcap')).toBeTruthy();
    expect(within(region).getByText('0x00000062–0x000000c3 · 98 bytes')).toBeTruthy();
  });

  it('exposes the inclusive meaning of the range in accessible detail', () => {
    renderBar();
    const range = screen.getByText('0x00000062–0x000000c3 · 98 bytes');
    expect(range.getAttribute('title')?.toLowerCase()).toContain('inclusive byte offsets');
  });

  it('reveals the source range on request', async () => {
    const { onreveal } = renderBar();
    await fireEvent.click(screen.getByRole('button', { name: 'Inspect source' }));
    expect(onreveal).toHaveBeenCalledOnce();
  });

  it.each([
    ['empty', 'Run a query to inspect source bytes.'],
    ['unselected', 'Select a row to trace its source bytes.'],
    ['outside-window', 'Selected row is outside the loaded window.'],
    ['unlinked', 'This row has no source byte range.'],
    ['unavailable', 'Source bytes are unavailable for this row.'],
  ] as const)('states %s plainly and offers no reveal action', (kind, message) => {
    const { container } = renderBar({ summary: { kind, message } });

    expect(screen.getByText(message)).toBeTruthy();
    expect(container.querySelector(`[data-trace-state="${kind}"]`)).toBeTruthy();
    // Nothing to reveal: never offer an action that would show the wrong bytes.
    expect(screen.queryByRole('button', { name: 'Inspect source' })).toBeNull();
  });

  it('keeps the inspection toggle available in every state', async () => {
    for (const summary of [linked, { kind: 'unlinked' as const, message: 'no range' }]) {
      const { ontoggle } = renderBar({ summary });
      const toggle = screen.getByRole('button', { name: 'Hide inspection' });
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      await fireEvent.click(toggle);
      expect(ontoggle).toHaveBeenCalledOnce();
      cleanup();
    }
  });

  it('offers to show inspection while the dock is collapsed', () => {
    renderBar({ collapsed: true });
    const toggle = screen.getByRole('button', { name: 'Show inspection' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // The strip itself stays readable when the dock below it is closed.
    expect(screen.getByText('0x00000062–0x000000c3 · 98 bytes')).toBeTruthy();
  });
});
