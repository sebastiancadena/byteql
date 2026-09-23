import { definePack } from '@byteql/core';

import { smfFramer } from './framer.js';
import { definition, type Hooks } from './pack.generated.js';

export const midiFormatPack = definePack<Hooks>(definition, {
  framers: { smf: smfFramer },
  parsers: {},
  keyExtractors: {},
  streamFramers: {},
  probes: {},
});
export const midiQueries = definition.queries;
export { parseMidiContainer } from './container.js';
export { MidiParseError } from './errors.js';
export { normalizeTrack } from './normalize-track.js';
export { decodeVlq } from './vlq.js';
export type { DecodedVlq } from './vlq.js';
export type {
  MidiContainer,
  MidiHeader,
  NormalizedEventMap,
  NormalizedTrack,
  SourceRange,
  TrackChunk,
} from './types.js';
