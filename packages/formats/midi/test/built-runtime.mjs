import assert from 'node:assert/strict';

const midi = await import('../dist/kaitai.js');
const entrypoint = await import('../dist/index.js');

assert.equal(typeof midi.buildSyntheticTrackFile, 'function');
assert.equal(typeof midi.parseSyntheticTrack, 'function');
assert.equal(typeof entrypoint.parseAndProjectMidi, 'function');
