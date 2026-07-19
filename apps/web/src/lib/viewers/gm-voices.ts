export type GmFamily =
  | 'piano'
  | 'organ'
  | 'guitar'
  | 'bass'
  | 'strings'
  | 'brass'
  | 'reed'
  | 'synth';

export type DrumVoice = 'kick' | 'snare' | 'hat' | 'tom' | 'cymbal';

export interface VoiceSpec {
  oscillator: { type: 'triangle' | 'sawtooth' | 'square' | 'sine' };
  envelope: { attack: number; decay: number; sustain: number; release: number };
}

// General MIDI groups its 128 programs into 16 families of 8. We collapse
// those into 8 broader families that map cleanly onto distinct synth timbres.
export function gmFamily(program: number): GmFamily {
  if (!Number.isInteger(program) || program < 0 || program > 127) return 'piano';
  if (program <= 7) return 'piano';
  if (program <= 23) return 'organ';
  if (program <= 31) return 'guitar';
  if (program <= 39) return 'bass';
  if (program <= 55) return 'strings';
  if (program <= 63) return 'brass';
  if (program <= 79) return 'reed';
  return 'synth';
}

const MELODIC_VOICES: Record<GmFamily, VoiceSpec> = {
  piano: { oscillator: { type: 'triangle' }, envelope: { attack: 0.005, decay: 0.3, sustain: 0.2, release: 0.8 } },
  organ: { oscillator: { type: 'sine' }, envelope: { attack: 0.01, decay: 0.05, sustain: 0.9, release: 0.2 } },
  guitar: { oscillator: { type: 'triangle' }, envelope: { attack: 0.005, decay: 0.4, sustain: 0.1, release: 0.4 } },
  bass: { oscillator: { type: 'triangle' }, envelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.3 } },
  strings: { oscillator: { type: 'sawtooth' }, envelope: { attack: 0.15, decay: 0.2, sustain: 0.8, release: 0.6 } },
  brass: { oscillator: { type: 'square' }, envelope: { attack: 0.05, decay: 0.1, sustain: 0.7, release: 0.3 } },
  reed: { oscillator: { type: 'sawtooth' }, envelope: { attack: 0.08, decay: 0.1, sustain: 0.7, release: 0.3 } },
  synth: { oscillator: { type: 'square' }, envelope: { attack: 0.02, decay: 0.2, sustain: 0.5, release: 0.4 } },
};

export function melodicVoiceSpec(family: GmFamily): VoiceSpec {
  return MELODIC_VOICES[family];
}

// Standard GM percussion key map (channel 10 / index 9). Notes not listed
// here map to the nearest reasonable voice via drumVoiceSpec's fallbacks.
const DRUM_MAP: Record<number, DrumVoice> = {
  35: 'kick', 36: 'kick',
  37: 'snare', 38: 'snare', 39: 'snare', 40: 'snare',
  41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom',
  42: 'hat', 44: 'hat', 46: 'hat',
  49: 'cymbal', 51: 'cymbal', 52: 'cymbal', 53: 'cymbal', 55: 'cymbal', 57: 'cymbal', 59: 'cymbal',
};

export function drumVoiceSpec(note: number): DrumVoice {
  if (!Number.isInteger(note) || note < 35) return 'kick';
  if (note > 81) return 'tom';
  return DRUM_MAP[note] ?? 'hat';
}
