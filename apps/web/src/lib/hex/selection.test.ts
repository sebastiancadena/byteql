import { describe, expect, it } from 'vitest';

import { reduceSelection, selectionRange } from './selection.js';

describe('reduceSelection', () => {
  it('click sets a caret; shift-click extends from the anchor', () => {
    const caret = reduceSelection(null, { type: 'point', offset: 10, extend: false });
    expect(caret).toEqual({ anchor: 10, focus: 10 });
    const extended = reduceSelection(caret, { type: 'point', offset: 4, extend: true });
    expect(extended).toEqual({ anchor: 10, focus: 4 });
    expect(selectionRange(extended!)).toEqual({ start: 4, end: 11 });
  });

  it('drag moves the focus and keeps the anchor', () => {
    const start = reduceSelection(null, { type: 'point', offset: 8, extend: false });
    expect(reduceSelection(start, { type: 'drag', offset: 40 })).toEqual({ anchor: 8, focus: 40 });
  });

  it('move steps the caret, clamps to the file, and collapses unless extending', () => {
    const sel = { anchor: 4, focus: 8 };
    expect(reduceSelection(sel, { type: 'move', delta: 1, extend: false, fileSize: 100 })).toEqual({
      anchor: 9,
      focus: 9,
    });
    expect(reduceSelection(sel, { type: 'move', delta: 16, extend: true, fileSize: 20 })).toEqual({
      anchor: 4,
      focus: 19,
    });
    expect(reduceSelection(null, { type: 'move', delta: 1, extend: false, fileSize: 0 })).toBeNull();
    expect(reduceSelection(null, { type: 'move', delta: 1, extend: false, fileSize: 9 })).toEqual({
      anchor: 0,
      focus: 0,
    });
  });

  it('record selects a [start, end) range inclusively and clear clears', () => {
    expect(reduceSelection(null, { type: 'record', start: 82, end: 120 })).toEqual({
      anchor: 82,
      focus: 119,
    });
    expect(reduceSelection({ anchor: 1, focus: 2 }, { type: 'clear' })).toBeNull();
  });
});
