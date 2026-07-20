import type { ByteSource } from '@byteql/core';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_DATA_DESCRIPTOR = 0x08;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

export interface ZipRange {
  readonly start: number;
  readonly end: number;
}

export interface LocalFileRecord {
  version_needed: number;
  flags: number;
  compression_method: number;
  crc32: number;
  compressed_size: number;
  uncompressed_size: number;
  mod_date: number;
  mod_time: number;
  file_name: string;
  extra_len: number;
  _range: ZipRange;
}

export interface CentralDirRecord {
  version_made_by: number;
  version_needed: number;
  flags: number;
  compression_method: number;
  crc32: number;
  compressed_size: number;
  uncompressed_size: number;
  mod_date: number;
  mod_time: number;
  file_name: string;
  extra_len: number;
  disk_start: number;
  internal_attrs: number;
  external_attrs: number;
  ofs_local_header: number;
  comment: string;
  _range: ZipRange;
}

export interface EndOfCentralDirRecord {
  num_entries: number;
  central_dir_size: number;
  ofs_central_dir: number;
  comment: string;
  _range: ZipRange;
}

export interface ZipIssue {
  code: string;
  message: string;
  sourceStart: number;
  sourceEnd: number;
}

export interface ZipContainer {
  localFiles: LocalFileRecord[];
  centralDirEntries: CentralDirRecord[];
  endOfCentralDir: EndOfCentralDirRecord | null;
  issues: ZipIssue[];
}

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const decodeText = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);

/** Reads the whole central directory + tail into memory; member bodies are never read. */
export async function readZipContainer(source: ByteSource): Promise<ZipContainer> {
  const issues: ZipIssue[] = [];
  const size = source.size;

  // 1. Locate the EOCD by scanning the tail for its signature (last match wins).
  const tailLen = Math.min(size, EOCD_MIN + MAX_COMMENT);
  const tailStart = size - tailLen;
  const tail = await source.read(tailStart, tailLen);
  const tailView = viewOf(tail);
  let eocdRel = -1;
  for (let i = tail.length - EOCD_MIN; i >= 0; i -= 1) {
    if (tailView.getUint32(i, true) === SIG_EOCD) {
      eocdRel = i;
      break;
    }
  }

  if (eocdRel < 0) {
    issues.push({
      code: 'EOCD_NOT_FOUND',
      message: 'No End Of Central Directory record found; falling back to a forward local-header scan.',
      sourceStart: tailStart,
      sourceEnd: size,
    });
    return { ...(await forwardScan(source, issues)), issues };
  }

  const eocdOffset = tailStart + eocdRel;
  const commentLen = tailView.getUint16(eocdRel + 20, true);
  const eocd: EndOfCentralDirRecord = {
    num_entries: tailView.getUint16(eocdRel + 10, true),
    central_dir_size: tailView.getUint32(eocdRel + 12, true),
    ofs_central_dir: tailView.getUint32(eocdRel + 16, true),
    comment: decodeText(tail.subarray(eocdRel + 22, eocdRel + 22 + commentLen)),
    _range: { start: eocdOffset, end: eocdOffset + EOCD_MIN + commentLen },
  };

  // 2. Read the central directory in one contiguous range.
  const centralDirEntries: CentralDirRecord[] = [];
  const cd = await source.read(eocd.ofs_central_dir, eocd.central_dir_size);
  const cdView = viewOf(cd);
  let p = 0;
  while (p + 46 <= cd.length && cdView.getUint32(p, true) === SIG_CENTRAL) {
    const nameLen = cdView.getUint16(p + 28, true);
    const extraLen = cdView.getUint16(p + 30, true);
    const commentLength = cdView.getUint16(p + 32, true);
    const nameStart = p + 46;
    const absStart = eocd.ofs_central_dir + p;
    const recEnd = nameStart + nameLen + extraLen + commentLength;
    centralDirEntries.push({
      version_made_by: cdView.getUint16(p + 4, true),
      version_needed: cdView.getUint16(p + 6, true),
      flags: cdView.getUint16(p + 8, true),
      compression_method: cdView.getUint16(p + 10, true),
      mod_time: cdView.getUint16(p + 12, true),
      mod_date: cdView.getUint16(p + 14, true),
      crc32: cdView.getUint32(p + 16, true),
      compressed_size: cdView.getUint32(p + 20, true),
      uncompressed_size: cdView.getUint32(p + 24, true),
      extra_len: extraLen,
      disk_start: cdView.getUint16(p + 34, true),
      internal_attrs: cdView.getUint16(p + 36, true),
      external_attrs: cdView.getUint32(p + 38, true),
      ofs_local_header: cdView.getUint32(p + 42, true),
      file_name: decodeText(cd.subarray(nameStart, nameStart + nameLen)),
      comment: decodeText(cd.subarray(nameStart + nameLen + extraLen, recEnd)),
      _range: { start: absStart, end: eocd.ofs_central_dir + recEnd },
    });
    p = recEnd;
  }

  // 3. Read each local header by offset, reconciling data-descriptor sizes from the CD.
  const localFiles: LocalFileRecord[] = [];
  for (const entry of centralDirEntries) {
    const head = await source.read(entry.ofs_local_header, 30);
    const hv = viewOf(head);
    if (head.length < 30 || hv.getUint32(0, true) !== SIG_LOCAL) {
      issues.push({
        code: 'LOCAL_HEADER_INVALID',
        message: `Local header for ${JSON.stringify(entry.file_name)} is missing or malformed.`,
        sourceStart: entry.ofs_local_header,
        sourceEnd: entry.ofs_local_header + 30,
      });
      continue;
    }
    const flags = hv.getUint16(6, true);
    const nameLen = hv.getUint16(26, true);
    const extraLen = hv.getUint16(28, true);
    const dataDescriptor = (flags & FLAG_DATA_DESCRIPTOR) !== 0;
    let compressed = hv.getUint32(18, true);
    let uncompressed = hv.getUint32(22, true);
    let crc = hv.getUint32(14, true);
    if (dataDescriptor && compressed === 0 && uncompressed === 0) {
      compressed = entry.compressed_size;
      uncompressed = entry.uncompressed_size;
      crc = entry.crc32;
    }
    const nameBytes = await source.read(entry.ofs_local_header + 30, nameLen);
    localFiles.push({
      version_needed: hv.getUint16(4, true),
      flags,
      compression_method: hv.getUint16(8, true),
      mod_time: hv.getUint16(10, true),
      mod_date: hv.getUint16(12, true),
      crc32: crc,
      compressed_size: compressed,
      uncompressed_size: uncompressed,
      extra_len: extraLen,
      file_name: decodeText(nameBytes),
      _range: {
        start: entry.ofs_local_header,
        end: entry.ofs_local_header + 30 + nameLen + extraLen,
      },
    });
  }

  return { localFiles, centralDirEntries, endOfCentralDir: eocd, issues };
}

