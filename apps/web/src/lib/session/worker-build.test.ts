import process from 'node:process';

import { describe, expect, it } from 'vitest';
import { build, createServer, type ViteDevServer } from 'vite';

const webRoot = new URL('../../../', import.meta.url).pathname;

const artifactsFrom = (output: Awaited<ReturnType<typeof build>>) =>
  (Array.isArray(output) ? output : [output]).flatMap((result) => ('output' in result ? result.output : []));

describe('parse worker production bundle', () => {
  it('embeds the complete parser worker in the non-tree-shaken controller bundle', async () => {
    const controllerEntry = new URL('./controller.ts', import.meta.url).pathname;

    const output = await build({
      root: webRoot,
      logLevel: 'silent',
      build: {
        write: false,
        rollupOptions: { input: controllerEntry },
      },
    });

    const artifacts = artifactsFrom(output);
    const files = artifacts.map((item) => item.fileName);

    expect(files.some((file) => /parse\.worker-.*\.js$/u.test(file))).toBe(false);
    expect(files.some((file) => /controller-.*\.js$/u.test(file))).toBe(true);
  });

  it('loads the inline worker through the development transform without production rewriting', async () => {
    const originalVitest = process.env.VITEST;
    delete process.env.VITEST;
    let server: ViteDevServer | undefined;
    try {
      server = await createServer({
        root: webRoot,
        logLevel: 'silent',
        appType: 'custom',
        server: { middlewareMode: true },
      });

      const transformed = await server.transformRequest('/src/workers/parse.worker.ts?worker&inline');
      expect(transformed?.code).toContain('WorkerWrapper');
    } finally {
      await server?.close();
      if (originalVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = originalVitest;
    }
  });

  it('contains no network or dynamic-code primitive in the decoded production worker', async () => {
    const browserEntry = new URL('../../../worker-privacy.html', import.meta.url).pathname;
    const output = await build({
      root: webRoot,
      logLevel: 'silent',
      build: {
        write: false,
        rollupOptions: { input: browserEntry },
      },
    });
    const bundle = artifactsFrom(output)
      .flatMap((item) => ('code' in item ? [item.code] : []))
      .join('\n');
    const dataUrlPrefix = 'data:text/javascript;charset=utf-8,';
    const prefixStart = bundle.indexOf(dataUrlPrefix);
    expect(prefixStart).toBeGreaterThan(0);
    const delimiter = bundle[prefixStart - 1];
    expect(['"', "'", '`']).toContain(delimiter);
    const sourceStart = prefixStart + dataUrlPrefix.length;
    const sourceEnd = bundle.indexOf(delimiter!, sourceStart);
    expect(sourceEnd).toBeGreaterThan(sourceStart);
    const encodedSource = bundle.slice(sourceStart, sourceEnd);

    const workerSource = decodeURIComponent(encodedSource);
    expect(workerSource).toContain('Kaitai zlib decompression is unavailable in the ByteQL browser worker.');
    for (const forbidden of ['fetch(', 'importScripts(', 'eval(', 'new Function']) {
      expect(workerSource, forbidden).not.toContain(forbidden);
    }
  });
});
