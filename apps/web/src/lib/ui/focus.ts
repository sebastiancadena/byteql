const SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard containment for a modal surface: a drawer or dialog that covers the workspace.
 * Popover menus must not use this — they are not modal, they only rove focus among their items.
 *
 * Returns a cleanup that removes the listener and restores focus to whatever was focused before,
 * as long as that element is still in the document.
 */
export function containFocus(panel: HTMLElement, onescape: () => void): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // Recomputed per keystroke: a modal's contents change while it is open.
  const focusable = (): HTMLElement[] =>
    Array.from(panel.querySelectorAll<HTMLElement>(SELECTOR)).filter(
      (node) => !node.closest('[hidden], [inert]') && node.getClientRects().length > 0,
    );

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      onescape();
      return;
    }
    if (event.key !== 'Tab') return;

    const items = focusable();
    if (items.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  panel.addEventListener('keydown', onKeydown);

  const initial = focusable()[0];
  if (initial) {
    initial.focus();
  } else {
    panel.tabIndex = -1;
    panel.focus();
  }

  return () => {
    panel.removeEventListener('keydown', onKeydown);
    if (previous?.isConnected) previous.focus();
  };
}
