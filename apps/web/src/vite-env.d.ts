/// <reference types="vite/client" />

declare global {
  const __BYTEQL_E2E__: boolean;
  var __byteqlE2E: import('./lib/e2e-harness.js').BrowserE2EControl | undefined;
  /**
   * Set via `page.addInitScript()` before `page.goto()` — read once, synchronously, when
   * `createBrowserE2EHarness()` builds its `control.sessionOverrides`. See the comment at that
   * call site in `./lib/e2e-harness.ts` for why this can't be set after navigation.
   */
  var __byteqlE2EOverrides: import('./lib/e2e-harness.js').SessionOverrides | undefined;

  interface Window {
    __BYTEQL_E2E__?: import('./lib/e2e-harness.js').BrowserE2EControl;
    /**
     * File System Access API entry point (not yet in TypeScript's bundled DOM lib). Absent in
     * browsers/environments without support (e.g. Firefox, Safari, jsdom) — always feature-detect.
     */
    showOpenFilePicker?: (options?: { multiple?: boolean }) => Promise<FileSystemFileHandle[]>;
  }
}

export {};
