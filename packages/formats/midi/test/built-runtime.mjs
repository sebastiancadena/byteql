import assert from 'node:assert/strict';

const midi = await import('../dist/kaitai.js');

assert.equal(typeof midi.buildSyntheticTrackFile, 'function');
assert.equal(typeof midi.parseSyntheticTrack, 'function');
