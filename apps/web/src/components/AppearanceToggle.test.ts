// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AppearanceToggle from './AppearanceToggle.svelte';

afterEach(cleanup);

describe('AppearanceToggle', () => {
  it('announces the appearance it will switch to', () => {
    render(AppearanceToggle, { theme: 'light', onchange: () => undefined });
    expect(screen.getByRole('button', { name: 'Use dark appearance' })).toBeTruthy();
  });

  it('announces the light appearance while dark is active', () => {
    render(AppearanceToggle, { theme: 'dark', onchange: () => undefined });
    expect(screen.getByRole('button', { name: 'Use light appearance' })).toBeTruthy();
  });

  it('requests the opposite appearance on click', async () => {
    const onchange = vi.fn();
    render(AppearanceToggle, { theme: 'light', onchange });
    await userEvent.click(screen.getByRole('button', { name: 'Use dark appearance' }));
    expect(onchange).toHaveBeenCalledExactlyOnceWith('dark');
  });

  it('requests light when dark is active', async () => {
    const onchange = vi.fn();
    render(AppearanceToggle, { theme: 'dark', onchange });
    await userEvent.click(screen.getByRole('button', { name: 'Use light appearance' }));
    expect(onchange).toHaveBeenCalledExactlyOnceWith('light');
  });

  it('holds no appearance state of its own', async () => {
    const onchange = vi.fn();
    render(AppearanceToggle, { theme: 'light', onchange });
    const button = screen.getByRole('button', { name: 'Use dark appearance' });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(onchange.mock.calls).toEqual([['dark'], ['dark']]);
  });
});
