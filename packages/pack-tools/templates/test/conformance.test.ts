import { describePackConformance } from '@byteql/core/testing';

import { __ID__Pack } from '../src/index.js';

describePackConformance(__ID__Pack, {
  fixtures: [{ name: 'minimal.bin', container: '__ID__', load: async () => new Uint8Array([0]) }],
  fuzz: { seed: 1, truncations: 3, flips: 3 },
});
