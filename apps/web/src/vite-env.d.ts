/// <reference types="vite/client" />

declare global {
  const __BYTEQL_E2E__: boolean;
  var __byteqlE2E: import('./lib/e2e-harness.js').BrowserE2EControl | undefined;

  interface Window {
    /**
     * File System Access API entry point (not yet in TypeScript's bundled DOM lib). Absent in
     * browsers/environments without support (e.g. Firefox, Safari, jsdom) — always feature-detect.
     */
    showOpenFilePicker?: () => Promise<FileSystemFileHandle[]>;
  }
}

export {};
