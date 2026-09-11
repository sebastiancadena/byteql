// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resizeHandle, type ResizeOptions } from './resize-handle.js';

/** jsdom has no PointerEvent constructor; the fields the action reads are defined by hand. */
function pointer(
  target: HTMLElement,
  type: string,
  coords: { x?: number; y?: number; pointerId?: number; isPrimary?: boolean; button?: number },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: coords.pointerId ?? 7 },
    isPrimary: { value: coords.isPrimary ?? true },
    button: { value: coords.button ?? 0 },
    clientX: { value: coords.x ?? 0 },
    clientY: { value: coords.y ?? 0 },
  });
  target.dispatchEvent(event);
}

interface Spies {
  onstart: ReturnType<typeof vi.fn<() => void>>;
  onpreview: ReturnType<typeof vi.fn<(value: number) => void>>;
  oncommit: ReturnType<typeof vi.fn<(value: number) => void>>;
  oncancel: ReturnType<typeof vi.fn<() => void>>;
  onreset: ReturnType<typeof vi.fn<() => void>>;
}

function spies(): Spies {
  return {
    onstart: vi.fn<() => void>(),
    onpreview: vi.fn<(value: number) => void>(),
    oncommit: vi.fn<(value: number) => void>(),
    oncancel: vi.fn<() => void>(),
    onreset: vi.fn<() => void>(),
  };
}

/** Builds an attached element with pointer-capture methods mocked, since jsdom has none. */
function buildHandle(): HTMLElement {
  const handle = document.createElement('div');
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = vi.fn(() => true);
  handle.releasePointerCapture = vi.fn();
  document.body.append(handle);
  return handle;
}

function baseOptions(spy: Spies, overrides: Partial<ResizeOptions> = {}): ResizeOptions {
  return {
    orientation: 'horizontal',
    direction: 1,
    value: 116,
    min: 80,
    max: 400,
    onstart: spy.onstart,
    onpreview: spy.onpreview,
    oncommit: spy.oncommit,
    oncancel: spy.oncancel,
    onreset: spy.onreset,
    ...overrides,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  document.body.style.cssText = '';
});

