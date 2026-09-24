// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveTextFile } from './download.js';

describe('saveTextFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('writes through a save handle when the picker exists', async () => {
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn(async () => ({ createWritable: async () => ({ write, close }) })),
    );
    expect(await saveTextFile('a.sql', 'select 1')).toBe('saved');
    expect(write).toHaveBeenCalledWith('select 1');
    expect(close).toHaveBeenCalled();
  });

  it('reports a dismissed picker as cancelled', async () => {
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn(async () => Promise.reject(new DOMException('no', 'AbortError'))),
    );
    expect(await saveTextFile('a.sql', 'select 1')).toBe('cancelled');
  });

  it('falls back to an object-URL download and revokes it later', async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:local');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    expect(await saveTextFile('a.sql', 'select 1')).toBe('saved');
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local');
  });
});
