import type { Framer } from '@byteql/core';

import { createPcapFramer } from './container.js';

export const pcapFramer: Framer = async function* (source, ctx) {
  const framer = await createPcapFramer(source, ctx.chunkBytes);
  for (let packet = await framer.next(); packet !== null; packet = await framer.next()) {
    ctx.bytes(framer.bytesConsumed()); // before yield: the driver flushes progress while this record is current
    yield {
      root: {
        ts_sec: packet.ts_sec,
        ts_frac_us: packet.ts_frac_us,
        incl_len: packet.incl_len,
        orig_len: packet.orig_len,
        linktype: packet.linktype,
        body: packet.body,
      },
      provenance: { start: packet.recordStart, end: packet.bodyEnd },
      tables: ['packets'],
    };
  }
  // Truncation is discovered at EOF; the driver still orders framing issues first.
  for (const issue of framer.issues()) ctx.report(issue);
  ctx.bytes(framer.bytesConsumed());
};