describe('resizeHandle pointer transactions', () => {
  it('commits from the pointerup coordinate without waiting for the queued frame', () => {
    const previews: number[] = [];
    const commits: number[] = [];
    const handle = document.createElement('div');
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();
    document.body.append(handle);
    const action = resizeHandle(handle, {
      orientation: 'horizontal',
      direction: 1,
      value: 116,
      min: 80,
      max: 400,
      onstart: vi.fn<() => void>(),
      onpreview: (value) => previews.push(value),
      oncommit: (value) => commits.push(value),
      oncancel: vi.fn<() => void>(),
      onreset: vi.fn<() => void>(),
    });
    function firePointer(type: string, y: number): void {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        pointerId: { value: 7 },
        isPrimary: { value: true },
        button: { value: 0 },
        clientX: { value: 0 },
        clientY: { value: y },
      });
      handle.dispatchEvent(event);
    }
    firePointer('pointerdown', 100);
    firePointer('pointermove', 150);
    firePointer('pointerup', 200); // do not advance the queued animation frame
    expect(commits).toEqual([216]);
    action.destroy();
    handle.remove();
  });

  it('ignores a right-button pointerdown', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    pointer(handle, 'pointerdown', { y: 100, button: 2 });
    expect(spy.onstart).not.toHaveBeenCalled();
    expect(handle.setPointerCapture).not.toHaveBeenCalled();

    action.destroy();
  });

  it('ignores a non-primary pointer', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    pointer(handle, 'pointerdown', { y: 100, isPrimary: false });
    expect(spy.onstart).not.toHaveBeenCalled();

    action.destroy();
  });

  it('ignores pointermove and pointerup from a different pointerId', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    pointer(handle, 'pointerdown', { y: 100, pointerId: 7 });
    pointer(handle, 'pointermove', { y: 150, pointerId: 9 });
    pointer(handle, 'pointerup', { y: 200, pointerId: 9 });
    expect(spy.onpreview).not.toHaveBeenCalled();
    expect(spy.oncommit).not.toHaveBeenCalled();
    expect(spy.oncancel).not.toHaveBeenCalled();

    // The real pointer can still finish its own drag.
    pointer(handle, 'pointerup', { y: 200, pointerId: 7 });
    expect(spy.oncommit).toHaveBeenCalledWith(216);

    action.destroy();
  });

  it('reads clientX for vertical separators', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(
      handle,
      baseOptions(spy, { orientation: 'vertical', direction: 1, value: 224, min: 192, max: 420 }),
    );

    pointer(handle, 'pointerdown', { x: 300 });
    pointer(handle, 'pointerup', { x: 340 });
    expect(spy.oncommit).toHaveBeenCalledWith(264);

    action.destroy();
  });

  it('inverts pointer motion when direction is -1', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy, { direction: -1, value: 200, min: 100, max: 400 }));

    pointer(handle, 'pointerdown', { y: 100 });
    pointer(handle, 'pointerup', { y: 150 }); // +50 client, direction -1 -> -50
    expect(spy.oncommit).toHaveBeenCalledWith(150);

    action.destroy();
  });

  it('clamps the candidate at the minimum', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy, { value: 100, min: 80, max: 400 }));

    pointer(handle, 'pointerdown', { y: 100 });
    pointer(handle, 'pointerup', { y: -500 });
    expect(spy.oncommit).toHaveBeenCalledWith(80);

    action.destroy();
  });

  it('clamps the candidate at the maximum', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy, { value: 100, min: 80, max: 400 }));

    pointer(handle, 'pointerdown', { y: 100 });
    pointer(handle, 'pointerup', { y: 5000 });
    expect(spy.oncommit).toHaveBeenCalledWith(400);

    action.destroy();
  });

  it('rebases on the clamp so reversing 10px moves the pane immediately', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy, { value: 100, min: 80, max: 400 }));

    pointer(handle, 'pointerdown', { y: 100 });
    // Overshoots the max; origin/startValue rebase to (200, 400).
    pointer(handle, 'pointermove', { y: 900 });
    // Reversing by 10px from the rebased origin moves the pane immediately, no dead travel.
    pointer(handle, 'pointerup', { y: 890 });
    expect(spy.oncommit).toHaveBeenCalledWith(390);

    action.destroy();
  });

  it('does not rebase merely because controlled props update mid-drag', () => {
    const spy = spies();
    const handle = buildHandle();
    const options = baseOptions(spy, { value: 116, min: 80, max: 400 });
    const action = resizeHandle(handle, options);

    pointer(handle, 'pointerdown', { y: 100 });
    // A controlled value update mid-drag must not become the new drag baseline.
    action.update({ ...options, value: 300 });
    pointer(handle, 'pointerup', { y: 150 });
    // Still computed from the original startValue (116) and origin (100), not 300.
    expect(spy.oncommit).toHaveBeenCalledWith(166);

    action.destroy();
  });

  it('uses the latest bounds from update without touching origin/startValue', () => {
    const spy = spies();
    const handle = buildHandle();
    const options = baseOptions(spy, { value: 116, min: 80, max: 400 });
    const action = resizeHandle(handle, options);

    pointer(handle, 'pointerdown', { y: 100 });
    // Tighten max mid-drag.
    action.update({ ...options, max: 140 });
    pointer(handle, 'pointerup', { y: 200 }); // candidate would be 216, now clamped to 140
    expect(spy.oncommit).toHaveBeenCalledWith(140);

    action.destroy();
  });

  it('cancels instead of committing a no-motion transaction', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy, { value: 116 }));

    pointer(handle, 'pointerdown', { y: 100 });
    pointer(handle, 'pointerup', { y: 100 });
    expect(spy.oncommit).not.toHaveBeenCalled();
    expect(spy.oncancel).toHaveBeenCalledOnce();

    action.destroy();
  });

  it('snapshots and restores the original body cursor and user-select', () => {
    const spy = spies();
    const handle = buildHandle();
    document.body.style.cursor = 'text';
    document.body.style.userSelect = 'contain';
    const action = resizeHandle(handle, baseOptions(spy));

    pointer(handle, 'pointerdown', { y: 100 });
    expect(document.body.style.cursor).not.toBe('text');
    pointer(handle, 'pointerup', { y: 150 });
    expect(document.body.style.cursor).toBe('text');
    expect(document.body.style.userSelect).toBe('contain');

    action.destroy();
  });

  it('captures the pointer and calls onstart exactly once on pointerdown', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    pointer(handle, 'pointerdown', { y: 100 });
    expect(handle.setPointerCapture).toHaveBeenCalledWith(7);
    expect(spy.onstart).toHaveBeenCalledOnce();

    pointer(handle, 'pointerup', { y: 150 });
    action.destroy();
  });

  it('ignores a second pointerdown while a transaction is already active', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    pointer(handle, 'pointerdown', { y: 100, pointerId: 7 });
    pointer(handle, 'pointerdown', { y: 999, pointerId: 8 });
    expect(spy.onstart).toHaveBeenCalledOnce();

    pointer(handle, 'pointerup', { y: 150, pointerId: 7 });
    action.destroy();
  });

  it('does not start a transaction when disabled', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy, { disabled: true }));

    pointer(handle, 'pointerdown', { y: 100 });
    expect(spy.onstart).not.toHaveBeenCalled();

    action.destroy();
  });

  it('cancels and cleans up when pointer capture throws', () => {
    const spy = spies();
    const handle = buildHandle();
    handle.setPointerCapture = vi.fn(() => {
      throw new DOMException('no capture', 'InvalidStateError');
    });
    const action = resizeHandle(handle, baseOptions(spy));

    expect(() => pointer(handle, 'pointerdown', { y: 100 })).not.toThrow();
    expect(spy.onstart).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe('');

    // No transaction was created, so a stray move/up does nothing.
    pointer(handle, 'pointermove', { y: 150 });
    pointer(handle, 'pointerup', { y: 150 });
    expect(spy.onpreview).not.toHaveBeenCalled();
    expect(spy.oncommit).not.toHaveBeenCalled();

    action.destroy();
  });
});

