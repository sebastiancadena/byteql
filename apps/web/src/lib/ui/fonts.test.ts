// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeFace {
  family: string;
  source: string;
  weight: string;
  load: () => Promise<FakeFace>;
}

let constructed: FakeFace[] = [];
let added: FakeFace[] = [];
let failingFamilies: string[] = [];

/** Install a FontFace stub. Nothing here touches the network — `load` is resolved locally. */
function installFontFace(): void {
  constructed = [];
  added = [];
  const FakeFontFace = function (
    this: FakeFace,
    family: string,
    source: string,
    descriptors: { weight: string },
  ) {
    this.family = family;
    this.source = source;
    this.weight = descriptors.weight;
    this.load = () =>
      failingFamilies.includes(`${family} ${descriptors.weight}`)
        ? Promise.reject(new Error('font unavailable'))
        : Promise.resolve(this);
    constructed.push(this);
  } as unknown as typeof FontFace;

  vi.stubGlobal('FontFace', FakeFontFace);
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: (face: FakeFace) => added.push(face) },
  });
}

async function loadModule(): Promise<typeof import('./fonts.js')> {
  vi.resetModules();
  return import('./fonts.js');
}

beforeEach(() => {
  failingFamilies = [];
  delete document.documentElement.dataset.fonts;
  installFontFace();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prepareUiFonts', () => {
  it('adds all three faces and reports loaded when every load succeeds', async () => {
    const { prepareUiFonts } = await loadModule();

    await expect(prepareUiFonts()).resolves.toBe('loaded');

    expect(constructed.map((face) => `${face.family} ${face.weight}`)).toEqual([
      'IBM Plex Sans 400',
      'IBM Plex Sans 600',
      'IBM Plex Mono 400',
    ]);
    expect(added).toHaveLength(3);
    expect(document.documentElement.dataset.fonts).toBe('loaded');
  });

  it('quotes the resolved asset URL in the source descriptor', async () => {
    const { prepareUiFonts } = await loadModule();
    await prepareUiFonts();

    for (const face of constructed) {
      expect(face.source).toMatch(/^url\(".+"\)$/u);
    }
  });

  it('falls back for the whole session when a single face fails', async () => {
    failingFamilies = ['IBM Plex Mono 400'];
    const { prepareUiFonts } = await loadModule();

    await expect(prepareUiFonts()).resolves.toBe('fallback');

    // All three loads were attempted and none was registered.
    expect(constructed).toHaveLength(3);
    expect(added).toEqual([]);
    expect(document.documentElement.dataset.fonts).toBe('fallback');
  });

  it('falls back when FontFace is unavailable', async () => {
    vi.stubGlobal('FontFace', undefined);
    const { prepareUiFonts } = await loadModule();

    await expect(prepareUiFonts()).resolves.toBe('fallback');
    expect(document.documentElement.dataset.fonts).toBe('fallback');
  });

  it('falls back when the document exposes no font set', async () => {
    Object.defineProperty(document, 'fonts', { configurable: true, value: undefined });
    const { prepareUiFonts } = await loadModule();

    await expect(prepareUiFonts()).resolves.toBe('fallback');
    expect(document.documentElement.dataset.fonts).toBe('fallback');
  });

  it('shares one promise across repeated calls', async () => {
    const { prepareUiFonts } = await loadModule();

    const first = prepareUiFonts();
    const second = prepareUiFonts();
    expect(second).toBe(first);

    await first;
    expect(prepareUiFonts()).toBe(first);
    // A retry reuses the settled result instead of requesting the faces again.
    expect(constructed).toHaveLength(3);
  });
});
