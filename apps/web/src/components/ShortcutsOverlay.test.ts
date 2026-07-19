// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ShortcutsOverlay from './ShortcutsOverlay.svelte';

describe('ShortcutsOverlay', () => {
  afterEach(() => {
    cleanup();
  });

  it('lists the shortcut map and closes on Escape and on the close button', async () => {
    const user = userEvent.setup();
    const onclose = vi.fn();
    const { getByRole, getByText } = render(ShortcutsOverlay, { props: { onclose } });
    expect(getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
    expect(getByText('Run query')).toBeTruthy();
    expect(getByText('Go to offset')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(onclose).toHaveBeenCalledTimes(1);
    await user.click(getByRole('button', { name: 'Close shortcuts' }));
    expect(onclose).toHaveBeenCalledTimes(2);
  });
});
