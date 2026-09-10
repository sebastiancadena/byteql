// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AppHeader from './AppHeader.svelte';

function renderHeader(overrides: Record<string, unknown> = {}) {
  return render(AppHeader, {
    appearance: 'light',
    onappearancechange: vi.fn(),
    onshortcuts: vi.fn(),
    ...overrides,
  });
}

/** A loaded session supplies the source context plus the Sources and Values controls. */
function renderLoaded(overrides: Record<string, unknown> = {}) {
  return renderHeader({
    sourceName: 'capture.pcap',
    sourceSize: 2_400_000,
    formatTitle: 'pcap',
    onopen: vi.fn(),
    ontoggleexplorer: vi.fn(),
    ontoggleinspector: vi.fn(),
    ...overrides,
  });
}

describe('AppHeader', () => {
  afterEach(cleanup);

  it('names the product and what it is', () => {
    renderHeader();
    expect(screen.getByRole('link', { name: 'ByteQL home' })).toBeTruthy();
    expect(screen.getByText('ByteQL')).toBeTruthy();
    expect(screen.getByText('Binary file workspace')).toBeTruthy();
    expect(screen.queryByText(/Forensic Workbench/iu)).toBeNull();
  });

  it('hides the workspace controls while the session is idle', () => {
    renderHeader();
    expect(screen.queryByRole('button', { name: /sources/iu })).toBeNull();
    expect(screen.queryByRole('button', { name: /values/iu })).toBeNull();
    // Idle intake owns the only Open file action.
    expect(screen.queryByRole('button', { name: /open/iu })).toBeNull();
  });

  it('offers appearance and shortcuts in every session state', async () => {
    const onappearancechange = vi.fn();
    const onshortcuts = vi.fn();
    renderHeader({ onappearancechange, onshortcuts });

    await fireEvent.click(screen.getByRole('button', { name: 'Use dark appearance' }));
    expect(onappearancechange).toHaveBeenCalledWith('dark');

    await fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(onshortcuts).toHaveBeenCalledOnce();
  });

  it('announces the light appearance while dark is active', () => {
    renderHeader({ appearance: 'dark' });
    expect(screen.getByRole('button', { name: 'Use light appearance' })).toBeTruthy();
  });

  it('shows the source context and the Sources and Values controls when loaded', async () => {
    const ontoggleexplorer = vi.fn();
    const ontoggleinspector = vi.fn();
    renderLoaded({ ontoggleexplorer, ontoggleinspector });

    expect(screen.getByText('capture.pcap')).toBeTruthy();
    expect(screen.getByText('2.4 MB')).toBeTruthy();
    expect(screen.getByText('pcap')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Hide sources' }));
    expect(ontoggleexplorer).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole('button', { name: 'Hide values' }));
    expect(ontoggleinspector).toHaveBeenCalledOnce();
  });

  it('reflects collapsed state in the control names and pressed state', () => {
    renderLoaded({ explorerCollapsed: true, inspectorCollapsed: true });
    const sources = screen.getByRole('button', { name: 'Show sources' });
    const values = screen.getByRole('button', { name: 'Show values' });
    expect(sources.getAttribute('aria-pressed')).toBe('false');
    expect(values.getAttribute('aria-pressed')).toBe('false');
  });

  it('opens files and disables that action while intake is busy', async () => {
    const onopen = vi.fn();
    const { rerender } = renderLoaded({ onopen });

    const open = screen.getByRole<HTMLButtonElement>('button', { name: 'Open file' });
    expect(open.disabled).toBe(false);
    await fireEvent.click(open);
    expect(onopen).toHaveBeenCalledOnce();

    await rerender({ intakeBusy: true });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Open file' }).disabled).toBe(true);
  });
});
