import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const kaitaiBrowserStub = new URL('./src/workers/kaitai-browser-stub.ts', import.meta.url).pathname;
const parseWorkerInlineSuffix = '/src/workers/parse.worker.ts?worker&inline';

const dataUrlParseWorker = {
  name: 'byteql-data-url-parse-worker',
  enforce: 'post' as const,
  transform(code: string, id: string) {
    if (process.env.VITEST || !id.endsWith(parseWorkerInlineSuffix)) return;
    const wrapperStart = code.indexOf('\nconst blob =');
    if (wrapperStart < 0) {
      throw new Error('Vite did not emit the expected inline parse-worker wrapper.');
    }
    return `${code.slice(0, wrapperStart)}
const workerDataUrl = "data:text/javascript;charset=utf-8," + encodeURIComponent(jsContent);
export default function WorkerWrapper(options) {
  return new Worker(workerDataUrl, { name: options?.name });
}
`;
  },
};

export default defineConfig({
  plugins: [svelte(), dataUrlParseWorker],
  resolve: {
    alias: [
      { find: 'iconv-lite', replacement: kaitaiBrowserStub },
      { find: 'zlib', replacement: kaitaiBrowserStub },
    ],
  },
});
