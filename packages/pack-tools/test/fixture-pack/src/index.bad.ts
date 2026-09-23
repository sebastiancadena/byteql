import { definePack, type Framer } from '@byteql/core';

import { definition, type Hooks } from './pack.generated.js';

const demo: Framer = async function* () {};
const twoBytes = () => ({ root: { a: 0 } });

export const demoPack = definePack<Hooks>(definition, {
  framers: { dmeo: demo },
  parsers: { two_bytes: twoBytes },
  keyExtractors: {},
  streamFramers: {},
  probes: {},
});
