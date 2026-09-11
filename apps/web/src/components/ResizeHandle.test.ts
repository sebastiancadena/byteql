// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ResizeHandle from './ResizeHandle.svelte';

afterEach(cleanup);

function baseProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    orientation: 'horizontal' as const,
    direction: 1 as const,
    value: 116,
    min: 80,
    max: 400,
    label: 'Resize the query editor',
    controls: 'query-panel',
    onstart: vi.fn(),
    onpreview: vi.fn(),
    oncommit: vi.fn(),
    oncancel: vi.fn(),
    onreset: vi.fn(),
    ...overrides,
  };
}

describe('ResizeHandle', () => {
  it('renders a separator with the controlled ARIA value and controls', () => {
    render(ResizeHandle, baseProps({ value: 150 }));
    const separator = screen.getByRole('separator', { name: 'Resize the query editor' });
    expect(separator.getAttribute('aria-controls')).toBe('query-panel');
    expect(separator.getAttribute('aria-valuenow')).toBe('150');
    expect(separator.getAttribute('aria-valuemin')).toBe('80');
    expect(separator.getAttribute('aria-valuemax')).toBe('400');
  });

  it('rounds fractional controlled values in the ARIA attributes', () => {
    render(ResizeHandle, baseProps({ value: 150.6, min: 80.2, max: 400.4 }));
    const separator = screen.getByRole('separator', { name: 'Resize the query editor' });
    expect(separator.getAttribute('aria-valuenow')).toBe('151');
    expect(separator.getAttribute('aria-valuemin')).toBe('80');
    expect(separator.getAttribute('aria-valuemax')).toBe('400');
  });

  it('exposes its orientation as an ARIA and data attribute', () => {
    render(ResizeHandle, baseProps({ orientation: 'vertical' }));
    const separator = screen.getByRole('separator', { name: 'Resize the query editor' });
    expect(separator.getAttribute('aria-orientation')).toBe('vertical');
    expect(separator.getAttribute('data-orientation')).toBe('vertical');
    expect(separator.getAttribute('aria-valuetext')).toBe('116 pixels wide');
  });

  it('describes a horizontal separator as high, not wide', () => {
    render(ResizeHandle, baseProps({ orientation: 'horizontal' }));
    const separator = screen.getByRole('separator', { name: 'Resize the query editor' });
    expect(separator.getAttribute('aria-valuetext')).toBe('116 pixels high');
  });

  it('updates the rendered value when the controlled prop changes', async () => {
    const { rerender } = render(ResizeHandle, baseProps({ value: 116 }));
    const separator = screen.getByRole('separator', { name: 'Resize the query editor' });
    expect(separator.getAttribute('aria-valuenow')).toBe('116');

    await rerender(baseProps({ value: 200 }));
    expect(separator.getAttribute('aria-valuenow')).toBe('200');
  });

  it('is not tabbable while disabled', () => {
    render(ResizeHandle, baseProps({ disabled: true }));
    const separator = screen.getByRole('separator', { name: 'Resize the query editor' });
    expect(separator.getAttribute('tabindex')).toBe('-1');
    expect(separator.getAttribute('aria-disabled')).toBe('true');
  });

  it('is tabbable when enabled', () => {
    render(ResizeHandle, baseProps());
    const separator = screen.getByRole('separator', { name: 'Resize the query editor' });
    expect(separator.getAttribute('tabindex')).toBe('0');
    expect(separator.hasAttribute('aria-disabled')).toBe(false);
  });
});