describe('resizeHandle keyboard handling', () => {
  function keydown(
    target: HTMLElement,
    key: string,
    modifiers: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {},
  ): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    });
    target.dispatchEvent(event);
    return event;
  }

  it('steps the horizontal separator with ArrowDown/ArrowUp by 18px', () => {
    const spy = spies();
    const handle = buildHandle();
    const options = baseOptions(spy, { value: 116, min: 80, max: 400 });
    const action = resizeHandle(handle, options);

    keydown(handle, 'ArrowDown');
    expect(spy.oncommit).toHaveBeenLastCalledWith(134);
    expect(spy.onstart).toHaveBeenCalledOnce();
    expect(spy.onpreview).toHaveBeenLastCalledWith(134);

    // The caller is the source of truth for `value`; it feeds the committed size back in.
    action.update({ ...options, value: 134 });
    keydown(handle, 'ArrowUp');
    expect(spy.oncommit).toHaveBeenLastCalledWith(116);

    action.destroy();
  });

  it('steps the vertical separator with ArrowRight/ArrowLeft by 18px', () => {
    const spy = spies();
    const handle = buildHandle();
    const options = baseOptions(spy, { orientation: 'vertical', value: 224, min: 192, max: 420 });
    const action = resizeHandle(handle, options);

    keydown(handle, 'ArrowRight');
    expect(spy.oncommit).toHaveBeenLastCalledWith(242);

    action.update({ ...options, value: 242 });
    keydown(handle, 'ArrowLeft');
    expect(spy.oncommit).toHaveBeenLastCalledWith(224);

    action.destroy();
  });

  it('multiplies the step by direction', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy, { direction: -1, value: 200, min: 100, max: 400 }));

    keydown(handle, 'ArrowDown');
    expect(spy.oncommit).toHaveBeenLastCalledWith(182);

    action.destroy();
  });

  it('steps by 72px with Shift held', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy, { value: 116, min: 80, max: 400 }));

    keydown(handle, 'ArrowDown', { shiftKey: true });
    expect(spy.oncommit).toHaveBeenLastCalledWith(188);

    action.destroy();
  });

  it('sends Home to the minimum and End to the maximum regardless of direction', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy, { direction: -1, value: 116, min: 80, max: 400 }));

    keydown(handle, 'Home');
    expect(spy.oncommit).toHaveBeenLastCalledWith(80);
    keydown(handle, 'End');
    expect(spy.oncommit).toHaveBeenLastCalledWith(400);

    action.destroy();
  });

  it('clamps a keyboard step at the bounds', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy, { value: 390, min: 80, max: 400 }));

    keydown(handle, 'ArrowDown', { shiftKey: true });
    expect(spy.oncommit).toHaveBeenLastCalledWith(400);

    action.destroy();
  });

  it('does not commit a keyboard step that would not change the value', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy, { value: 400, min: 80, max: 400 }));

    const event = keydown(handle, 'ArrowDown');
    expect(event.defaultPrevented).toBe(true);
    expect(spy.oncommit).not.toHaveBeenCalled();
    expect(spy.onstart).not.toHaveBeenCalled();

    action.destroy();
  });

  it('ignores unrelated keys without preventing default', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    const event = keydown(handle, 'a');
    expect(event.defaultPrevented).toBe(false);
    expect(spy.oncommit).not.toHaveBeenCalled();

    action.destroy();
  });

  it('ignores arrow keys combined with Ctrl, Alt, or Meta', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    for (const modifiers of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      const event = keydown(handle, 'ArrowDown', modifiers);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(spy.oncommit).not.toHaveBeenCalled();

    action.destroy();
  });

  it('does not interpret Enter as anything special', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    const event = keydown(handle, 'Enter');
    expect(event.defaultPrevented).toBe(false);
    expect(spy.oncommit).not.toHaveBeenCalled();
    expect(spy.onreset).not.toHaveBeenCalled();

    action.destroy();
  });

  it('cancels only an active pointer transaction on Escape', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    // No active transaction: Escape is a no-op.
    keydown(handle, 'Escape');
    expect(spy.oncancel).not.toHaveBeenCalled();

    pointer(handle, 'pointerdown', { y: 100 });
    const event = keydown(handle, 'Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(spy.oncancel).toHaveBeenCalledOnce();
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(7);

    // A subsequent pointerup for the cancelled pointer does nothing further.
    pointer(handle, 'pointerup', { y: 150 });
    expect(spy.oncommit).not.toHaveBeenCalled();
    expect(spy.oncancel).toHaveBeenCalledOnce();

    action.destroy();
  });

  it('resets via double-click after canceling any active transaction', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    pointer(handle, 'pointerdown', { y: 100 });
    handle.dispatchEvent(new Event('dblclick', { bubbles: true, cancelable: true }));
    expect(spy.oncancel).toHaveBeenCalledOnce();
    expect(spy.onreset).toHaveBeenCalledOnce();

    action.destroy();
  });

  it('resets via double-click with no active transaction', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    handle.dispatchEvent(new Event('dblclick', { bubbles: true, cancelable: true }));
    expect(spy.oncancel).not.toHaveBeenCalled();
    expect(spy.onreset).toHaveBeenCalledOnce();

    action.destroy();
  });
});

