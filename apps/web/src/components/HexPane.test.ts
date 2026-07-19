// @vitest-environment jsdom
// apps/web/src/components/HexPane.test.ts
import { cleanup, render } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import HexPane from './HexPane.svelte';

const blob = new Blob([new Uint8Array(64).map((_, i) => i)]);

function renderPane(overrides: Record<string, unknown> = {}) {
  return render(HexPane, {
    props: {
      blob,
      fileSize: 64,
      coverage: null,
      coverageReason: 'no-provenance',
      highlight: null,
      filterAvailable: false,
      onreveal: vi.fn(),
      onselectionchange: vi.fn(),
      onfilter: vi.fn(),
      ...overrides,
    },
  });
}

describe('HexPane', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('renders the pane with provenance status and no caret', () => {
    const { container } = renderPane();
    const root = container.querySelector('[data-hex-pane]');
    expect(root?.getAttribute('data-hex-provenance')).toBe('no-provenance');
    expect(root?.getAttribute('data-hex-caret')).toBe('');
    expect(root?.textContent).toContain('No byte provenance in this result');
  });

  it('exposes the grid-row highlight range on data-hex-highlight', () => {
    const { container } = renderPane({ highlight: { start: 12, end: 20 } });
    const root = container.querySelector('[data-hex-pane]');
    // The grid->hex link surfaces as `highlight`, distinct from the pane's own selection; e2e
    // reads this attribute to learn which bytes a row lit up. Absent a highlight it is empty.
    expect(root?.getAttribute('data-hex-highlight')).toBe('12-20');
    expect(root?.getAttribute('data-hex-selection')).toBe('');
  });

  it('leaves data-hex-highlight empty when no row is selected', () => {
    const { container } = renderPane();
    expect(container.querySelector('[data-hex-pane]')?.getAttribute('data-hex-highlight')).toBe('');
  });

  it('jumps and sets the caret through the goto input', async () => {
    const user = userEvent.setup();
    const { container, getByLabelText } = renderPane();
    await user.type(getByLabelText('Go to offset'), '0x10{Enter}');
    const root = container.querySelector('[data-hex-pane]');
    expect(root?.getAttribute('data-hex-caret')).toBe('16');
  });

  it('flags invalid goto input instead of jumping', async () => {
    const user = userEvent.setup();
    const { container, getByLabelText } = renderPane();
    await user.type(getByLabelText('Go to offset'), 'wat{Enter}');
    expect(getByLabelText('Go to offset').getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('[data-hex-pane]')?.getAttribute('data-hex-caret')).toBe('');
  });

  it('moves the caret with arrows and reveals with Enter', async () => {
    const user = userEvent.setup();
    const onreveal = vi.fn();
    const { container, getByLabelText, getByRole } = renderPane({ onreveal });
    await user.type(getByLabelText('Go to offset'), '0{Enter}');
    const canvasHost = getByRole('application', { name: 'Hex viewer' });
    canvasHost.focus();
    await user.keyboard('{ArrowRight}{ArrowDown}');
    expect(container.querySelector('[data-hex-pane]')?.getAttribute('data-hex-caret')).toBe('17');
    await user.keyboard('{Enter}');
    expect(onreveal).toHaveBeenCalledWith(17);
  });

  it('reports selection changes end-exclusively', async () => {
    const user = userEvent.setup();
    const onselectionchange = vi.fn();
    const { getByLabelText, getByRole } = renderPane({ onselectionchange });
    await user.type(getByLabelText('Go to offset'), '4{Enter}');
    getByRole('application', { name: 'Hex viewer' }).focus();
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}');
    expect(onselectionchange).toHaveBeenLastCalledWith({ start: 4, end: 7 });
  });

  it('shows the filter action only when available and a selection exists', async () => {
    const user = userEvent.setup();
    const onfilter = vi.fn();
    const { getByLabelText, getByRole, queryByRole } = renderPane({
      filterAvailable: true,
      coverageReason: 'ok',
      onfilter,
    });
    expect(queryByRole('button', { name: 'Filter results to selection' })).toBeNull();
    await user.type(getByLabelText('Go to offset'), '4{Enter}');
    getByRole('application', { name: 'Hex viewer' }).focus();
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await user.click(getByRole('button', { name: 'Filter results to selection' }));
    expect(onfilter).toHaveBeenCalledWith({ start: 4, end: 6 });
  });

  it('collapses to the toolbar strip and persists the flag', async () => {
    const user = userEvent.setup();
    const { container, getByRole } = renderPane();
    await user.click(getByRole('button', { name: 'Collapse hex view' }));
    expect(container.querySelector('[data-hex-pane]')?.getAttribute('data-hex-collapsed')).toBe('true');
    expect(localStorage.getItem('byteql.hexpane.collapsed')).toBe('true');
  });
});
