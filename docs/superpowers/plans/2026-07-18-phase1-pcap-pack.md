# pcap Pack Implementation Plan (Phase 1, slice 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `@byteql/pcap` format pack that turns a classic `.pcap` file into joinable
`packets`/`ip`/`tcp`/`udp`/`dns`/`icmp`/`tls` tables with byte provenance, queryable end-to-end in
the existing web UI.

**Architecture:** A thin TS framer slices pcap records and calls `ProjectionSession.project()` once
per packet; the Phase 1a declarative dissect registry routes each packet's payload down the
Ethernet → IP → transport → application chain via standalone Kaitai layer parsers whose `body`
fields are patched to raw blobs. Per-parser wrappers flatten Kaitai trees into simple projection
nodes so the YAML spec stays declarative. Delivery is an eager in-memory `RecordSource` façade
(one `ParseResult`); streaming/spill is a later slice.

**Tech Stack:** TypeScript, Kaitai Struct JS runtime + compiler (`kaitai-struct` /
`kaitai-struct-compiler` `^0.11`), Apache Arrow JS, DuckDB-WASM, Svelte, vitest, Playwright,
pnpm workspace.

## Global Constraints

- **Privacy is the product.** No network, CDNs, fonts, analytics, or runtime-loaded code. Enforced
  by `apps/web` `check:bundle` and `e2e/privacy.spec.ts`.
- **Arrow IPC at every boundary.** Every table row carries hidden `_src_start`/`_src_end` (uint64)
  provenance columns; the engine fills them.
- **Dependency direction:** `app → db → core ← formats`. `packages/core` stays zero-DOM.
- **Engine invariants:** document-order traversal is load-bearing; spec/compile errors throw
  `ProjectionCompileError` at load; row-time evaluation returns null, never throws.
- **Parsing treats input as hostile:** a poison record becomes an `errors` row; it never throws out
  of the pack. `RecordSource.finish()` must be called only after `nextBatch()` returns null
  (`RECORD_SOURCE_NOT_DRAINED`).
- **MIDI green at every step:** `pnpm -r test -- --run` and the MIDI e2e stay passing throughout.
- **Vendored `.ksy` are pinned:** upstream commit `1818b5447c1aaf51084999f1ce2c6c40b57b752e`,
  already committed under `packages/formats/pcap/network/` (`network/PROVENANCE.md`). Do not edit
  `network/`; patched compilation inputs live in `ksy/`.
- **Conventional commits; no Co-Authored-By trailers or AI branding.**
- **Markdown:** `rumdl fmt <file>`; MD013 up to ~100 chars is accepted.

## Reference signatures (verified against current code)

- `compileProjection(spec: ProjectionSpec, registry: ParserRegistry = new Map()): CompiledProjection`
  — pass the pcap registry as the 2nd arg (`packages/core/src/projection/project.ts:174`).
- `createProjectionSession(compiled): ProjectionSession` with
  `project(root, resolver: ProvenanceResolver, opts?): void` and `finish(): FinishedTable[]`.
- `ProvenanceResolver = { resolve(table: string, anchor: AnchorMatch): { start: number; end: number } }`.
- `RecordParser = (bytes: Uint8Array) => { root: unknown; resolve?: (table, match) => SourceRange }`.
  `ParserRegistry = ReadonlyMap<string, RecordParser>`. Omit `resolve` → the engine defaults each
  dissected row's provenance to the full payload extent (`project.ts:648-650`) — correct for our
  `$`-anchored layer tables.
- **Dissect payload contract:** a `payload` expression (e.g. `_.body`) must evaluate to
  `{ bytes: Uint8Array, start: number }` (`PayloadRange`, `project.ts:522`). `start` is
  file-absolute for the top-level packets dissect and payload-relative (Kaitai `_debug` offset) for
  deeper dissects.
- `FormatPack`/`RecordSource`/`SourceFinish` — mirror `packages/formats/midi/src/pack.ts`.
- `IssueCollector({ ordinalColumn })` with `.report(IssueReport)`, `.table()`, `.issues()`.
  `IssueReport = { stage, ordinal?, code, message, recoverable, sourceStart?, sourceEnd? }`.
- Kaitai debug offsets: a parsed field `x` exposes `parsed._debug.x = { ioOffset, start, end }`;
  absolute-within-buffer offset is `ioOffset + start` (see
  `packages/formats/midi/src/kaitai.ts:correlateDebug`).
- Expression builtins live in `packages/core/src/projection/expression.ts`: the `builtinNames` set
  (line 84) and the `builtins` object (line 589). Single-argument calls only.
- Worker registry: `installParseWorker(scope, packs = [midiFormatPack])`
  (`apps/web/src/workers/parse.worker.ts`); the default array at file bottom is where packs
  register.

## File structure

```text
packages/core/src/projection/expression.ts        # + ip4_str, ip6_str builtins
packages/formats/pcap/
├── network/                                       # pristine vendored .ksy (committed, untouched)
├── ksy/                                            # compilation inputs
│   ├── ethernet_frame.ksy  ipv4_packet.ksy  ipv6_packet.ksy   # PATCHED (body → raw blob)
│   ├── tcp_segment.ksy  udp_datagram.ksy  dns_packet.ksy      # copies of pristine
│   ├── icmp_packet.ksy  tls_client_hello.ksy                   # copies of pristine
├── PATCHES.md                                      # documents the 3 diffs vs network/
├── pcap.tables.yaml                                # projection spec (7 tables + dissect graph)
├── queries.yaml                                    # canned queries
├── scripts/compile.mjs                             # .ksy → gen/*.js (8 roots, debug mode)
├── scripts/generate-pack.mjs                       # yaml → src/*.generated.ts
├── src/
│   ├── container.ts        # framer: global header + record loop + raw-IP normalization
│   ├── wrappers.ts         # per-parser Kaitai wrappers → flattened projection nodes
│   ├── parsers.ts          # ParserRegistry assembly
│   ├── flatten.ts          # pure field-flatten helpers (dns name, tls sni, tcp flags, ip addr)
│   ├── project-pcap.ts     # framer + session + registry + issues → ParseResult
│   ├── pack.ts             # pcapFormatPack (FormatPack façade)
│   ├── pcap-tables.generated.ts / pcap-queries.generated.ts   # generated; gitignored inputs
│   └── index.ts
├── test/
│   ├── build-pcap.ts       # deterministic .pcap + layer byte builders
│   ├── fixtures/manifest.md
│   └── *.test.ts
├── gen/                                            # ksc output, gitignored
├── package.json  tsconfig.json
apps/web/src/workers/parse.worker.ts               # register pcapFormatPack
apps/web/package.json                              # + @byteql/pcap dep
apps/web/e2e/pcap.spec.ts                          # open .pcap, run DNS-join query
```

