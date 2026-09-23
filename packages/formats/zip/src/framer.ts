import type { Framer } from '@byteql/core';

import { readZipContainer, type ZipRange } from './container.js';

export const zipFramer: Framer = async function* (source, ctx) {
  ctx.progress({ stage: 'projecting', completed: 0, total: source.size, label: 'Reading ZIP structure' });
  const container = await readZipContainer(source);
  for (const issue of container.issues) ctx.report(issue);
  // Omit end_of_central_dir (rather than setting it null) when missing. The table's anchor,
  // `$.end_of_central_dir`, matches a single object, not `[*]` — so an explicit `null` property
  // would still match the anchor and yield one row (with a null `match.node`, which the
  // provenance resolver below can't service). Omitting the key entirely makes the property
  // lookup miss instead, so no row is emitted and the table comes back genuinely empty.
  const root: Record<string, unknown> = {
    local_files: container.localFiles,
    central_dir_entries: container.centralDirEntries,
  };
  if (container.endOfCentralDir) root.end_of_central_dir = container.endOfCentralDir;
  yield {
    root,
    provenance: (_table, match) => (match.node as { _range: ZipRange })._range,
  };
  ctx.progress({
    stage: 'projecting',
    completed: source.size,
    total: source.size,
    label: 'Projected ZIP structure',
  });
};
