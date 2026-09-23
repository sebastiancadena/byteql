import type { Framer } from '@byteql/core';

import { readZipContainer, type ZipRange } from './container.js';

export const zipFramer: Framer = async function* (source, ctx) {
  ctx.progress({ stage: 'projecting', completed: 0, total: source.size, label: 'Reading ZIP structure' });
  const container = await readZipContainer(source);
  for (const issue of container.issues) ctx.report(issue);
  // Omit end_of_central_dir (not null) when missing, so its `$.end_of_central_dir` anchor
  // misses and the table stays empty — see the pre-kit note in project-zip.ts.
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
