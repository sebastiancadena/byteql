export { collectSource } from './collect.js';
export type { CollectOptions } from './collect.js';
export { goldenText, schemaSnapshotText } from './golden.js';
export { assertTableInvariants, describePackConformance, mulberry32, runFuzzCase } from './conformance.js';
export type { ConformanceOptions } from './conformance.js';

export interface FixtureCase {
  /** Golden file stem, e.g. `v6.pcap`. */
  name: string;
  /** Container id the probe must select. */
  container: string;
  load(): Promise<Uint8Array>;
}
