import { memoryByteSource } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { createChunkWindow } from '../src/chunk-window.js';
import { normalizeLinktype } from '../src/container.js';

const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);

describe('createChunkWindow', () => {
  it('returns views into one chunk while reads stay inside it', async () => {
    const window = createChunkWindow(memoryByteSource(bytes), 32, 0);
    const first = await window.ensure(0, 8);
    const generation = window.generation;
    const second = await window.ensure(8, 8);
    expect(first.isChunkView).toBe(true);
    expect(second.isChunkView).toBe(true);
    expect(window.generation).toBe(generation);
    expect([...second.bytes]).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('reloads at the requested offset and bumps the generation when a read leaves the window', async () => {
    const window = createChunkWindow(memoryByteSource(bytes), 32, 0);
    await window.ensure(0, 8);
    const before = window.generation;
    const read = await window.ensure(30, 8);
    expect(window.generation).toBe(before + 1);
    expect([...read.bytes]).toEqual([30, 31, 32, 33, 34, 35, 36, 37]);
  });

  it('reads an oversized span directly, without touching the window', async () => {
    const window = createChunkWindow(memoryByteSource(bytes), 16, 0);
    await window.ensure(0, 4);
    const before = window.generation;
    const read = await window.ensure(10, 40);
    expect(read.isChunkView).toBe(false);
    expect(window.generation).toBe(before);
    expect(read.bytes).toHaveLength(40);
    expect(read.bytes[0]).toBe(10);
  });

  it('stable() copies a chunk view only when a reload happened since generationAtStart', async () => {
    const window = createChunkWindow(memoryByteSource(bytes), 32, 0);
    const start = window.generation;
    const inWindow = await window.ensure(0, 4);
    expect(window.stable(inWindow, start)).toBe(inWindow.bytes);
    const straddled = await window.ensure(30, 4);
    const copy = window.stable(straddled, start);
    expect(copy).not.toBe(straddled.bytes);
    expect([...copy]).toEqual([...straddled.bytes]);
  });
});

describe('normalizeLinktype', () => {
  it('maps raw IP 101 by version nibble and leaves others alone', () => {
    expect(normalizeLinktype(101, Uint8Array.of(0x45))).toBe(228);
    expect(normalizeLinktype(101, Uint8Array.of(0x60))).toBe(229);
    expect(normalizeLinktype(101, new Uint8Array(0))).toBe(229);
    expect(normalizeLinktype(1, Uint8Array.of(0x45))).toBe(1);
  });
});