/** Best-effort forward scan of local headers when the central directory is unavailable. */
async function forwardScan(
  source: ByteSource,
  issues: ZipIssue[],
): Promise<Omit<ZipContainer, 'issues'>> {
  const localFiles: LocalFileRecord[] = [];
  let offset = 0;
  const size = source.size;
  while (offset + 30 <= size) {
    const head = await source.read(offset, 30);
    const hv = viewOf(head);
    if (head.length < 30 || hv.getUint32(0, true) !== SIG_LOCAL) break;
    const flags = hv.getUint16(6, true);
    const compressed = hv.getUint32(18, true);
    const nameLen = hv.getUint16(26, true);
    const extraLen = hv.getUint16(28, true);
    const nameBytes = await source.read(offset + 30, nameLen);
    localFiles.push({
      version_needed: hv.getUint16(4, true),
      flags,
      compression_method: hv.getUint16(8, true),
      mod_time: hv.getUint16(10, true),
      mod_date: hv.getUint16(12, true),
      crc32: hv.getUint32(14, true),
      compressed_size: compressed,
      uncompressed_size: hv.getUint32(22, true),
      extra_len: extraLen,
      file_name: decodeText(nameBytes),
      _range: { start: offset, end: offset + 30 + nameLen + extraLen },
    });
    if ((flags & FLAG_DATA_DESCRIPTOR) !== 0 && compressed === 0) {
      issues.push({
        code: 'STREAMED_ENTRY_UNSIZED',
        message: 'A data-descriptor entry has no central directory to size its body; stopping the scan.',
        sourceStart: offset,
        sourceEnd: offset + 30,
      });
      break;
    }
    offset += 30 + nameLen + extraLen + compressed;
  }
  return { localFiles, centralDirEntries: [], endOfCentralDir: null };
}