---

### Task 1: Core `ip4_str` / `ip6_str` expression builtins

**Files:**

- Modify: `packages/core/src/projection/expression.ts` (line 84 `builtinNames`; line 589 `builtins`)
- Test: `packages/core/src/projection/expression.test.ts`

**Interfaces:**

- Produces: DSL functions `ip4_str(bytes)` (4-byte `Uint8Array` → `"a.b.c.d"`), `ip6_str(bytes)`
  (16-byte `Uint8Array` → RFC 5952 compressed hex). Both return `null` on wrong length/type.

- [ ] **Step 1: Write failing tests**

```ts
// in expression.test.ts — evaluate compiled expressions against a context
it('ip4_str formats a 4-byte address', () => {
  const expr = compileExpression('ip4_str(_.a)', ['_']);
  expect(evaluateExpression(expr, { _: { a: new Uint8Array([192, 168, 0, 1]) } })).toBe('192.168.0.1');
});
it('ip4_str returns null on wrong length', () => {
  const expr = compileExpression('ip4_str(_.a)', ['_']);
  expect(evaluateExpression(expr, { _: { a: new Uint8Array([1, 2, 3]) } })).toBeNull();
});
it('ip6_str compresses the longest zero run', () => {
  const expr = compileExpression('ip6_str(_.a)', ['_']);
  const addr = new Uint8Array(16); addr[0] = 0x20; addr[1] = 0x01; addr[15] = 0x01;
  expect(evaluateExpression(expr, { _: { a: addr } })).toBe('2001::1');
});
```

