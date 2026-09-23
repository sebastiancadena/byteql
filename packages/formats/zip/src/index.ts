import { definePack } from '@byteql/core';

import { zipFramer } from './framer.js';
import { definition, type Hooks } from './pack.generated.js';

export const zipFormatPack = definePack<Hooks>(definition, {
  framers: { zip: zipFramer },
  parsers: {},
  keyExtractors: {},
  streamFramers: {},
  probes: {},
});
