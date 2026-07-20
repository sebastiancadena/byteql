import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import editorSource from './SqlEditor.svelte?raw';
import hexPaneSource from './HexPane.svelte?raw';

const appCss = readFileSync(new URL('../app.css', import.meta.url), 'utf8');

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

const commandDeckTokens = [
  '--color-canvas',
  '--color-surface',
  '--color-surface-inset',
  '--color-surface-raised',
  '--color-accent',
  '--color-accent-dim',
  '--color-evidence',
] as const;

function cssHexToken(name: string): string {
  const value = appCss.match(new RegExp(`${name}:\\s*(#[\\da-f]{6})`, 'iu'))?.[1];
  if (!value) throw new Error(`Missing hexadecimal CSS token: ${name}`);
  return value;
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../gu)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
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

describe('SQL editor color contract', () => {
  it('sources every CodeMirror theme and token color from app CSS custom properties', () => {
    expect(editorSource).not.toMatch(/#[\da-f]{3,8}\b/iu);

    for (const token of editorColorTokens) {
      expect(editorSource, token).toContain(`var(${token})`);
      expect(appCss, token).toMatch(new RegExp(`${token}:\\s*#[\\da-f]{6}`, 'iu'));
    }
  });

  it('defines the Command Deck shell without the former mint accent', () => {
    for (const token of commandDeckTokens) expect(appCss).toContain(`${token}:`);
    expect(appCss).not.toContain('#55d8be');
  });

  it('keeps small theme text at WCAG AA contrast on every surface where it appears', () => {
    const pairs = [
      ['subtle text on canvas', '--color-text-subtle', '--color-canvas'],
      ['subtle text on base surface', '--color-text-subtle', '--color-surface'],
      ['subtle text on inset surface', '--color-text-subtle', '--color-surface-inset'],
      ['subtle text on raised surface', '--color-text-subtle', '--color-surface-raised'],
      ['subtle text on hovered row', '--color-text-subtle', '--color-surface-hover'],
      ['subtle text on selected row', '--color-text-subtle', '--color-selection'],
      [
        'editor gutter text on gutter background',
        '--color-editor-gutter-text',
        '--color-editor-gutter-background',
      ],
      [
        'editor gutter text on active line',
        '--color-editor-gutter-text',
        '--color-editor-active-line',
      ],
      ['syntax comments on editor', '--color-syntax-comment', '--color-editor-background'],
      ['syntax comments on active line', '--color-syntax-comment', '--color-editor-active-line'],
    ] as const;

    for (const [label, foreground, background] of pairs) {
      expect(
        contrastRatio(cssHexToken(foreground), cssHexToken(background)),
        label,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps canvas fallbacks aligned with the Command Deck cyan theme', () => {
    expect(hexPaneSource).toContain("readColor(style, '--color-selection') || '#102e49'");
    expect(hexPaneSource).toContain(
      "readColor(style, '--color-accent-wash') || 'rgb(54 194 255 / 8%)'",
    );
    expect(hexPaneSource).not.toContain('#183b3a');
    expect(hexPaneSource).not.toContain('rgb(85 216 190 / 8%)');
  });
});
