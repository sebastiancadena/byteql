// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { containFocus } from './focus.js';

/** jsdom reports no client rects, so visible elements are given one explicitly. */
function makeVisible(element: Element): void {
  Object.defineProperty(element, 'getClientRects', {
    configurable: true,
    value: () => [{ width: 10, height: 10 }] as unknown as DOMRectList,
  });
}

function buildPanel(html: string): HTMLElement {
  const panel = document.createElement('div');
  panel.innerHTML = html;
  document.body.append(panel);
  for (const node of panel.querySelectorAll('button, a, input')) makeVisible(node);
  return panel;
}

function tab(target: Element, shift = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('containFocus', () => {
  it('moves focus into the panel and restores it on cleanup', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const panel = buildPanel('<button>first</button><button>last</button>');
    const release = containFocus(panel, () => undefined);

    expect(panel.contains(document.activeElement)).toBe(true);

    release();
    expect(document.activeElement).toBe(opener);
  });

  it('does not restore focus to an element that has left the document', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const panel = buildPanel('<button>only</button>');
    const release = containFocus(panel, () => undefined);
    opener.remove();

    expect(() => release()).not.toThrow();
  });

  it('reports Escape to the caller', () => {
    const onescape = vi.fn();
    const panel = buildPanel('<button>only</button>');
    const release = containFocus(panel, onescape);

    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onescape).toHaveBeenCalledOnce();
    release();
  });

  it('wraps Tab from the last focusable back to the first', () => {
    const panel = buildPanel('<button>first</button><button>middle</button><button>last</button>');
    const release = containFocus(panel, () => undefined);
    const [first, , last] = [...panel.querySelectorAll('button')] as HTMLElement[];

    last!.focus();
    const event = tab(last!);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    release();
  });

  it('wraps Shift+Tab from the first focusable back to the last', () => {
    const panel = buildPanel('<button>first</button><button>last</button>');
    const release = containFocus(panel, () => undefined);
    const [first, last] = [...panel.querySelectorAll('button')] as HTMLElement[];

    first!.focus();
    const event = tab(first!, true);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    release();
  });

  it('leaves Tab alone between interior elements', () => {
    const panel = buildPanel('<button>first</button><button>last</button>');
    const release = containFocus(panel, () => undefined);
    const [first] = [...panel.querySelectorAll('button')] as HTMLElement[];

    first!.focus();
    // Not at an edge in this direction: the browser's own order applies.
    expect(tab(first!).defaultPrevented).toBe(false);
    release();
  });

  it('ignores disabled, hidden and inert descendants', () => {
    const panel = buildPanel(
      '<button disabled>no</button><div hidden><button>no</button></div>' +
        '<div inert><button>no</button></div><button id="reachable">yes</button>',
    );
    const release = containFocus(panel, () => undefined);
    const reachable = panel.querySelector<HTMLElement>('#reachable')!;

    // The only candidate that is neither disabled, hidden nor inert takes initial focus.
    expect(document.activeElement).toBe(reachable);

    // A single focusable element wraps onto itself rather than letting focus escape.
    expect(tab(reachable).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(reachable);
    release();
  });

  it('keeps focus on an empty panel instead of letting it escape', () => {
    const panel = buildPanel('<p>nothing to focus</p>');
    const release = containFocus(panel, () => undefined);

    expect(document.activeElement).toBe(panel);
    expect(panel.getAttribute('tabindex')).toBe('-1');

    const event = tab(panel);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(panel);
    release();
  });

  it('stops containing focus once released', () => {
    const onescape = vi.fn();
    const panel = buildPanel('<button>only</button>');
    containFocus(panel, onescape)();

    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onescape).not.toHaveBeenCalled();
  });
});
