// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SampleMenu from './SampleMenu.svelte';

describe('SampleMenu', () => {
  afterEach(() => cleanup());

  it('keeps the menu closed until the trigger is clicked', () => {
    render(SampleMenu, { onselect: vi.fn() });
    const trigger = screen.getByRole('button', { name: 'Try sample' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens and lists both samples with pcap first', async () => {
    render(SampleMenu, { onselect: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Try sample' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      'Network capture (pcap)',
      'MIDI song (.mid)',
    ]);
  });

  it('emits the chosen sample id and closes', async () => {
    const onselect = vi.fn();
    render(SampleMenu, { onselect });
    await fireEvent.click(screen.getByRole('button', { name: 'Try sample' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Network capture (pcap)' }));
    expect(onselect).toHaveBeenCalledWith('pcap');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('disables the trigger while busy', () => {
    render(SampleMenu, { onselect: vi.fn(), busy: true });
    expect((screen.getByRole('button', { name: 'Try sample' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
