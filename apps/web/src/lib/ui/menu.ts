/**
 * Keyboard and dismissal behavior for a popover menu. A menu is not modal: it roves focus among
 * its own items and never traps Tab — use `containFocus` for drawers and dialogs instead.
 *
 * Returns a cleanup that removes the listeners and returns focus to the opener, unless the
 * selected action has already moved focus somewhere outside the menu.
 */
export function popoverMenu(menu: HTMLElement, onclose: () => void): () => void {
  const active = document.activeElement;
  // `document.body` is "nothing was focused", not an opener to return focus to or to treat as
  // part of the menu's own subtree.
  const opener = active instanceof HTMLElement && active !== document.body ? active : null;

  const items = (): HTMLElement[] =>
    Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));

  function focusAt(index: number): void {
    const all = items();
    if (all.length === 0) return;
    // Wrap, so arrowing past either end continues around the menu.
    all[((index % all.length) + all.length) % all.length]!.focus();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
      return;
    }
    const all = items();
    const current = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') focusAt(current + 1);
    else if (event.key === 'ArrowUp') focusAt(current - 1);
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(all.length - 1);
    else return;
    event.preventDefault();
  }

  function onPointerdown(event: PointerEvent): void {
    const target = event.target as Node | null;
    if (target && !menu.contains(target) && !opener?.contains(target)) onclose();
  }

  menu.addEventListener('keydown', onKeydown);
  document.addEventListener('pointerdown', onPointerdown, true);
  items()[0]?.focus();

  return () => {
    menu.removeEventListener('keydown', onKeydown);
    document.removeEventListener('pointerdown', onPointerdown, true);
    if (!opener?.isConnected) return;
    // Closing the menu unmounts it, so focus has usually already fallen to the body by now.
    // Restore it — unless a chosen action deliberately moved focus to its destination.
    const active = document.activeElement;
    const orphaned = active === null || active === document.body;
    if (orphaned || menu.contains(active)) opener.focus();
  };
}
