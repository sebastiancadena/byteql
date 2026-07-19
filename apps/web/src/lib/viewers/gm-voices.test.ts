import { describe, expect, it } from 'vitest';

import { drumVoiceSpec, gmFamily, melodicVoiceSpec } from './gm-voices.js';

describe('gmFamily', () => {
  it('maps GM program bands to families', () => {
    expect(gmFamily(0)).toBe('piano');
    expect(gmFamily(7)).toBe('piano');
    expect(gmFamily(8)).toBe('organ');
    expect(gmFamily(23)).toBe('organ');
    expect(gmFamily(24)).toBe('guitar');
    expect(gmFamily(31)).toBe('guitar');
    expect(gmFamily(32)).toBe('bass');
    expect(gmFamily(39)).toBe('bass');
    expect(gmFamily(40)).toBe('strings');
    expect(gmFamily(55)).toBe('strings');
    expect(gmFamily(56)).toBe('brass');
    expect(gmFamily(63)).toBe('brass');
    expect(gmFamily(64)).toBe('reed');
    expect(gmFamily(79)).toBe('reed');
    expect(gmFamily(80)).toBe('synth');
    expect(gmFamily(127)).toBe('synth');
  });

  it('clamps out-of-range or non-integer programs to piano', () => {
    expect(gmFamily(-1)).toBe('piano');
    expect(gmFamily(128)).toBe('piano');
    expect(gmFamily(1.5)).toBe('piano');
    expect(gmFamily(Number.NaN)).toBe('piano');
  });
});

describe('melodicVoiceSpec', () => {
  it('returns a distinct, well-formed spec for every family', () => {
    const families = [
      'piano', 'organ', 'guitar', 'bass', 'strings', 'brass', 'reed', 'synth',
    ] as const;
    for (const family of families) {
      const spec = melodicVoiceSpec(family);
      expect(['triangle', 'sawtooth', 'square', 'sine']).toContain(spec.oscillator.type);
      expect(spec.envelope.attack).toBeGreaterThanOrEqual(0);
      expect(spec.envelope.sustain).toBeGreaterThanOrEqual(0);
      expect(spec.envelope.sustain).toBeLessThanOrEqual(1);
    }
    expect(melodicVoiceSpec('strings').oscillator.type).toBe('sawtooth');
    expect(melodicVoiceSpec('bass').oscillator.type).toBe('triangle');
  });
});

describe('drumVoiceSpec', () => {
  it('maps standard GM drum notes to percussion voices', () => {
    expect(drumVoiceSpec(35)).toBe('kick');
    expect(drumVoiceSpec(36)).toBe('kick');
    expect(drumVoiceSpec(38)).toBe('snare');
    expect(drumVoiceSpec(40)).toBe('snare');
    expect(drumVoiceSpec(42)).toBe('hat');
    expect(drumVoiceSpec(46)).toBe('hat');
    expect(drumVoiceSpec(45)).toBe('tom');
    expect(drumVoiceSpec(50)).toBe('tom');
    expect(drumVoiceSpec(49)).toBe('cymbal');
    expect(drumVoiceSpec(51)).toBe('cymbal');
  });

  it('falls back for out-of-range drum notes and unlisted in-range notes', () => {
    expect(drumVoiceSpec(34)).toBe('kick'); // below 35
    expect(drumVoiceSpec(82)).toBe('tom'); // above 81
    expect(drumVoiceSpec(60)).toBe('hat'); // in-range but unlisted
  });
});
