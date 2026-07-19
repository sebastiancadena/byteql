export interface HexSelection {
  anchor: number;
  focus: number;
}

export type SelectionAction =
  | { type: 'point'; offset: number; extend: boolean }
  | { type: 'drag'; offset: number }
  | { type: 'move'; delta: number; extend: boolean; fileSize: number }
  | { type: 'record'; start: number; end: number }
  | { type: 'clear' };

export const selectionRange = (selection: HexSelection): { start: number; end: number } => ({
  start: Math.min(selection.anchor, selection.focus),
  end: Math.max(selection.anchor, selection.focus) + 1,
});

export function reduceSelection(
  selection: HexSelection | null,
  action: SelectionAction,
): HexSelection | null {
  switch (action.type) {
    case 'point':
      if (action.extend && selection) return { anchor: selection.anchor, focus: action.offset };
      return { anchor: action.offset, focus: action.offset };
    case 'drag':
      if (!selection) return { anchor: action.offset, focus: action.offset };
      return { anchor: selection.anchor, focus: action.offset };
    case 'move': {
      if (action.fileSize === 0) return null;
      if (!selection) return { anchor: 0, focus: 0 };
      const focus = Math.max(0, Math.min(action.fileSize - 1, selection.focus + action.delta));
      return action.extend ? { anchor: selection.anchor, focus } : { anchor: focus, focus };
    }
    case 'record':
      if (action.end <= action.start) return selection;
      return { anchor: action.start, focus: action.end - 1 };
    case 'clear':
      return null;
  }
}
