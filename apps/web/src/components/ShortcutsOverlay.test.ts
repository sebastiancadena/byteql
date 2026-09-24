// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShortcutsOverlay from './ShortcutsOverlay.svelte';

/** jsdom reports no client rects, so focus containment sees nothing focusable without this. */
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'getClientRects', {
    configurable: true,
    value: () => [{ width: 10, height: 10 }] as unknown as DOMRectList,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ShortcutsOverlay', () => {
  it('lists every current action with platform-correct keys', () => {
    render(ShortcutsOverlay, { props: { onclose: vi.fn() } });

    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
    for (const action of [
      'Run query',
      'Save query',
      'Open file',
      'Show or hide sources',
      'Show or hide values',
      'Inspect bytes at an offset',
      'Bytes: move caret',
      'Bytes: extend selection',
      'Bytes: reveal row',
      'Bytes: select record',
      'Bytes: copy selection',
      'This overlay',
    ]) {
      expect(screen.getByText(action), action).toBeTruthy();
    }

    // jsdom's navigator.platform is not a Mac, so the non-Mac modifier is used.
    expect(screen.getByText('Ctrl+Enter')).toBeTruthy();
    expect(screen.getByText('Ctrl+S')).toBeTruthy();
    expect(screen.getByText('Ctrl+G')).toBeTruthy();
  });

  it('explains how a divider is resized and how a drag is abandoned', () => {
    render(ShortcutsOverlay, { props: { onclose: vi.fn() } });

    expect(
      screen.getByText(
        /Resize panel: focus divider, use arrows; Shift for larger steps; Home\/End for limits; double-click to reset one size\./u,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Escape while dragging a divider cancels that drag/u)).toBeTruthy();
  });

  it('offers the panel reset only when a loaded workspace supplies one', async () => {
    const user = userEvent.setup();
    const view = render(ShortcutsOverlay, { props: { onclose: vi.fn() } });
    expect(screen.queryByRole('button', { name: 'Reset panel sizes' })).toBeNull();
    view.unmount();

    const onclose = vi.fn();
    const onresetpanels = vi.fn();
    render(ShortcutsOverlay, { props: { onclose, onresetpanels } });

    await user.click(screen.getByRole('button', { name: 'Reset panel sizes' }));
    expect(onresetpanels).toHaveBeenCalledOnce();
    // Resetting is not dismissing: the dialog stays where it is.
    expect(onclose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });

  it('closes on Escape, on the close button and on a backdrop click', async () => {
    const user = userEvent.setup();
    const onclose = vi.fn();
    const { container } = render(ShortcutsOverlay, { props: { onclose } });

    await user.keyboard('{Escape}');
    expect(onclose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Close shortcuts' }));
    expect(onclose).toHaveBeenCalledTimes(2);

    await user.click(container.querySelector('.shortcuts-backdrop')!);
    expect(onclose).toHaveBeenCalledTimes(3);

    // A click that bubbles out of the panel is not a dismissal.
    await user.click(screen.getByRole('dialog', { name: 'Keyboard shortcuts' }));
    expect(onclose).toHaveBeenCalledTimes(3);
  });

  it('contains Tab inside the dialog and returns focus to the opener', async () => {
    const user = userEvent.setup();
    const opener = document.createElement('button');
    opener.textContent = 'Keyboard shortcuts';
    document.body.append(opener);
    opener.focus();

    const view = render(ShortcutsOverlay, { props: { onclose: vi.fn() } });
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Only the close button is focusable, so Tab wraps onto it rather than escaping.
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
