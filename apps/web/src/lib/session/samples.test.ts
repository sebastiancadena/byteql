import { describe, expect, it } from 'vitest';

import { SAMPLES } from './samples.js';

describe('sample registry', () => {
  it('lists pcap first (default), then midi', () => {
    expect(SAMPLES.map((sample) => sample.id)).toEqual(['pcap', 'midi']);
  });

  it('maps the pcap sample to the two Wireshark captures plus the DNS-over-TCP fixture', () => {
    const pcap = SAMPLES.find((sample) => sample.id === 'pcap');
    expect(pcap?.files.map((file) => file.name)).toEqual([
      'SkypeIRC.cap',
      'v6.pcap',
      'dns-stream.pcap',
    ]);
  });

  it('maps the midi sample to the single Für Elise file', () => {
    const midi = SAMPLES.find((sample) => sample.id === 'midi');
    expect(midi?.files.map((file) => file.name)).toEqual(['fur_Elise_opening.mid']);
  });

  it('gives every file a non-empty resolved url and a menu label per entry', () => {
    for (const sample of SAMPLES) {
      expect(sample.label.length).toBeGreaterThan(0);
      for (const file of sample.files) expect(file.url.length).toBeGreaterThan(0);
    }
  });
});
