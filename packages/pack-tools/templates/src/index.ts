import { definePack, type Framer } from '@byteql/core';

import { definition, type Hooks } from './pack.generated.js';

/** One record spanning the whole file; replace with the real container framer. */
const __ID__Framer: Framer = async function* (source) {
  yield { root: { length: source.size }, provenance: { start: 0, end: source.size } };
};

export const __ID__Pack = definePack<Hooks>(definition, {
  framers: { __ID__: __ID__Framer },
  parsers: {},
  keyExtractors: {},
  streamFramers: {},
  probes: {},
});