describe('resizeHandle terminal events', () => {
  it('cancels on pointercancel', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    pointer(handle, 'pointerdown', { y: 100 });
    pointer(handle, 'pointercancel', { y: 150 });
    expect(spy.oncancel).toHaveBeenCalledOnce();
    expect(spy.oncommit).not.toHaveBeenCalled();
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(7);

    action.destroy();
  });

  it('cancels on an unexpected loss of pointer capture', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    pointer(handle, 'pointerdown', { y: 100 });
    handle.dispatchEvent(Object.assign(new Event('lostpointercapture', { bubbles: true }), { pointerId: 7 }));
    expect(spy.oncancel).toHaveBeenCalledOnce();

    action.destroy();
  });

  it('does not re-cancel a lost-capture event that follows a successful pointerup', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy, { value: 116 }));

    pointer(handle, 'pointerdown', { y: 100 });
    pointer(handle, 'pointerup', { y: 200 });
    expect(spy.oncommit).toHaveBeenCalledWith(216);
    expect(spy.oncommit).toHaveBeenCalledOnce();

    expect(() =>
      handle.dispatchEvent(
        Object.assign(new Event('lostpointercapture', { bubbles: true }), { pointerId: 7 }),
      ),
    ).not.toThrow();
    expect(spy.oncancel).not.toHaveBeenCalled();
    expect(spy.oncommit).toHaveBeenCalledOnce();

    action.destroy();
  });

  it('is not rolled back by a lostpointercapture the browser fires synchronously from release', () => {
    // Real browsers dispatch lostpointercapture synchronously from inside releasePointerCapture,
    // while the drag-only listeners are still attached. Marking the transaction inactive first is
    // what keeps this from re-entering as a cancel of the commit that is still unwinding.
    const spy = spies();
    const handle = buildHandle();
    handle.releasePointerCapture = vi.fn((pointerId: number) => {
      handle.dispatchEvent(Object.assign(new Event('lostpointercapture', { bubbles: true }), { pointerId }));
    });
    const action = resizeHandle(handle, baseOptions(spy, { value: 116 }));

    pointer(handle, 'pointerdown', { y: 100 });
    pointer(handle, 'pointerup', { y: 200 });
    expect(spy.oncommit).toHaveBeenCalledExactlyOnceWith(216);
    expect(spy.oncancel).not.toHaveBeenCalled();

    action.destroy();
  });

  it('cancels on window blur', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    pointer(handle, 'pointerdown', { y: 100 });
    window.dispatchEvent(new Event('blur'));
    expect(spy.oncancel).toHaveBeenCalledOnce();

    action.destroy();
  });

  it('does not listen for blur once the drag has ended', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    pointer(handle, 'pointerdown', { y: 100 });
    pointer(handle, 'pointerup', { y: 150 });
    window.dispatchEvent(new Event('blur'));
    expect(spy.oncancel).not.toHaveBeenCalled();

    action.destroy();
  });

  it('cancels when the document becomes hidden', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    pointer(handle, 'pointerdown', { y: 100 });
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(spy.oncancel).toHaveBeenCalledOnce();

    action.destroy();
    vi.restoreAllMocks();
  });

  it('cancels an active drag when update marks it disabled', () => {
    const spy = spies();
    const handle = buildHandle();
    const options = baseOptions(spy);
    const action = resizeHandle(handle, options);

    pointer(handle, 'pointerdown', { y: 100 });
    action.update({ ...options, disabled: true });
    expect(spy.oncancel).toHaveBeenCalledOnce();

    // Further pointer motion for the cancelled transaction is ignored.
    pointer(handle, 'pointerup', { y: 150 });
    expect(spy.oncommit).not.toHaveBeenCalled();

    action.destroy();
  });

  it('cancels an active drag when cancelEpoch changes', () => {
    const spy = spies();
    const handle = buildHandle();
    const options = baseOptions(spy, { cancelEpoch: 1 });
    const action = resizeHandle(handle, options);

    pointer(handle, 'pointerdown', { y: 100 });
    action.update({ ...options, cancelEpoch: 2 });
    expect(spy.oncancel).toHaveBeenCalledOnce();
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(7);

    action.destroy();
  });

  it('does not cancel merely because update is called with the same cancelEpoch', () => {
    const spy = spies();
    const handle = buildHandle();
    const options = baseOptions(spy, { cancelEpoch: 1 });
    const action = resizeHandle(handle, options);

    pointer(handle, 'pointerdown', { y: 100 });
    action.update({ ...options, cancelEpoch: 1 });
    expect(spy.oncancel).not.toHaveBeenCalled();

    pointer(handle, 'pointerup', { y: 150 });
    action.destroy();
  });

  it('cancels an active drag and detaches all listeners on destroy', () => {
    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    pointer(handle, 'pointerdown', { y: 100 });
    action.destroy();
    expect(spy.oncancel).toHaveBeenCalledOnce();

    // Nothing survives: dispatching further events on the removed action is inert.
    pointer(handle, 'pointerup', { y: 150 });
    expect(spy.oncommit).not.toHaveBeenCalled();
    expect(spy.oncancel).toHaveBeenCalledOnce();
    // Keyboard handling is torn down too.
    const event = new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true });
    handle.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('idempotently no-ops a second cancel path with no active transaction', () => {
    function escape(target: HTMLElement): void {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    }

    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    pointer(handle, 'pointerdown', { y: 100 });
    pointer(handle, 'pointercancel', { y: 150 });
    expect(spy.oncancel).toHaveBeenCalledOnce();

    // A second terminal event with nothing active must not call oncancel again.
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new Event('visibilitychange'));
    escape(handle);
    expect(spy.oncancel).toHaveBeenCalledOnce();

    action.destroy();
  });

  it('leaves no pending preview callback after cleanup', () => {
    const queue = new Map<number, FrameRequestCallback>();
    let nextHandle = 0;
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      const handle = ++nextHandle;
      queue.set(handle, callback);
      return handle;
    });
    const cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((handle) => {
      queue.delete(handle);
    });

    const spy = spies();
    const handle = buildHandle();
    const action = resizeHandle(handle, baseOptions(spy));

    pointer(handle, 'pointerdown', { y: 100 });
    pointer(handle, 'pointermove', { y: 150 });
    expect(queue.size).toBe(1);

    action.destroy();
    expect(queue.size).toBe(0);

    // Even if something still held the callback, it must not call back into a torn-down action.
    for (const callback of queue.values()) callback(0);
    expect(spy.onpreview).not.toHaveBeenCalled();

    rafSpy.mockRestore();
    cafSpy.mockRestore();
  });
});