Match the existing `expression.test.ts` helper style for `compileExpression`/`evaluateExpression`
(read the file's top for the exact call signature and adapt these three).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core test -- --run expression`
Expected: FAIL — `ip4_str`/`ip6_str` unknown builtin (compile rejects the call).

- [ ] **Step 3: Implement**

Add both names to the set at line 84:

```ts
const builtinNames = new Set(['enum_str', 'to_i', 'len', 'u24be', 'ip4_str', 'ip6_str']);
```

Add to the `builtins` object (after `u24be`):

```ts
  ip4_str: (value: unknown): unknown => {
    if (!(value instanceof Uint8Array) || value.length !== 4) return null;
    return `${value[0]}.${value[1]}.${value[2]}.${value[3]}`;
  },
  ip6_str: (value: unknown): unknown => {
    if (!(value instanceof Uint8Array) || value.length !== 16) return null;
    const groups: number[] = [];
    for (let i = 0; i < 16; i += 2) groups.push((value[i]! << 8) | value[i + 1]!);
    // RFC 5952: compress the longest run (length >= 2) of zero groups to "::".
    let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
    for (let i = 0; i < 8; i += 1) {
      if (groups[i] === 0) {
        if (curStart < 0) curStart = i;
        curLen += 1;
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
      } else { curStart = -1; curLen = 0; }
    }
    const hex = (g: number): string => g.toString(16);
    if (bestLen < 2) return groups.map(hex).join(':');
    const head = groups.slice(0, bestStart).map(hex).join(':');
    const tail = groups.slice(bestStart + bestLen).map(hex).join(':');
    return `${head}::${tail}`;
  },
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @byteql/core test -- --run expression`
Expected: PASS. Then `pnpm --filter @byteql/core test -- --run` (whole core suite) stays green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/projection/expression.ts packages/core/src/projection/expression.test.ts
git commit -m "feat(core): add ip4_str and ip6_str projection builtins"
```

---

### Task 2: pcap package scaffold + Kaitai compilation with 3 body patches

**Files:**

- Create: `packages/formats/pcap/package.json`, `tsconfig.json`, `scripts/compile.mjs`,
  `ksy/*.ksy` (8 files), `PATCHES.md`, `src/index.ts` (stub)
- Test: `packages/formats/pcap/test/compile.test.ts`

**Interfaces:**

- Produces: `packages/formats/pcap/gen/{EthernetFrame,Ipv4Packet,Ipv6Packet,TcpSegment,
  UdpDatagram,DnsPacket,IcmpPacket,TlsClientHello}.js` — 8 standalone Kaitai parser classes, debug
  mode on, no cross-layer auto-descent (patched bodies are raw blobs).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@byteql/pcap",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "compile:ksy": "node scripts/compile.mjs",
    "generate:pack": "node scripts/generate-pack.mjs",
    "build": "pnpm compile:ksy && pnpm generate:pack && tsc -p tsconfig.json",
    "check": "pnpm --filter @byteql/core build && pnpm compile:ksy && pnpm generate:pack && tsc -p tsconfig.json --noEmit",
    "test": "pnpm --filter @byteql/core build && pnpm compile:ksy && pnpm generate:pack && vitest"
  },
  "dependencies": {
    "@byteql/core": "workspace:*",
    "kaitai-struct": "^0.11.0",
    "yaml": "^2.9.0"
  },
  "devDependencies": { "kaitai-struct-compiler": "^0.11.0" }
}
```

Copy `packages/formats/midi/tsconfig.json` to `packages/formats/pcap/tsconfig.json` verbatim.
Add `gen/` to the repo `.gitignore` scope for this package (mirror MIDI's `gen/` ignore).
Create `src/index.ts` with `export const PCAP_PACK_VERSION = '0.1' as const;` (real export so tsc
has something to emit until later tasks fill it).

- [ ] **Step 2: Create `ksy/` compilation inputs (copies + 3 patches)**

Copy all 8 needed files from `network/` to `ksy/` (`ethernet_frame`, `ipv4_packet`, `ipv6_packet`,
`tcp_segment`, `udp_datagram`, `dns_packet`, `icmp_packet`, `tls_client_hello`). Then apply exactly
these three patches (and record each in `PATCHES.md`):

`ksy/ethernet_frame.ksy` — replace the `body` field's type switch with a raw blob and drop the
imports:

```yaml
# meta.imports: delete the whole imports: block (ipv4_packet, ipv6_packet)
# seq body field becomes:
  - id: body
    size-eos: true
```

`ksy/ipv4_packet.ksy` — drop `imports: [/network/protocol_body]`; change body:

```yaml
  - id: body
    size: total_length - ihl_bytes
```

`ksy/ipv6_packet.ksy` — drop `imports: [/network/protocol_body]`; replace the `next_header`
(protocol_body) and trailing `rest` fields with a single raw body:

```yaml
  - id: body
    size: payload_length
```

- [ ] **Step 3: Create `scripts/compile.mjs`**

Adapt `packages/formats/midi/scripts/compile.mjs` (already handles safe path resolution). Two
changes: (a) `resolveWithinPackage` message text says "pcap package"; (b) compile **each** of the 8
`ksy/*.ksy` as its own root in a loop, writing to `gen/`. The importer resolves `/network/...` and
plain names against `ksy/` (so any residual import resolves within the package). Compile with debug
mode on (the 4th `compile()` arg `true`, as MIDI does).

- [ ] **Step 4: Write failing test**

```ts
// test/compile.test.ts
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
it('ethernet parser stops at a raw blob (no auto-descent)', () => {
  const mod = require('../gen/EthernetFrame.js');
  const KaitaiStream = require('kaitai-struct/KaitaiStream.js');
  // dst(6) src(6) ethertype=0x0800 then 4 payload bytes
  const bytes = new Uint8Array([...Array(12).fill(0), 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);
  const p = new mod.EthernetFrame(new KaitaiStream(bytes.buffer));
  p._read();
  expect(p.body).toBeInstanceOf(Uint8Array);       // raw blob, not a parsed ipv4 object
  expect([...p.body]).toEqual([0xde, 0xad, 0xbe, 0xef]);
});
```

- [ ] **Step 5: Run — expect FAIL (gen/ missing), then compile, then PASS**

Run: `pnpm --filter @byteql/pcap compile:ksy && pnpm --filter @byteql/pcap test -- --run compile`
Expected: after compile, PASS; `p.body` is a `Uint8Array`. If the compiler errors on a residual
import, the patch left an import in place — fix the `imports:` deletion.

- [ ] **Step 6: Write `PATCHES.md` and commit**

`PATCHES.md` lists each patched file, the pinned upstream commit, and the exact before/after of the
`body`/`imports` edits (so a future re-vendor can re-apply them).

```bash
git add packages/formats/pcap/package.json packages/formats/pcap/tsconfig.json \
  packages/formats/pcap/ksy packages/formats/pcap/scripts/compile.mjs \
  packages/formats/pcap/PATCHES.md packages/formats/pcap/src/index.ts \
  packages/formats/pcap/test/compile.test.ts .gitignore pnpm-lock.yaml
git commit -m "chore(pcap): scaffold pack and compile 8 layer parsers with raw-blob bodies"
```

---

### Task 3: Deterministic `.pcap` + layer byte builders (test helper)

**Files:**

- Create: `packages/formats/pcap/test/build-pcap.ts`, `packages/formats/pcap/test/fixtures/manifest.md`
- Test: `packages/formats/pcap/test/build-pcap.test.ts`

**Interfaces:**

- Produces: `buildPcap({ magic, linktype, packets })` → `Uint8Array`; and layer helpers
  `ethFrame({ etherType, payload })`, `ipv4({ protocol, src, dst, payload })`,
  `ipv6({ nextHeader, src, dst, payload })`, `tcp({ srcPort, dstPort, flags, payload })`,
  `udp({ srcPort, dstPort, payload })`, `dnsQuery({ txId, name, type })`,
  `icmpEcho({ id, seq })`, `tlsClientHello({ sni })` — all returning `Uint8Array`, all
  byte-deterministic. Later tasks compose these.

- [ ] **Step 1: Write failing test**

```ts
// build-pcap.test.ts
it('buildPcap writes a 24-byte global header then one record', () => {
  const pcap = buildPcap({ magic: 'be_us', linktype: 1, packets: [{ tsSec: 1, tsFrac: 2, data: new Uint8Array([9, 9]) }] });
  const view = new DataView(pcap.buffer);
  expect(view.getUint32(0, false)).toBe(0xa1b2c3d4);   // be microseconds
  expect(view.getUint32(20, false)).toBe(1);           // linktype ethernet
  expect(view.getUint32(24, false)).toBe(1);           // ts_sec of record 0
  expect(view.getUint32(32, false)).toBe(2);           // incl_len = data.length
  expect([...pcap.subarray(40, 42)]).toEqual([9, 9]);  // record body
});
```

- [ ] **Step 2: Run — FAIL**

Run: `pnpm --filter @byteql/pcap test -- --run build-pcap`
Expected: FAIL — `buildPcap` not defined.

- [ ] **Step 3: Implement `build-pcap.ts`**

Write the builders with explicit `DataView` writes. `buildPcap`: 24-byte global header (magic per
the four names → `be_us`/`be_ns`/`le_us`/`le_ns`, version 2.4, thiszone/sigfigs 0, snaplen 65535,
linktype), then per packet a 16-byte record header (`ts_sec`, `ts_usec`=`tsFrac`, `incl_len`=
`orig_len`=`data.length`) + `data`. Endianness of all multi-byte header fields follows the magic.
The layer helpers assemble minimal valid headers per the `.ksy` field order (Ethernet: dst6/src6/
ethertype; IPv4: version+ihl byte 0x45, then the fields from `ipv4_packet.ksy`; TCP: ports, seq,
ack, `data_offset=5<<4`, flags byte, window, checksum, urgent, payload; UDP: ports, length,
checksum, payload; DNS: 12-byte header + one QNAME-encoded question; ICMP: type/code/checksum +
echo id/seq; TLS: a full record(0x16 0x03 0x03 len)+handshake(0x01 len)+ClientHello with an SNI
extension). Keep every field explicit and commented.

- [ ] **Step 4: Run — PASS.** Run the same command; expect PASS. Add `fixtures/manifest.md`
  documenting each builder's intent.

- [ ] **Step 5: Commit**

```bash
git add packages/formats/pcap/test/build-pcap.ts packages/formats/pcap/test/build-pcap.test.ts \
  packages/formats/pcap/test/fixtures/manifest.md
git commit -m "test(pcap): add deterministic pcap and layer byte builders"
```

---

### Task 4: Container framer (`src/container.ts`)

**Files:**

- Create: `packages/formats/pcap/src/container.ts`
- Test: `packages/formats/pcap/test/container.test.ts`

**Interfaces:**

- Produces:
  `parsePcapContainer(bytes: Uint8Array): { header: PcapHeader; packets: PcapPacket[]; issues: PcapFramingIssue[] }`
  where `PcapPacket = { index; tsSec; tsFracUs; inclLen; origLen; linktype; recordStart; bodyEnd;
  body: { bytes: Uint8Array; start: number } }` (`body.start` = absolute file offset;
  `body.bytes` = a `subarray` view into the file buffer), and
  `PcapFramingIssue = { code; message; sourceStart; sourceEnd }`.
- Consumes: `test/build-pcap.ts` (Task 3).
- [ ] **Step 1: Write failing tests**

```ts
// container.test.ts
it('parses global header magic → endianness and µs/ns', () => {
  const le = parsePcapContainer(buildPcap({ magic: 'le_ns', linktype: 1, packets: [] }));
  expect(le.header.byteOrder).toBe('le');
  expect(le.header.timeUnit).toBe('ns');
  expect(le.header.linktype).toBe(1);
});
it('yields one packet with an absolute-offset body range', () => {
  const c = parsePcapContainer(buildPcap({ magic: 'be_us', linktype: 1,
    packets: [{ tsSec: 7, tsFrac: 500000, data: new Uint8Array([1, 2, 3, 4]) }] }));
  expect(c.packets).toHaveLength(1);
  expect(c.packets[0].body.start).toBe(40);            // 24 global + 16 record header
  expect([...c.packets[0].body.bytes]).toEqual([1, 2, 3, 4]);
  expect(c.packets[0].tsFracUs).toBe(500000);
});
it('normalizes ns fraction to microseconds', () => {
  const c = parsePcapContainer(buildPcap({ magic: 'be_ns', linktype: 1,
    packets: [{ tsSec: 0, tsFrac: 2500, data: new Uint8Array([0]) }] }));
  expect(c.packets[0].tsFracUs).toBe(2);               // 2500 ns → 2 µs (integer)
});
it('rewrites raw-IP linktype 101 to 228/229 by peeking the version nibble', () => {
  const v6body = new Uint8Array([0x60, 0, 0, 0]);      // version nibble 6
  const c = parsePcapContainer(buildPcap({ magic: 'be_us', linktype: 101,
    packets: [{ tsSec: 0, tsFrac: 0, data: v6body }] }));
  expect(c.packets[0].linktype).toBe(229);
});
it('records a truncated final record as an issue and keeps prior packets', () => {
  const good = buildPcap({ magic: 'be_us', linktype: 1,
    packets: [{ tsSec: 0, tsFrac: 0, data: new Uint8Array([1]) }] });
  const truncated = good.subarray(0, good.length - 1);  // drop last body byte
  const c = parsePcapContainer(truncated);
  expect(c.packets).toHaveLength(0);
  expect(c.issues[0].code).toBe('TRUNCATED_RECORD');
});
it('throws on unknown magic', () => {
  const bad = new Uint8Array(24);                       // all-zero magic
  expect(() => parsePcapContainer(bad)).toThrow(/UNRECOGNIZED_PCAP_MAGIC/);
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @byteql/pcap test -- --run container` → not defined.

- [ ] **Step 3: Implement `container.ts`**

Pure TS, no Kaitai. Read magic (try both byte orders against the 4 known constants); set
`byteOrder`/`timeUnit`. Read `snaplen`, `linktype`. Loop records with a `DataView` in the detected
endianness: 16-byte header then `inclLen` body bytes; `body = { bytes: bytes.subarray(off, off +
inclLen), start: off }`; `tsFracUs = timeUnit === 'ns' ? Math.floor(tsUsec / 1000) : tsUsec`. If a
header or body runs past `bytes.length`, push a `TRUNCATED_RECORD` issue and stop. For `linktype
=== 101`, set the packet's `linktype` to `228` if `body.bytes[0] >> 4 === 4`, else `229`. Unknown
magic → `throw new Error('UNRECOGNIZED_PCAP_MAGIC: ...')` (the pack turns this into a fatal
`errors`-only result in Task 7).

- [ ] **Step 4: Run — PASS.** Same command; expect all six PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/formats/pcap/src/container.ts packages/formats/pcap/test/container.test.ts
git commit -m "feat(pcap): add classic-pcap streaming framer with raw-IP normalization"
```

---

### Task 5: Field-flatten helpers (`src/flatten.ts`)

**Files:**

- Create: `packages/formats/pcap/src/flatten.ts`
- Test: `packages/formats/pcap/test/flatten.test.ts`

**Interfaces:**

- Produces (all pure, operate on already-parsed Kaitai nodes / byte arrays):
  - `tcpFlags(flagsByte: number): string` → e.g. `"SYN|ACK"` (order CWR,ECE,URG,ACK,PSH,RST,SYN,FIN;
    empty → `""`).
  - `dnsName(domainNameNode): string | null` → joins uncompressed labels with `.`; returns null if
    the first label is a compression pointer (`length >= 192`).
  - `dnsFlags(flag16: number): { qr; opcode; rcode }`.
  - `tlsSni(clientHelloNode): string | null` → walks `extensions.extensions[]`, finds `type === 0`,
    returns `sni.server_names[0].host_name` decoded as ASCII, else null.

- [ ] **Step 1: Write failing tests**

```ts
// flatten.test.ts
it('tcpFlags decodes SYN|ACK', () => {
  expect(tcpFlags(0x12)).toBe('SYN|ACK');   // 0x02 SYN | 0x10 ACK
  expect(tcpFlags(0)).toBe('');
});
it('dnsName joins uncompressed labels', () => {
  const node = { name: [
    { length: 3, name: 'www' }, { length: 7, name: 'example' },
    { length: 3, name: 'com' }, { length: 0 } ] };
  expect(dnsName(node)).toBe('www.example.com');
});
it('dnsName returns null on a leading compression pointer', () => {
  expect(dnsName({ name: [{ length: 0xc0 }] })).toBeNull();
});
it('dnsFlags splits qr/opcode/rcode', () => {
  expect(dnsFlags(0x8180)).toEqual({ qr: 1, opcode: 0, rcode: 0 });
});
```

Add a `tlsSni` test that builds the node shape produced by `TlsClientHello` (extensions →
extension{type:0, body: sni{ server_names:[{ host_name: Uint8Array of "a.com" }] }}).

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @byteql/pcap test -- --run flatten`.

- [ ] **Step 3: Implement `flatten.ts`** with the four functions per the interfaces above, decoding
  `host_name`/label bytes via `String.fromCharCode(...bytes)` (ASCII; hostnames are ASCII/punycode).

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Commit**

```bash
git add packages/formats/pcap/src/flatten.ts packages/formats/pcap/test/flatten.test.ts
git commit -m "feat(pcap): add tcp-flag, dns-name/flags, and tls-sni flatten helpers"
```

---

### Task 6: Kaitai wrappers + ParserRegistry (`src/wrappers.ts`, `src/parsers.ts`)

**Files:**

- Create: `packages/formats/pcap/src/wrappers.ts`, `packages/formats/pcap/src/parsers.ts`
- Test: `packages/formats/pcap/test/wrappers.test.ts`

**Interfaces:**

- Consumes: `gen/*.js` (Task 2), `flatten.ts` (Task 5), builders (Task 3).
- Produces: `pcapParserRegistry: ParserRegistry` mapping the 8 parser ids to `RecordParser`s. Each
  `RecordParser(bytes)` returns `{ root }` (no `resolve`; engine defaults provenance to the payload
  extent). Root shapes (the projection nodes read by the YAML):
  - `ethernet_frame` → `{ ether_type, body: { bytes, start } }` (`start` = Kaitai `_debug` offset of
    `body`).
  - `ipv4_packet` → `{ version: 4, l4_proto, hop_limit, length, is_v4: true, src_addr, dst_addr,
    body: { bytes, start } }` (`src_addr`/`dst_addr` are the raw 4-byte `Uint8Array`s).
  - `ipv6_packet` → `{ version: 6, l4_proto, hop_limit, length, is_v4: false, src_addr, dst_addr,
    body: { bytes, start } }` (16-byte addrs).
  - `tcp_segment` → `{ src_port, dst_port, seq_num, ack_num, flags, window_size, body: { bytes,
    start } }` (`flags` = `tcpFlags(...)`).
  - `udp_datagram` → `{ src_port, dst_port, length, body: { bytes, start } }`.
  - `dns_packet` → `{ transaction_id, qr, opcode, rcode, qdcount, ancount, query_name, query_type }`.
  - `icmp_packet` → `{ icmp_type, echo_id, echo_seq }` (echo_* null unless echo/echo_reply).
  - `tls_client_hello` → `{ client_hello: { tls_version, sni } }` when the bytes are a ClientHello
    (record type 0x16, handshake type 0x01), else `{}` (no `client_hello` → tls table emits no row).
- [ ] **Step 1: Write failing tests** (one per wrapper; representative two shown)

```ts
// wrappers.test.ts
it('ipv4 wrapper flattens addresses and exposes a payload-relative body range', () => {
  const bytes = ipv4({ protocol: 6, src: [10, 0, 0, 1], dst: [10, 0, 0, 2], payload: new Uint8Array([1, 2]) });
  const { root } = pcapParserRegistry.get('ipv4_packet')!(bytes);
  expect(root).toMatchObject({ version: 4, l4_proto: 6, is_v4: true });
  expect([...root.src_addr]).toEqual([10, 0, 0, 1]);
  expect(root.body.start).toBe(bytes.length - 2);        // body is the last 2 bytes
  expect([...root.body.bytes]).toEqual([1, 2]);
});
it('tls wrapper emits client_hello only for a ClientHello and extracts SNI', () => {
  const hello = tlsClientHello({ sni: 'secure.example' });
  const notHello = new Uint8Array([0x17, 0x03, 0x03, 0, 1, 0]); // app-data record
  expect(pcapParserRegistry.get('tls_client_hello')!(hello).root).toMatchObject({
    client_hello: { sni: 'secure.example' } });
  expect(pcapParserRegistry.get('tls_client_hello')!(notHello).root).toEqual({});
});
```

Add analogous tests for ethernet, ipv6, tcp (flags), udp, dns (query_name), icmp (echo id/seq).

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @byteql/pcap test -- --run wrappers`.

- [ ] **Step 3: Implement `wrappers.ts` + `parsers.ts`**

For each parser: instantiate `new GenClass(new KaitaiStream(bytes.buffer, bytes.byteOffset,
bytes.byteLength))`, call `_read()`, then build the flattened root. For `body: { bytes, start }`
read the Kaitai `_debug.body` offset (`parsed._debug.body.ioOffset + parsed._debug.body.start`) as
`start` and `parsed.body` as `bytes`. For `ether_type` use the parser's computed `etherType`
instance (handles VLAN). For tls: first validate `bytes[0] === 0x16 && bytes[5] === 0x01`; if not,
return `{ root: {} }`; else parse the ClientHello from `bytes.subarray(9)` and build
`client_hello` with `tls_version = "${major}.${minor}"` and `sni = tlsSni(parsed)`. Wrap every
`_read()` in nothing — let it throw; the engine converts a throw into a `DISSECT_PARSE_FAILED`
`errors` row. `parsers.ts` assembles and exports `pcapParserRegistry`.

- [ ] **Step 4: Run — PASS** (all wrapper tests).

- [ ] **Step 5: Commit**

```bash
git add packages/formats/pcap/src/wrappers.ts packages/formats/pcap/src/parsers.ts \
  packages/formats/pcap/test/wrappers.test.ts
git commit -m "feat(pcap): add layer wrappers and the dissect parser registry"
```

---

### Task 7: Projection spec + generated bundling (`pcap.tables.yaml`, `queries.yaml`)

**Files:**

- Create: `packages/formats/pcap/pcap.tables.yaml`, `packages/formats/pcap/queries.yaml`,
  `packages/formats/pcap/scripts/generate-pack.mjs`
- Test: `packages/formats/pcap/test/spec.test.ts`

**Interfaces:**

- Consumes: `pcapParserRegistry` (Task 6), `parseProjectionSpec`, `compileProjection`.
- Produces: `src/pcap-tables.generated.ts` (default-exports the YAML string) and
  `src/pcap-queries.generated.ts` (default-exports `PackQuery[]`); a spec that compiles against the
  registry.
- [ ] **Step 1: Author `pcap.tables.yaml`**

```yaml
version: '0.2'
format: pcap
tables:
  - name: packets
    rows: $
    key: packet_id
    columns:
      ts:       { expr: _.ts_sec * 1000000 + _.ts_frac_us, type: timestamp_us }
      caplen:   { expr: _.incl_len, type: uint32 }
      len:      { expr: _.orig_len, type: uint32 }
      linktype: { expr: _.linktype, type: uint32 }
  - name: ip
    rows: $
    key: ip_id
    parent_key: { table: packets, column: packet_id }
    columns:
      version:  { expr: _.version, type: int8 }
      src_addr: { expr: _.is_v4 ? ip4_str(_.src_addr) : ip6_str(_.src_addr), type: utf8 }
      dst_addr: { expr: _.is_v4 ? ip4_str(_.dst_addr) : ip6_str(_.dst_addr), type: utf8 }
      proto:    { expr: _.l4_proto, type: int16 }
      hop_limit:{ expr: _.hop_limit, type: int16 }
      length:   { expr: _.length, type: uint32 }
  - name: tcp
    rows: $
    key: tcp_id
    parent_key: { table: packets, column: packet_id }
    columns:
      src_port: { expr: _.src_port, type: uint16 }
      dst_port: { expr: _.dst_port, type: uint16 }
      seq:      { expr: _.seq_num, type: int64 }
      ack:      { expr: _.ack_num, type: int64 }
      flags:    { expr: _.flags, type: utf8 }
      window:   { expr: _.window_size, type: uint16 }
  - name: udp
    rows: $
    key: udp_id
    parent_key: { table: packets, column: packet_id }
    columns:
      src_port: { expr: _.src_port, type: uint16 }
      dst_port: { expr: _.dst_port, type: uint16 }
      length:   { expr: _.length, type: uint16 }
  - name: dns
    rows: $
    key: dns_id
    parent_key: { table: packets, column: packet_id }
    columns:
      tx_id:      { expr: _.transaction_id, type: uint16 }
      qr:         { expr: _.qr, type: int8 }
      query_name: { expr: _.query_name, type: utf8 }
      query_type: { expr: _.query_type, type: int16 }
      qd_count:   { expr: _.qdcount, type: uint16 }
      an_count:   { expr: _.ancount, type: uint16 }
  - name: icmp
    rows: $
    key: icmp_id
    parent_key: { table: packets, column: packet_id }
    columns:
      type:     { expr: _.icmp_type, type: int16 }
      echo_id:  { expr: _.echo_id, type: uint16 }
      echo_seq: { expr: _.echo_seq, type: uint16 }
  - name: tls
    rows: $.client_hello
    key: tls_id
    parent_key: { table: packets, column: packet_id }
    columns:
      tls_version: { expr: _.tls_version, type: utf8 }
      sni:         { expr: _.sni, type: utf8 }
dissect:
  - from: packets
    payload: _.body
    chain:
      - { when: _.linktype == 1,   parser: ethernet_frame }
      - { when: _.linktype == 228, parser: ipv4_packet, table: ip }
      - { when: _.linktype == 229, parser: ipv6_packet, table: ip }
  - from: ethernet_frame
    payload: _.body
    chain:
      - { when: _.ether_type == 0x0800, parser: ipv4_packet, table: ip }
      - { when: _.ether_type == 0x86dd, parser: ipv6_packet, table: ip }
  - from: ipv4_packet
    payload: _.body
    chain:
      - { when: _.l4_proto == 6,  parser: tcp_segment,  table: tcp }
      - { when: _.l4_proto == 17, parser: udp_datagram, table: udp }
      - { when: _.l4_proto == 1,  parser: icmp_packet,  table: icmp }
  - from: ipv6_packet
    payload: _.body
    chain:
      - { when: _.l4_proto == 6,  parser: tcp_segment,  table: tcp }
      - { when: _.l4_proto == 17, parser: udp_datagram, table: udp }
  - from: tcp_segment
    payload: _.body
    chain:
      - { when: _.dst_port == 443 or _.src_port == 443, parser: tls_client_hello, table: tls }
  - from: udp_datagram
    payload: _.body
    chain:
      - { when: _.dst_port == 53 or _.src_port == 53, parser: dns_packet, table: dns }
```

- [ ] **Step 2: Author `queries.yaml`** (`version: '0.1'`, `format: pcap`, `queries:` of `kind:
  grid`): an `overview` (row counts per table via `union all`), a `protocols` histogram
  (`select proto, count(*) from ip group by proto order by 2 desc`), and the showcase
  `dns_join` (`select p.ts, d.query_name, d.query_type from dns d join packets p using (packet_id)
  order by p.ts limit 100`).

- [ ] **Step 3: Create `scripts/generate-pack.mjs`** — adapt MIDI's: validate `queries.yaml`
  declares the pcap `0.1` query pack with `kind` in `['grid']`; emit `src/pcap-tables.generated.ts`
  and `src/pcap-queries.generated.ts`.

- [ ] **Step 4: Write failing test**

```ts
// spec.test.ts
import { parseProjectionSpec, compileProjection } from '@byteql/core';
import tablesYaml from '../src/pcap-tables.generated.js';
import { pcapParserRegistry } from '../src/parsers.js';
it('compiles the pcap spec against the parser registry', () => {
  const compiled = compileProjection(parseProjectionSpec(tablesYaml), pcapParserRegistry);
  expect(compiled.tables.map((t) => t.name)).toEqual(
    ['packets', 'ip', 'tcp', 'udp', 'dns', 'icmp', 'tls']);
});
```

- [ ] **Step 5: Run — FAIL then PASS**

Run: `pnpm --filter @byteql/pcap generate:pack && pnpm --filter @byteql/pcap test -- --run spec`
Expected: PASS. A `ProjectionCompileError` here means a `when`/`payload` references a field or
parser id the registry/spec doesn't define — reconcile names with Task 6's root shapes.

- [ ] **Step 6: Commit**

```bash
git add packages/formats/pcap/pcap.tables.yaml packages/formats/pcap/queries.yaml \
  packages/formats/pcap/scripts/generate-pack.mjs packages/formats/pcap/test/spec.test.ts
git commit -m "feat(pcap): add projection spec, dissect graph, and canned queries"
```

---

### Task 8: End-to-end projection (`src/project-pcap.ts`)

**Files:**

- Create: `packages/formats/pcap/src/project-pcap.ts`
- Test: `packages/formats/pcap/test/project-pcap.test.ts`

**Interfaces:**

- Consumes: `parsePcapContainer`, `pcapParserRegistry`, `compileProjection`,
  `createProjectionSession`, `IssueCollector`, `pcap-tables.generated`, `pcap-queries.generated`.
- Produces: `parseAndProjectPcap(bytes, signal, onProgress?): Promise<ParseResult>`, and
  `pcapNullability: Record<string, ReadonlySet<string>>`. `ParseResult.tables` includes `errors`.
- [ ] **Step 1: Write failing tests** (compose builders → assert the joined tables)

```ts
// project-pcap.test.ts — build one Ethernet/IPv4/UDP/DNS packet
const dns = dnsQuery({ txId: 0x1234, name: 'a.ru', type: 1 });
const pkt = ethFrame({ etherType: 0x0800,
  payload: ipv4({ protocol: 17, src: [1, 1, 1, 1], dst: [8, 8, 8, 8],
    payload: udp({ srcPort: 5000, dstPort: 53, payload: dns }) }) });
const pcap = buildPcap({ magic: 'be_us', linktype: 1, packets: [{ tsSec: 1, tsFrac: 0, data: pkt }] });

it('projects the full dissect chain with packet_id propagation', async () => {
  const result = await parseAndProjectPcap(pcap, new AbortController().signal);
  const names = result.tables.map((t) => t.name);
  expect(names).toContain('dns');
  const dnsTable = ipcToTable(result.tables.find((t) => t.name === 'dns')!.ipc);
  const row = dnsTable.get(0)!;
  expect(row.query_name).toBe('a.ru');
  expect(row.packet_id).toBe(0n);                        // parented to packets row 0
  const packets = ipcToTable(result.tables.find((t) => t.name === 'packets')!.ipc);
  expect(packets.get(0)!.packet_id).toBe(0n);
});
it('carries absolute provenance into the original file for a dns row', async () => {
  const result = await parseAndProjectPcap(pcap, new AbortController().signal);
  const dnsT = ipcToTable(result.tables.find((t) => t.name === 'dns')!.ipc);
  const start = Number(dnsT.get(0)!._src_start);
  // DNS payload begins after 40 (headers) + 14 (eth) + 20 (ipv4) + 8 (udp) bytes.
  expect(start).toBe(40 + 14 + 20 + 8);
});
it('turns a poison transport payload into an errors row, not a throw', async () => {
  const bad = ethFrame({ etherType: 0x0800,
    payload: ipv4({ protocol: 6, src: [1,1,1,1], dst: [2,2,2,2], payload: new Uint8Array([0]) }) });
  const p = buildPcap({ magic: 'be_us', linktype: 1, packets: [{ tsSec: 0, tsFrac: 0, data: bad }] });
  const result = await parseAndProjectPcap(p, new AbortController().signal);
  const errors = ipcToTable(result.tables.find((t) => t.name === 'errors')!.ipc);
  expect(errors.numRows).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @byteql/pcap test -- --run project-pcap`.

- [ ] **Step 3: Implement `project-pcap.ts`** (mirror `project-midi.ts` structure)

```ts
const compiled = compileProjection(parseProjectionSpec(tablesYaml), pcapParserRegistry);

export async function parseAndProjectPcap(bytes, signal, onProgress?) {
  throwIfAborted(signal);
  const container = parsePcapContainer(bytes);              // throws → fatal (Task 7 handles)
  const collector = new IssueCollector({ ordinalColumn: 'record' });
  for (const issue of container.issues)
    collector.report({ stage: 'framing', code: issue.code, message: issue.message,
      recoverable: true, sourceStart: issue.sourceStart, sourceEnd: issue.sourceEnd });

  const session = createProjectionSession(compiled, { issues: collector });
  for (const packet of container.packets) {
    throwIfAborted(signal);
    const resolver = { resolve: (table) =>
      table === 'packets' ? { start: packet.recordStart, end: packet.bodyEnd }
                          : { start: packet.body.start, end: packet.body.start + packet.body.bytes.length } };
    session.project(packet, resolver);
    await yieldToWorker();
    onProgress?.({ stage: 'projecting', completed: packet.index + 1, total: container.packets.length,
      label: `Projected packet ${packet.index + 1} of ${container.packets.length}` });
  }

  const errors = collector.table();
  const tables = [...session.finish(),
    { name: errors.name, arrow: projectedTableToArrow(errors), rowCount: errors.rowCount }]
    .map(toTransfer);
  return { format: { id: 'pcap', title: 'PCAP capture' }, tables, issues: collector.issues(),
    queries: pcapQueries, capabilities: {} };
}
```

Reuse `throwIfAborted`, `yieldToWorker`, and a `toTransfer` copied/adapted from `project-midi.ts`
(with `pcapNullability` marking `_src_*` and the version-specific/optional columns — `sni`,
`echo_id`, `echo_seq`, `query_name` — nullable). The dissected-table resolver only ever asks for
non-`packets` tables when `parsed.resolve` is undefined, so the engine's payload-extent default
already applies; the closure above is for the top-level `packets` row.

- [ ] **Step 4: Run — PASS** (all four). Verify `_src_start` equals `40+14+20+8`.

- [ ] **Step 5: Commit**

```bash
git add packages/formats/pcap/src/project-pcap.ts packages/formats/pcap/test/project-pcap.test.ts
git commit -m "feat(pcap): project the dissect chain to Arrow tables with provenance"
```

---

### Task 9: FormatPack façade (`src/pack.ts`, `src/index.ts`)

**Files:**

- Modify: `packages/formats/pcap/src/index.ts`
- Create: `packages/formats/pcap/src/pack.ts`
- Test: `packages/formats/pcap/test/pack.test.ts`

**Interfaces:**

- Produces: `pcapFormatPack: FormatPack` (`id: 'pcap'`, `title: 'PCAP capture'`), exported from
  `index.ts`. `probe` returns `1` when the first 4 bytes match any of the four pcap magics (either
  byte order), else `null`. `open` returns the eager `RecordSource` façade over
  `parseAndProjectPcap` (copy MIDI's `open`/`nextBatch`/`finish` drain logic verbatim, including the
  `RECORD_SOURCE_NOT_DRAINED` guard). `schemas()` returns the 7 table schemas + `errors`, column
  order = key, spec columns, provenance (mirror `MIDI_TABLE_SCHEMAS`).

- [ ] **Step 1: Write failing tests**

```ts
// pack.test.ts
it('probes pcap magic in both byte orders', () => {
  expect(pcapFormatPack.probe(new Uint8Array([0xa1, 0xb2, 0xc3, 0xd4]))).toBe(1);
  expect(pcapFormatPack.probe(new Uint8Array([0xd4, 0xc3, 0xb2, 0xa1]))).toBe(1);
  expect(pcapFormatPack.probe(new Uint8Array([0x4d, 0x54, 0x68, 0x64]))).toBeNull(); // MThd
});
it('open() drains to the projected tables then finish() returns', async () => {
  const pcap = buildPcap({ magic: 'be_us', linktype: 1,
    packets: [{ tsSec: 0, tsFrac: 0, data: new Uint8Array([0]) }] });
  const src = pcapFormatPack.open(pcap, { signal: new AbortController().signal, onProgress: () => {} });
  const seen: string[] = [];
  for (let b = await src.nextBatch(); b; b = await src.nextBatch()) seen.push(b.table);
  expect(seen).toContain('packets');
  expect(() => src.finish()).not.toThrow();
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm --filter @byteql/pcap test -- --run pack`.

- [ ] **Step 3: Implement `pack.ts`** mirroring `packages/formats/midi/src/pack.ts` (schemas +
  `open` façade), export `pcapFormatPack` from `src/index.ts`.

- [ ] **Step 4: Run — PASS.** Then full pack suite + built check:
  `pnpm --filter @byteql/pcap check && pnpm --filter @byteql/pcap test -- --run`.

- [ ] **Step 5: Commit**

```bash
git add packages/formats/pcap/src/pack.ts packages/formats/pcap/src/index.ts \
  packages/formats/pcap/test/pack.test.ts
git commit -m "feat(pcap): add FormatPack façade with magic probe and record source"
```

---

### Task 10: Register the pack in the web app + e2e

**Files:**

- Modify: `apps/web/package.json` (add `"@byteql/pcap": "workspace:*"`),
  `apps/web/src/workers/parse.worker.ts` (import + default packs array)
- Create: `apps/web/e2e/pcap.spec.ts`, `apps/web/e2e/fixtures/sample.pcap` (crafted)
- Test: `apps/web/e2e/pcap.spec.ts` (Playwright)

**Interfaces:**

- Consumes: `pcapFormatPack`. Order matters: MIDI and pcap magics don't collide, so append pcap.

- [ ] **Step 1: Register the pack**

In `parse.worker.ts` add `import { pcapFormatPack } from '@byteql/pcap';` and change the bottom
default install to `installParseWorker(workerScope /* uses default */)` — update the default
parameter to `packs: readonly FormatPack[] = [midiFormatPack, pcapFormatPack]`. Add the dependency
to `apps/web/package.json` and run `pnpm install`.

- [ ] **Step 2: Write the failing e2e**

```ts
// pcap.spec.ts — build sample.pcap in a Node pretest step (reuse test/build-pcap.ts) or check in
// a committed crafted fixture. The spec opens it via the existing file-input path and queries it.
test('opens a pcap and runs the DNS-join query', async ({ page }) => {
  await openAppReady(page);                       // existing helper pattern from midi e2e
  await uploadFile(page, 'e2e/fixtures/sample.pcap');
  await runSql(page, 'select query_name from dns join packets using (packet_id)');
  await expect(page.getByRole('gridcell', { name: 'a.ru' })).toBeVisible();
});
```

Mirror the existing MIDI e2e helpers in `apps/web/e2e/` for app-ready, upload, and run-SQL
(read the current MIDI spec to reuse its exact page objects).

- [ ] **Step 3: Run — FAIL then PASS**

Run: `pnpm --filter @byteql/web test:e2e -- pcap`
Expected: after registration, PASS. Then run the whole e2e suite so MIDI + privacy specs stay green:
`pnpm --filter @byteql/web test:e2e`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json apps/web/src/workers/parse.worker.ts apps/web/e2e/pcap.spec.ts \
  apps/web/e2e/fixtures/sample.pcap pnpm-lock.yaml
git commit -m "feat(web): register the pcap pack and add a pcap open-and-query e2e"
```

