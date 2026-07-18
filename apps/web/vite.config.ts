import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const kaitaiBrowserStub = new URL('./src/workers/kaitai-browser-stub.ts', import.meta.url).pathname;
const parseWorkerInlineSuffix = '/src/workers/parse.worker.ts?worker&inline';
const jsContentPrefix = 'const jsContent = ';
const zlibImportBranch = /importScripts\(([A-Za-z_$][\w$]*)\.depUrls\.zlib\),\1\.zlib=pako/gu;
const zlibUnavailable = 'Kaitai zlib decompression is unavailable in the ByteQL browser worker.';

const dataUrlParseWorker = {
  name: 'byteql-data-url-parse-worker',
  apply: 'build' as const,
  enforce: 'post' as const,
  transform(code: string, id: string) {
    if (!id.endsWith(parseWorkerInlineSuffix)) return;
    const wrapperStart = code.indexOf('\nconst blob =');
    if (wrapperStart < 0) {
      throw new Error('Vite did not emit the expected inline parse-worker wrapper.');
    }
    const declaration = code.slice(0, wrapperStart).trim();
    if (!declaration.startsWith(jsContentPrefix) || !declaration.endsWith(';')) {
      throw new Error('Vite did not emit the expected inline parse-worker source declaration.');
    }

    const importScriptsCount = declaration.match(/importScripts\(/gu)?.length ?? 0;
    const zlibBranchCount = [...declaration.matchAll(zlibImportBranch)].length;
    if (importScriptsCount !== 1 || zlibBranchCount !== 1) {
      throw new Error(
        `Expected exactly one Kaitai zlib importScripts branch; found ${zlibBranchCount} matching branches and ${importScriptsCount} total importScripts calls.`,
      );
    }
    const safeDeclaration = declaration.replace(
      zlibImportBranch,
      `(()=>{throw new Error('${zlibUnavailable}')})()`,
    );

    return `${safeDeclaration}
const workerDataUrl = "data:text/javascript;charset=utf-8," + encodeURIComponent(jsContent);
export default function WorkerWrapper(options) {
  return new Worker(workerDataUrl, { name: options?.name });
}
`;
  },
};

export default defineConfig({
  define: {
    __BYTEQL_E2E__: JSON.stringify(process.env.BYTEQL_E2E === '1'),
  },
  plugins: [svelte(), dataUrlParseWorker],
  resolve: {
    conditions: ['browser'],
    alias: [
      { find: 'iconv-lite', replacement: kaitaiBrowserStub },
      { find: 'zlib', replacement: kaitaiBrowserStub },
    ],
  },
});
