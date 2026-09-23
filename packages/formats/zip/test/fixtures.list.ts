import type { FixtureCase } from '@byteql/core/testing';

import { buildZip } from './build-zip.js';

const built = (name: string, make: () => Uint8Array): FixtureCase => ({
  name,
  container: 'zip',
  load: async () => make(),
});

export const ZIP_FIXTURES: FixtureCase[] = [
  built('two-entries.zip', () =>
    buildZip(
      [
        { name: 'a.txt', data: new TextEncoder().encode('hello') },
        { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 3]) },
      ],
      { comment: 'golden' },
    ),
  ),
  built('empty.zip', () => buildZip([])),
  // Malformed: same truncation trick as project-zip.test.ts's "reports a recoverable issue
  // when the EOCD is missing" — strip the central directory + EOCD, leaving only the local
  // file record, so the pack reports EOCD_NOT_FOUND and the errors table gets a row.
  built('truncated-no-eocd.zip', () => {
    const full = buildZip([{ name: 'a.txt', data: new TextEncoder().encode('hello'), method: 0 }]);
    return full.slice(0, 30 + 'a.txt'.length + 'hello'.length);
  }),
];
