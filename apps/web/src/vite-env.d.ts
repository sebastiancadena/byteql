/// <reference types="vite/client" />

declare global {
  const __BYTEQL_E2E__: boolean;
  var __byteqlE2E: import('./lib/e2e-harness.js').BrowserE2EControl | undefined;
}

export {};
