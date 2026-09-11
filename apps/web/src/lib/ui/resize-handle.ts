/**
 * Input mechanics for a resizable-panel separator: one active pointer transaction plus keyboard
 * stepping. This module is deliberately layout-agnostic — it knows nothing about panel geometry,
 * viewport bounds, or persistence; the caller supplies flat `min`/`max` numbers and owns every
 * committed value. See `ResizeHandle.svelte` for the thin ARIA markup that wires this in.
 */

const STEP = 18;
const SHIFT_STEP = 72;

export interface ResizeOptions {
  /** The ARIA orientation of the divider line itself, not the axis of pointer motion:
   * `'horizontal'` separators (a horizontal dividing line) read `clientY`; `'vertical'`
   * separators read `clientX`. */
  orientation: 'horizontal' | 'vertical';
  /** Sign from an increasing client coordinate to a growing primary pane. */
  direction: 1 | -1;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  /** Bumping this externally cancels any in-progress pointer transaction and releases its
   * action-owned pointer capture. */
  cancelEpoch?: number;
  onstart(): void;
  onpreview(value: number): void;
  oncommit(value: number): void;
  oncancel(): void;
  onreset(): void;
}

interface Transaction {
  pointerId: number;
  /** The client coordinate the current baseline was measured from. Rebased on clamp. */
  origin: number;
  /** The value the current baseline grows from. Rebased on clamp. */
  startValue: number;
  lastCoordinate: number;
}

function coordinateFor(orientation: ResizeOptions['orientation'], event: PointerEvent): number {
  return orientation === 'horizontal' ? event.clientY : event.clientX;
}

function cursorFor(orientation: ResizeOptions['orientation']): string {
  return orientation === 'horizontal' ? 'row-resize' : 'col-resize';
}

/**
 * A Svelte action that owns exactly one active pointer transaction (drag) and nothing else: all
 * bounds, geometry, storage, and commits belong to the caller via the options callbacks. The
 * action never imports layout or storage modules, so cancellation and clamping can be tested
 * without mounting any layout at all.
 */
