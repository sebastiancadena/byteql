import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const kaitaiBrowserStub = new URL('./src/workers/kaitai-browser-stub.ts', import.meta.url).pathname;

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: [
      { find: 'iconv-lite', replacement: kaitaiBrowserStub },
      { find: 'zlib', replacement: kaitaiBrowserStub },
    ],
  },
});
