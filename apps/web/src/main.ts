import { mount } from 'svelte';

import App from './App.svelte';
import './app.css';
import { applyTheme, readTheme } from './lib/ui/theme.js';

const target = document.getElementById('app');

if (!target) {
  throw new Error('Application mount target was not found');
}

// `localStorage` is a getter that throws outright when site data is blocked.
function readStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

const storage = readStorage();

applyTheme(readTheme(storage), document.documentElement, storage);

mount(App, { target });
