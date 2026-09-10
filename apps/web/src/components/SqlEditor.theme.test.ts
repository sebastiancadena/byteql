import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import editorSource from './SqlEditor.svelte?raw';
import hexPaneSource from './HexPane.svelte?raw';

const tokensCss = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');

const editorColorTokens = [
  '--color-editor-text',
  '--color-editor-background',
  '--color-editor-caret',
  '--color-editor-selection',
  '--color-editor-gutter-text',
  '--color-editor-gutter-background',
  '--color-editor-border',
  '--color-editor-active-line',
  '--color-syntax-keyword',
  '--color-syntax-string',
  '--color-syntax-number',
  '--color-syntax-comment',
  '--color-syntax-operator',
  '--color-syntax-name',
  '--color-syntax-invalid',
] as const;

/** Extract the declarations of one top-level rule, keyed by custom-property name. */
function declarations(selector: string): Map<string, string> {
  const start = tokensCss.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing rule: ${selector}`);
  const open = tokensCss.indexOf('{', start);
  const close = tokensCss.indexOf('\n}', open);
  if (close < 0) throw new Error(`Unterminated rule: ${selector}`);
  const entries = new Map<string, string>();
  for (const line of tokensCss.slice(open + 1, close).split('\n')) {
    const match = /^\s*(--[\w-]+):\s*(.+);\s*$/u.exec(line);
    if (match?.[1] && match[2]) entries.set(match[1], match[2].trim());
  }
  return entries;
}

const lightDeclarations = declarations(':root');
const darkDeclarations = new Map([...lightDeclarations, ...declarations(":root[data-theme='dark']")]);

/** Resolve a token through simple `var(--other)` aliases down to a literal color. */
function resolve(palette: Map<string, string>, token: string, seen = new Set<string>()): string {
  if (seen.has(token)) throw new Error(`Circular token alias: ${token}`);
  seen.add(token);
  const value = palette.get(token);
  if (!value) throw new Error(`Missing CSS token: ${token}`);
  const alias = /^var\((--[\w-]+)\)$/u.exec(value);
  if (alias?.[1]) return resolve(palette, alias[1], seen);
  if (!/^#[\da-f]{6}$/iu.test(value)) throw new Error(`Token ${token} is not a plain color: ${value}`);
  return value;
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../gu)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  const [red, green, blue] = channels;
  if (red === undefined || green === undefined || blue === undefined) {
    throw new Error(`Invalid hexadecimal color: ${hex}`);
  }
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

const appearances = [
  ['light', lightDeclarations],
  ['dark', darkDeclarations],
] as const;

const textSurfaces = [
  '--color-canvas',
  '--color-surface',
  '--color-surface-inset',
  '--color-surface-raised',
  '--color-surface-hover',
  '--color-selection',
  '--color-hex-highlight',
] as const;

const syntaxTokens = [
  '--color-syntax-keyword',
  '--color-syntax-string',
  '--color-syntax-number',
  '--color-syntax-comment',
  '--color-syntax-operator',
  '--color-syntax-name',
  '--color-syntax-invalid',
] as const;

describe('SQL editor color contract', () => {
  it('sources every CodeMirror theme and token color from CSS custom properties', () => {
    expect(editorSource).not.toMatch(/#[\da-f]{3,8}\b/iu);

    for (const token of editorColorTokens) {
      expect(editorSource, token).toContain(`var(${token})`);
      expect(() => resolve(lightDeclarations, token), token).not.toThrow();
      expect(() => resolve(darkDeclarations, token), token).not.toThrow();
    }
  });

  it('defines the Trace Workspace palette in both appearances without Command Deck colors', () => {
    expect(tokensCss).toContain(":root[data-theme='dark']");
    expect(tokensCss).not.toContain('#36c2ff');
    expect(tokensCss).not.toContain('#55d8be');
    expect(tokensCss).not.toMatch(/--color-(canvas-glow|header-glass|accent-halo|accent-wash|accent-dim)\b/u);
    for (const token of ['--color-evidence', '--color-warning', '--color-success'] as const) {
      expect(resolve(lightDeclarations, token)).not.toBe(resolve(darkDeclarations, token));
    }
  });
});

describe.each(appearances)('%s appearance contrast', (appearance, palette) => {
  const ratio = (foreground: string, background: string): number =>
    contrastRatio(resolve(palette, foreground), resolve(palette, background));

  it.each(textSurfaces)('keeps subtle metadata readable on %s', (surface) => {
    expect(ratio('--color-text-subtle', surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--color-text-muted', surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--color-text', surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(syntaxTokens)('keeps %s readable on the editor bed and its active line', (token) => {
    expect(ratio(token, '--color-editor-background')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token, '--color-editor-active-line')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the gutter readable', () => {
    expect(ratio('--color-editor-gutter-text', '--color-editor-gutter-background')).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(ratio('--color-editor-gutter-text', '--color-editor-active-line')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps state text readable on its own surface', () => {
    expect(ratio('--color-danger', '--color-danger-surface')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--color-warning', '--color-warning-surface')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--color-success', '--color-surface')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps primary action text readable on its fill', () => {
    expect(ratio('--color-accent-ink', '--color-accent')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--color-accent-ink', '--color-accent-strong')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the evidence color readable wherever a trace range is shown', () => {
    for (const surface of [
      '--color-canvas',
      '--color-surface',
      '--color-surface-inset',
      '--color-selection',
    ] as const) {
      expect(ratio('--color-evidence', surface), surface).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps focus rings and control boundaries visible against adjacent surfaces', () => {
    for (const surface of [
      '--color-canvas',
      '--color-surface',
      '--color-surface-inset',
      '--color-surface-raised',
      '--color-surface-hover',
    ] as const) {
      expect(ratio('--color-focus', surface), `focus on ${surface}`).toBeGreaterThanOrEqual(3);
      expect(ratio('--color-border-strong', surface), `border on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('hex canvas fallbacks', () => {
  it('falls back to the light palette rather than the removed Command Deck colors', () => {
    for (const [token, expected] of [
      ['--color-surface-inset', '--color-surface-inset'],
      ['--color-text-subtle', '--color-text-subtle'],
      ['--color-text', '--color-text'],
      ['--color-text-muted', '--color-text-muted'],
      ['--color-hex-selection', '--color-hex-selection'],
      ['--color-focus', '--color-focus'],
    ] as const) {
      expect(hexPaneSource).toContain(
        `readColor(style, '${token}') || '${resolve(lightDeclarations, expected)}'`,
      );
    }
    expect(hexPaneSource).not.toContain('--color-accent-wash');
    expect(hexPaneSource).not.toContain('#1e558a');
  });
});
