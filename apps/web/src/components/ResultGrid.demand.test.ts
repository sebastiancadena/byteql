// @vitest-environment jsdom

import { fireEvent, render } from '@testing-library/svelte';
import { tableFromArrays } from 'apache-arrow';
import { readable } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const virtualizer = {
  getTotalSize: () => 100 * 36,
  getVirtualItems: () => [{ index: 0, key: '0', start: 0, size: 36, end: 36, lane: 0 }],
  scrollToIndex: vi.fn(),
  setOptions: vi.fn(),
};

vi.mock('@tanstack/svelte-virtual', () => ({
  createVirtualizer: () => readable(virtualizer),
}));

import ResultGrid from './ResultGrid.svelte';

Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get() {
    return this.classList.contains('grid-scroll') ? 360 : 0;
  },
});

describe('ResultGrid demand guard', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;

  const flushFrames = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  };

  beforeEach(() => {
    nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const handle = ++nextFrame;
      frames.set(handle, callback);
      return handle;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      frames.delete(handle);
    });
  });

  afterEach(() => {
    frames.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses physical tail movement to distinguish demand when virtual items are stale', async () => {
    const onloadmore = vi.fn();
    const { container } = render(ResultGrid, {
      table: tableFromArrays({ value: Int32Array.from({ length: 100 }, (_, index) => index) }),
      windowStart: 0,
      loadedRows: 100,
      complete: false,
      loadingMore: false,
      pageError: null,
      pageErrorRetryable: false,
      onselect: vi.fn(),
      onloadmore,
      onloadwindow: vi.fn(),
      onretry: vi.fn(),
    });
    flushFrames();

    const scroll = container.querySelector('.grid-scroll') as HTMLElement;
    scroll.scrollTop = 92 * 36;
    await fireEvent.scroll(scroll);
    flushFrames();

    scroll.scrollTop = 93 * 36;
    await fireEvent.scroll(scroll);
    flushFrames();

    expect(onloadmore).toHaveBeenCalledTimes(2);
  });
  it('does not demand backward from the scroll position a forward rebase just wrote', async () => {
    const onloadwindow = vi.fn();
    const table = tableFromArrays({ value: Int32Array.from({ length: 200 }, (_, index) => index) });
    const { container, rerender } = render(ResultGrid, {
      table,
      windowStart: 100,
      loadedRows: 1000,
      complete: true,
      loadingMore: false,
      pageError: null,
      pageErrorRetryable: false,
      onselect: vi.fn(),
      onloadmore: vi.fn(),
      onloadwindow,
      onretry: vi.fn(),
    });

    // Park mid-window before the first inspection: far from either edge, so nothing is demanded.
    const scroll = container.querySelector('.grid-scroll') as HTMLElement;
    scroll.scrollTop = 50 * 36;
    await fireEvent.scroll(scroll);
    flushFrames();
    expect(onloadwindow).not.toHaveBeenCalled();

    // An explicit forward jump. Scroll compensation keeps the same global row in view, which
    // for this jump means scrollTop 0 — the top of the new window. That position is the grid's
    // own write, not the user asking for earlier rows, so it must not demand backward.
    await rerender({ windowStart: 150 });
    flushFrames();
    expect(scroll.scrollTop).toBe(0);
    expect(onloadwindow).not.toHaveBeenCalled();

    // The reader then actually moves. Still inside the top edge band, so backward paging
    // resumes normally — the gate only ignores the position the rebase itself wrote.
    scroll.scrollTop = 5 * 36;
    await fireEvent.scroll(scroll);
    flushFrames();
    expect(onloadwindow).toHaveBeenCalledWith(149);
  });
});
