// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
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

  it('focuses the first item and moves between them with arrows, Home and End', async () => {
    render(SampleMenu, { onselect: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Try sample' }));

    const [first, last] = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(first);

    await fireEvent.keyDown(first!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(last);

    // Arrowing past the end wraps rather than escaping the menu.
    await fireEvent.keyDown(last!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);

    await fireEvent.keyDown(first!, { key: 'End' });
    expect(document.activeElement).toBe(last);
    await fireEvent.keyDown(last!, { key: 'Home' });
    expect(document.activeElement).toBe(first);

    await fireEvent.keyDown(first!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(last);
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(SampleMenu, { onselect: vi.fn() });
    const trigger = screen.getByRole('button', { name: 'Try sample' });
    // A real click focuses the trigger — that is what the menu returns focus to.
    await user.click(trigger);

    await fireEvent.keyDown(screen.getAllByRole('menuitem')[0]!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on a click outside and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(SampleMenu, { onselect: vi.fn() });
    const trigger = screen.getByRole('button', { name: 'Try sample' });
    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeTruthy();

    await fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('does not trap Tab: it is a menu, not a modal', async () => {
    render(SampleMenu, { onselect: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Try sample' }));

    const first = screen.getAllByRole('menuitem')[0]!;
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    first.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
