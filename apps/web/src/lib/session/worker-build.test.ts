import { describe, expect, it } from 'vitest';
import { build } from 'vite';

describe('parse worker production bundle', () => {
  it('embeds the complete parser worker in the non-tree-shaken controller bundle', async () => {
    const webRoot = new URL('../../../', import.meta.url).pathname;
    const controllerEntry = new URL('./controller.ts', import.meta.url).pathname;

    const output = await build({
      root: webRoot,
      logLevel: 'silent',
      build: {
        write: false,
        rollupOptions: { input: controllerEntry },
      },
    });

    const builds = Array.isArray(output) ? output : [output];
    const artifacts = builds.flatMap((result) => ('output' in result ? result.output : []));
    const files = artifacts.map((item) => item.fileName);

    expect(files.some((file) => /parse\.worker-.*\.js$/u.test(file))).toBe(false);
    expect(files.some((file) => /controller-.*\.js$/u.test(file))).toBe(true);
  });
});
