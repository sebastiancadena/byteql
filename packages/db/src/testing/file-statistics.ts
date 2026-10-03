import type { FileStatisticsAccess } from '../file-statistics.js';
import type { ByteqlDatabase } from '../types.js';

export type { FileStatisticsAccess, FileStatisticsSummary } from '../file-statistics.js';

/** Narrows a production database to its file-statistics pass-throughs, or throws if it has none. */
export const fileStatisticsAccess = (database: ByteqlDatabase): FileStatisticsAccess => {
  const candidate = database as Partial<FileStatisticsAccess>;
  if (
    typeof candidate.collectFileStatistics !== 'function' ||
    typeof candidate.exportFileStatistics !== 'function'
  ) {
    throw new Error('This database does not expose file statistics.');
  }
  return candidate as FileStatisticsAccess;
};