export function resizeHandle(
  node: HTMLElement,
  initial: ResizeOptions,
): { update(next: ResizeOptions): void; destroy(): void } {
  let options = initial;
  let active: Transaction | null = null;
  let originalValue = 0;
  let originalCursor = '';
  let originalUserSelect = '';
  let pendingFrame: number | null = null;
  let pendingPreview = 0;

  function processCoordinate(coordinate: number): number {
    const tx = active;
    if (!tx) return options.value;
    const candidate = tx.startValue + options.direction * (coordinate - tx.origin);
    const next = Math.max(options.min, Math.min(options.max, candidate));
    // A clamped coordinate rebases the baseline so a reversal moves the pane immediately,
    // instead of first retracing the travel that was clamped away.
    if (next !== candidate) {
      tx.origin = coordinate;
      tx.startValue = next;
    }
    tx.lastCoordinate = coordinate;
    return next;
  }

  function attachDragListeners(): void {
    node.addEventListener('pointermove', onPointerMove);
    node.addEventListener('pointerup', onPointerUp);
    node.addEventListener('pointercancel', onPointerCancel);
    node.addEventListener('lostpointercapture', onLostPointerCapture);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  function detachDragListeners(): void {
    node.removeEventListener('pointermove', onPointerMove);
    node.removeEventListener('pointerup', onPointerUp);
    node.removeEventListener('pointercancel', onPointerCancel);
    node.removeEventListener('lostpointercapture', onLostPointerCapture);
    window.removeEventListener('blur', onWindowBlur);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  /** Ends the active transaction: marks it inactive, then releases capture and restores global
   * state. Deactivating first means a lost-capture event that follows a completed transaction
   * (successful commit or cancel) finds nothing active and cannot roll anything back. Callers
   * decide what, if anything, to report once this returns. */
  function teardown(): void {
    if (!active) return;
    const pointerId = active.pointerId;
    active = null;
    if (pendingFrame !== null) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
    }
    try {
      if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId);
    } catch {
      // Capture may already be gone (that is exactly what a lost-capture event tells us).
    } finally {
      detachDragListeners();
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
    }
  }

  /** The single idempotent cancel path for every terminal event that is not a normal pointerup:
   * lost capture, Escape, blur, visibility hidden, disable, cancelEpoch change, and destroy. */
  function cancelActive(): void {
    if (!active) return;
    teardown();
    options.oncancel();
  }

  function onPointerDown(event: PointerEvent): void {
    if (options.disabled || active) return;
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    node.focus({ preventScroll: true });
    try {
      node.setPointerCapture(event.pointerId);
    } catch {
      // Leaving nothing set up is itself the clean-up: no transaction, no styles, no listeners.
      return;
    }
    const coordinate = coordinateFor(options.orientation, event);
    originalValue = options.value;
    originalCursor = document.body.style.cursor;
    originalUserSelect = document.body.style.userSelect;
    active = {
      pointerId: event.pointerId,
      origin: coordinate,
      startValue: options.value,
      lastCoordinate: coordinate,
    };
    document.body.style.cursor = cursorFor(options.orientation);
    document.body.style.userSelect = 'none';
    attachDragListeners();
    options.onstart();
  }

  function onPointerMove(event: PointerEvent): void {
    if (!active || event.pointerId !== active.pointerId) return;
    const coordinate = coordinateFor(options.orientation, event);
    pendingPreview = processCoordinate(coordinate);
    if (pendingFrame !== null) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      if (!active) return;
      options.onpreview(pendingPreview);
    });
  }

  function onPointerUp(event: PointerEvent): void {
    if (!active || event.pointerId !== active.pointerId) return;
    if (pendingFrame !== null) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
    }
    const finalValue = processCoordinate(coordinateFor(options.orientation, event));
    const startedFrom = originalValue;
    options.onpreview(finalValue);
    teardown();
    // A transaction that ends exactly where it began must not turn a default/null preference
    // into a saved size — the coordinator should also treat it as having left its transaction.
    if (finalValue === startedFrom) options.oncancel();
    else options.oncommit(finalValue);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (!active || event.pointerId !== active.pointerId) return;
    cancelActive();
  }

  function onLostPointerCapture(event: Event): void {
    const pointerId = (event as PointerEvent).pointerId;
    if (!active || pointerId !== active.pointerId) return;
    cancelActive();
  }

  function onWindowBlur(): void {
    cancelActive();
  }

  function onVisibilityChange(): void {
    if (document.hidden) cancelActive();
  }

  function nextValueForKey(event: KeyboardEvent): number | null {
    if (event.key === 'Home') return options.min;
    if (event.key === 'End') return options.max;
    const increaseKey = options.orientation === 'horizontal' ? 'ArrowDown' : 'ArrowRight';
    const decreaseKey = options.orientation === 'horizontal' ? 'ArrowUp' : 'ArrowLeft';
    let sign: number;
    if (event.key === increaseKey) sign = 1;
    else if (event.key === decreaseKey) sign = -1;
    else return null;
    const magnitude = event.shiftKey ? SHIFT_STEP : STEP;
    const candidate = options.value + sign * magnitude * options.direction;
    return Math.max(options.min, Math.min(options.max, candidate));
  }

  function onKeydown(event: KeyboardEvent): void {
    if (options.disabled) return;
    if (event.key === 'Escape') {
      if (active) {
        event.preventDefault();
        cancelActive();
      }
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const next = nextValueForKey(event);
    if (next === null) return;
    event.preventDefault();
    if (next === options.value) return;
    options.onstart();
    options.onpreview(next);
    options.oncommit(next);
  }

  function onDblClick(): void {
    if (options.disabled) return;
    cancelActive();
    options.onreset();
  }

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('keydown', onKeydown);
  node.addEventListener('dblclick', onDblClick);

  function update(next: ResizeOptions): void {
    const epochChanged = next.cancelEpoch !== options.cancelEpoch;
    options = next;
    if (epochChanged) cancelActive();
    if (next.disabled) cancelActive();
  }

  function destroy(): void {
    cancelActive();
    node.removeEventListener('pointerdown', onPointerDown);
    node.removeEventListener('keydown', onKeydown);
    node.removeEventListener('dblclick', onDblClick);
  }

  return { update, destroy };
}