---

### Task 11: Full-workspace verification + docs

**Files:**

- Modify: `AGENTS.md` (status line: pcap pack shipped), `PRD.md` (Phase 1 progress line, if desired)
- Modify: `CHANGELOG.md` if present (add a pcap-pack entry)
- [ ] **Step 1: Run the whole gate**

Run: `pnpm -r check && pnpm -r test -- --run && pnpm --filter @byteql/web check:bundle`
Expected: all green; bundle audit shows no new network dependencies.

- [ ] **Step 2: Run e2e**

Run: `pnpm --filter @byteql/web test:e2e`
Expected: MIDI, pcap, and privacy specs all pass.

- [ ] **Step 3: Update docs**

Set the `AGENTS.md` status to note the pcap pack shipped and slices 2 (scale/intake) and 3
(hex-provenance UI) remain. If `CHANGELOG.md` exists, add an entry under the current version.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md PRD.md CHANGELOG.md
git commit -m "docs: record pcap pack completion and remaining Phase 1 slices"
```

---

## Self-review

**Spec coverage:** framer (T4) · 3 body patches (T2) · 8-parser registry (T6) · ip4_str/ip6_str
(T1) · 7-table union spec + dissect graph (T7) · parent_key propagation + absolute provenance (T8)
· eager RecordSource façade + probe (T9) · UI wiring + canned queries + fixtures (T3, T7, T10) ·
malformed → errors (T4, T8) · raw-IP + ns + snaplen edge cases (T4). All spec sections map to a
task.

**Refinements vs the design spec (folded in, none change scope):**

- Column sets finalized against the real `.ksy`: `dns.query_name` via wrapper label-assembly;
  `icmp` exposes `type` + `echo_id`/`echo_seq` (code is nested per-subtype upstream); `ip` union is
  normalized in the wrappers (`l4_proto`/`hop_limit`/`length`/`is_v4`) so the YAML stays simple.
- TLS: the wrapper de-frames the 5-byte record + 4-byte handshake header, emits `client_hello`
  conditionally (tls anchors `$.client_hello`, so non-ClientHello 443 segments yield no row and no
  error), and extracts SNI by walking extensions.
- Ethernet VLAN (802.1q) is handled for free by the vendored parser's `ether_type` instance.

**Placeholder scan:** no TBD/TODO; every code step shows real code; edge-case tests beyond the
representative ones are the engineer's to extend during each red/green cycle.

**Type consistency:** wrapper root field names (`l4_proto`, `is_v4`, `body.{bytes,start}`,
`query_name`, `client_hello`, `echo_id/seq`) match the YAML `expr:`/`when:` references and the
dissect `payload:` contract (`{ bytes, start }`). Parser ids match between `parsers.ts`, the dissect
`parser:` fields, and `compile.mjs` outputs.
