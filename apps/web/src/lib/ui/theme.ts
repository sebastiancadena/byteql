export type Theme = 'light' | 'dark';

export const THEME_KEY = 'byteql.ui.theme.v1';

type ThemeReader = Pick<Storage, 'getItem'>;
type ThemeWriter = Pick<Storage, 'setItem'>;

/** Light is the default appearance; only an exact stored `dark` selects the dark palette. */
export function readTheme(storage: ThemeReader | null): Theme {
  try {
    return storage?.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme: Theme, root: HTMLElement, storage: ThemeWriter | null): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  try {
    storage?.setItem(THEME_KEY, theme);
  } catch {
    // Preference is optional.
  }
}
