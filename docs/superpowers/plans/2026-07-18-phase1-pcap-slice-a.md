# pcap Dissect Extensions (Slice A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the shipped `@byteql/pcap` pack with three dissect features — normalized `ip.length`,
single-segment DNS-over-TCP, and ICMPv6 — with no new engine capability and no new container.

**Architecture:** All three extend the existing pack's per-parser wrappers and the declarative
dissect graph in `pcap.tables.yaml`. DNS-over-TCP reuses the TLS conditional-emission pattern (a
`$.message` anchor); ICMPv6 adds a byteql-authored `.ksy`, an 8th table, and an `ipv6 next_header==58`
dissect link. Delivery, provenance, and the worker/UI path are unchanged.

**Tech Stack:** TypeScript, Kaitai Struct JS runtime + compiler (`^0.11`), Apache Arrow JS, vitest,
pnpm workspace.

## Global Constraints

- **Arrow IPC at every boundary;** every row carries hidden `_src_start`/`_src_end` (uint64). The
  engine fills them.
- **`packages/formats/pcap` stays zero-DOM.** Parsers treat input as hostile: a malformed/empty
  payload becomes an `errors` row or no row — never a throw out of the pack.
- **Conditional emission** for parsers whose dissect guard fires on non-matching segments: return
  `{ root: {} }` (an empty root object, NOT `null`) so a `$.<field>` anchor finds no match and emits
  nothing. (Mirror `tlsClientHello` in `wrappers.ts`.)
- **Provenance:** dissected tables omit `resolve`; the engine defaults each row's provenance to the
  full payload extent. Do not add per-row resolvers.
- **`ip.length` = total on-wire IP datagram length** (header + payload) for both v4 and v6.
- **`icmpv6.ksy` is byteql-authored, not vendored** — lives only in `ksy/`, no `network/` counterpart;
  note its authored status in the file header and in `PATCHES.md`.
- **MIDI + existing pcap suites stay green at every step.** Full gate: `pnpm -r check`,
  `pnpm -r test -- --run`, `pnpm --filter @byteql/web check:bundle`, `pnpm --filter @byteql/web test:e2e`.
- **Format gate:** `pnpm format` / `npx prettier --config prettier.config.js --check <files>` clean +
  eslint clean before every commit. (Note: `docs/superpowers/` and `PRD.md` are prettier-ignored;
  everything under `packages/` is not. `.ksy` and `.md` under `packages/` ARE prettier-managed.)
- **Conventional commits; no Co-Authored-By trailers or AI branding.**

## Reference: current shapes (verified) that tasks modify

- `packages/formats/pcap/src/wrappers.ts`:
  - `ipv6Packet` maps `length: parsed.payloadLength` (line ~105).
  - `dnsPacket` returns a FLAT root `{ transaction_id, qr, opcode, rcode, qdcount, ancount,
    query_name, query_type }` built from `dnsFlags(parsed.flags.flag)` + `dnsName(firstQuery.name)`.
  - `icmpPacket` returns `{ icmp_type: parsed.icmpType, echo_id, echo_seq }`.
  - `tlsClientHello` is the conditional-emission template: guards on `bytes[0]`/`bytes[5]`, returns
    `{ root: {} }` when not a ClientHello, else `{ root: { client_hello: {...} } }`.
  - Helpers in scope: `parse(GenClass, bytes)`, `bodyRange(parsed)`, and from `./flatten.js`:
    `dnsFlags`, `dnsName`, `tcpFlags`, `tlsSni`.
- `packages/formats/pcap/src/parsers.ts`: `pcapParserRegistry` — a `Map<string, RecordParser>` of the
  8 current wrappers keyed by parser id.
- `packages/formats/pcap/pcap.tables.yaml`: `dns` table anchors `rows: $`; `icmp` table has columns
  `type/echo_id/echo_seq`; dissect has `from: tcp_segment` (→ tls on 443) and `from: ipv6_packet`
  (→ tcp/udp). `tls` table already anchors `rows: $.client_hello`.
- `packages/formats/pcap/src/project-pcap.ts`: `pcapNullability` maps each table to its nullable
  column set (dns already lists `query_name`, `query_type`).
- `packages/formats/pcap/src/pack.ts`: `MIDI_TABLE_SCHEMAS`-style `columns('<table>', [[name,type],…])`
  entries, per-table order `key, packet_id (child tables), spec columns, _src_start, _src_end`.
- `packages/formats/pcap/ksy/icmp_packet.ksy`: ICMPv4 spec; its `echo_msg` subtype (`identifier: u2`,
  `seq_num: u2`) is the template for the ICMPv6 echo body.
- `packages/formats/pcap/scripts/compile.mjs` globs `ksy/*.ksy`, so a new `ksy/icmpv6.ksy` compiles
  automatically (no script change). `packages/formats/pcap/test/build-pcap.ts` holds the fixture
  builders (`ipv6`, `tcp`, `dnsQuery`, `icmpEcho`, `buildPcap`, `ethFrame`, …).

---

### Task 1: Normalize `ip.length` (IPv6 includes the 40-byte header)

**Files:**

- Modify: `packages/formats/pcap/src/wrappers.ts` (the `ipv6Packet` wrapper, `length:` line)
- Test: `packages/formats/pcap/test/wrappers.test.ts`

**Interfaces:**

- Produces: the `ip` table's `length` column now equals the full IP datagram length for both
  versions (v4 `total_length`; v6 `payload_length + 40`).

- [ ] **Step 1: Write the failing test**

Add to `wrappers.test.ts` (mirror the existing ipv6 wrapper test's construction of a built IPv6
layer via the Task-3 `ipv6` builder):

```ts
it('ipv6 wrapper reports total on-wire length (payload_length + 40)', () => {
  const payload = new Uint8Array([1, 2, 3, 4]);          // 4-byte L4 payload
  const bytes = ipv6({ nextHeader: 6, src: new Uint8Array(16), dst: new Uint8Array(16), payload });
  const { root } = pcapParserRegistry.get('ipv6_packet')!(bytes);
  expect(root.length).toBe(payload.length + 40);          // 4 + 40 = 44
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @byteql/pcap test -- --run wrappers`
Expected: FAIL — `root.length` is 4 (payload_length), not 44.

- [ ] **Step 3: Implement**

In `wrappers.ts`, the `ipv6Packet` wrapper: change `length: parsed.payloadLength` to
`length: parsed.payloadLength + 40`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @byteql/pcap test -- --run wrappers` → PASS. Then the full pcap suite
`pnpm --filter @byteql/pcap test -- --run` stays green (the existing project-pcap ipv6 tests, if any
assert `ip.length`, must be updated to the +40 value — update them if present).

- [ ] **Step 5: Commit**

```bash
git add packages/formats/pcap/src/wrappers.ts packages/formats/pcap/test/wrappers.test.ts
git commit -m "fix(pcap): normalize ip.length to total on-wire length for ipv6"
```

---

### Task 2: DNS-over-TCP (single-segment) via conditional `$.message` emission

**Files:**

- Modify: `packages/formats/pcap/src/wrappers.ts` (extract `flattenDns`; refactor `dnsPacket`; add
  `dnsTcpMessage`)
- Modify: `packages/formats/pcap/src/parsers.ts` (register `dns_tcp_message`)
- Modify: `packages/formats/pcap/pcap.tables.yaml` (`dns` anchor `$` → `$.message`; add the
  `from: tcp_segment` dns link)
- Modify: `packages/formats/pcap/test/build-pcap.ts` (add `dnsOverTcp` payload builder)
- Test: `packages/formats/pcap/test/wrappers.test.ts`, `packages/formats/pcap/test/project-pcap.test.ts`

**Interfaces:**

- Consumes: `parse`, `DnsPacket`, `dnsFlags`, `dnsName` (already in `wrappers.ts`); the Task-3 `tcp`
  and `dnsQuery` builders.
- Produces: `flattenDns(parsed): { transaction_id, qr, opcode, rcode, qdcount, ancount, query_name,
  query_type }`; wrappers `dnsPacket` and `dnsTcpMessage` both return `{ root: { message: … } }` (or
  `{ root: {} }` for `dnsTcpMessage` on non-DNS/fragmented input); a `dnsOverTcp({ txId, name, type })`
  builder returning `Uint8Array` = 2-byte BE length prefix + DNS message bytes.
- [ ] **Step 1: Write the failing tests**

Wrapper tests (`wrappers.test.ts`):

```ts
it('dns_tcp_message emits a message for a length-prefixed DNS query', () => {
  const bytes = dnsOverTcp({ txId: 0x1234, name: 'a.ru', type: 1 });
  const { root } = pcapParserRegistry.get('dns_tcp_message')!(bytes);
  expect(root.message.query_name).toBe('a.ru');
});
it('dns_tcp_message emits nothing for an empty/handshake segment', () => {
  expect(pcapParserRegistry.get('dns_tcp_message')!(new Uint8Array(0)).root).toEqual({});
  expect(pcapParserRegistry.get('dns_tcp_message')!(new Uint8Array([0, 0])).root).toEqual({});
});
it('dns_tcp_message emits nothing when the message spans segments (over-length prefix)', () => {
  const full = dnsOverTcp({ txId: 1, name: 'a.ru', type: 1 });
  const truncated = full.subarray(0, full.length - 1);    // declared length now exceeds available
  expect(pcapParserRegistry.get('dns_tcp_message')!(truncated).root).toEqual({});
});
```

Projection tests (`project-pcap.test.ts`, using the eth→ipv4→tcp→dns path):

```ts
it('projects a dns row from a single-segment DNS-over-TCP query', async () => {
  const pkt = ethFrame({ etherType: 0x0800, payload: ipv4({ protocol: 6, src: [1,1,1,1], dst: [2,2,2,2],
    payload: tcp({ srcPort: 5000, dstPort: 53, payload: dnsOverTcp({ txId: 9, name: 'a.ru', type: 1 }) }) }) });
  const pcap = buildPcap({ magic: 'be_us', linktype: 1, packets: [{ tsSec: 1, tsFrac: 0, data: pkt }] });
  const result = await parseAndProjectPcap(pcap, new AbortController().signal);
  const dns = findTable(result, 'dns');
  expect(dns.get(0)!.query_name).toBe('a.ru');
});
it('projects NO dns row for a tcp:53 handshake segment', async () => {
  const pkt = ethFrame({ etherType: 0x0800, payload: ipv4({ protocol: 6, src: [1,1,1,1], dst: [2,2,2,2],
    payload: tcp({ srcPort: 5000, dstPort: 53, flags: 0x02 /* SYN */, payload: new Uint8Array(0) }) }) });
  const pcap = buildPcap({ magic: 'be_us', linktype: 1, packets: [{ tsSec: 1, tsFrac: 0, data: pkt }] });
  const result = await parseAndProjectPcap(pcap, new AbortController().signal);
  expect(findTable(result, 'dns').numRows).toBe(0);
});
```

(The existing udp:53 DNS projection test is the `$.message` regression guard — keep it; it must still
pass unchanged after the refactor.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @byteql/pcap test -- --run` → FAIL (`dns_tcp_message`/`dnsOverTcp` undefined; the
handshake test would emit a row under the old `$` anchor).

- [ ] **Step 3: Implement**

In `wrappers.ts`, extract the shared flattener and refactor both DNS wrappers:

```ts
const flattenDns = (parsed: InstanceType<typeof DnsPacket>) => {
  const { qr, opcode, rcode } = dnsFlags(parsed.flags.flag);
  const qdcount = parsed.qdcount ?? 0;
  const firstQuery = qdcount > 0 ? parsed.queries?.[0] : undefined;
  return {
    transaction_id: parsed.transactionId,
    qr, opcode, rcode, qdcount,
    ancount: parsed.ancount ?? 0,
    query_name: firstQuery ? dnsName(firstQuery.name) : null,
    query_type: firstQuery ? firstQuery.type : null,
  };
};

export const dnsPacket: RecordParser = (bytes) => ({
  root: { message: flattenDns(parse(DnsPacket, bytes)) },
});

export const dnsTcpMessage: RecordParser = (bytes) => {
  if (bytes.length < 2) return { root: {} };
  const declaredLen = (bytes[0]! << 8) | bytes[1]!;
  if (declaredLen === 0 || 2 + declaredLen > bytes.length) return { root: {} };
  return { root: { message: flattenDns(parse(DnsPacket, bytes.subarray(2, 2 + declaredLen))) } };
};
```

In `parsers.ts`, add `['dns_tcp_message', dnsTcpMessage]` to the registry (and import it).

In `pcap.tables.yaml`: change the `dns` table `rows: $` → `rows: $.message`; add to the existing
`from: tcp_segment` chain (after the tls link):

```yaml
      - { when: _.dst_port == 53 or _.src_port == 53, parser: dns_tcp_message, table: dns }
```

In `build-pcap.ts`, add:

```ts
export function dnsOverTcp(opts: { txId: number; name: string; type: number }): Uint8Array {
  const msg = dnsQuery(opts);                 // existing DNS-message builder
  const out = new Uint8Array(2 + msg.length);
  new DataView(out.buffer).setUint16(0, msg.length, false);   // 2-byte BE length prefix
  out.set(msg, 2);
  return out;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @byteql/pcap test -- --run` → PASS, including the untouched udp:53 DNS
regression test. If the udp test fails, the `$.message` nesting is inconsistent between the wrapper
and the YAML anchor — reconcile.

- [ ] **Step 5: Commit**

```bash
git add packages/formats/pcap/src/wrappers.ts packages/formats/pcap/src/parsers.ts \
  packages/formats/pcap/pcap.tables.yaml packages/formats/pcap/test/build-pcap.ts \
  packages/formats/pcap/test/wrappers.test.ts packages/formats/pcap/test/project-pcap.test.ts
git commit -m "feat(pcap): dissect single-segment DNS-over-TCP into the dns table"
```

---

### Task 3: ICMPv6

**Files:**

- Create: `packages/formats/pcap/ksy/icmpv6.ksy`
- Modify: `packages/formats/pcap/PATCHES.md` (note the authored-not-vendored `.ksy`)
- Modify: `packages/formats/pcap/src/wrappers.ts` (add `icmpv6Packet`; import `Icmpv6Packet` from gen)
- Modify: `packages/formats/pcap/src/parsers.ts` (register `icmpv6_packet`)
- Modify: `packages/formats/pcap/pcap.tables.yaml` (add `icmpv6` table + the `ipv6 → icmpv6` link)
- Modify: `packages/formats/pcap/src/project-pcap.ts` (add `icmpv6` to `pcapNullability`)
- Modify: `packages/formats/pcap/src/pack.ts` (add the `icmpv6` schema)
- Modify: `packages/formats/pcap/test/build-pcap.ts` (add `icmpv6Echo` + a non-echo builder)
- Test: `packages/formats/pcap/test/wrappers.test.ts`, `packages/formats/pcap/test/project-pcap.test.ts`

**Interfaces:**

- Produces: parser id `icmpv6_packet` → `{ icmp_type, code, echo_id, echo_seq }`; a new `icmpv6` table
  (`type`, `code`, `echo_id`, `echo_seq`); `icmpv6Echo({ id, seq })` and `icmpv6Type({ type, code })`
  builders returning `Uint8Array`.

- [ ] **Step 1: Write `ksy/icmpv6.ksy`**

```yaml
meta:
  id: icmpv6_packet
  title: ICMPv6 packet (byteql-authored; no upstream Kaitai spec exists)
  endian: be
seq:
  - id: icmp_type
    type: u1
  - id: code
    type: u1
  - id: checksum
    type: u2
  - id: echo
    type: echo_msg
    if: icmp_type == 128 or icmp_type == 129
types:
  echo_msg:
    seq:
      - id: identifier
        type: u2
      - id: seq_num
        type: u2
```

Add a `PATCHES.md` note: `icmpv6.ksy` is byteql-authored (no `network/` counterpart; no upstream
Kaitai ICMPv6 spec as of the pinned commit).

- [ ] **Step 2: Write the failing tests**

Wrapper tests (`wrappers.test.ts`):

```ts
it('icmpv6 wrapper flattens an echo request', () => {
  const bytes = icmpv6Echo({ id: 0xabcd, seq: 7 });       // type 128
  const { root } = pcapParserRegistry.get('icmpv6_packet')!(bytes);
  expect(root).toMatchObject({ icmp_type: 128, code: 0, echo_id: 0xabcd, echo_seq: 7 });
});
it('icmpv6 wrapper leaves echo fields null for a non-echo type', () => {
  const bytes = icmpv6Type({ type: 1, code: 0 });          // destination unreachable
  const { root } = pcapParserRegistry.get('icmpv6_packet')!(bytes);
  expect(root).toMatchObject({ icmp_type: 1, echo_id: null, echo_seq: null });
});
```

Projection test (`project-pcap.test.ts`, eth→ipv6→icmpv6):

```ts
it('projects an icmpv6 row for ipv6 next-header 58', async () => {
  const pkt = ethFrame({ etherType: 0x86dd, payload: ipv6({ nextHeader: 58,
    src: new Uint8Array(16), dst: new Uint8Array(16), payload: icmpv6Echo({ id: 5, seq: 9 }) }) });
  const pcap = buildPcap({ magic: 'be_us', linktype: 1, packets: [{ tsSec: 1, tsFrac: 0, data: pkt }] });
  const result = await parseAndProjectPcap(pcap, new AbortController().signal);
  const t = findTable(result, 'icmpv6');
  expect(t.get(0)!.type).toBe(128);
  expect(t.get(0)!.packet_id).toBe(1n);                    // parented to the packet
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @byteql/pcap test -- --run` → FAIL (gen class + wrapper + table + builders
missing). Running the suite invokes `compile:ksy`, which now compiles `icmpv6.ksy` to
`gen/Icmpv6Packet.js`.

- [ ] **Step 4: Implement**

`wrappers.ts` (import `Icmpv6Packet` from `../gen/Icmpv6Packet.js` alongside the other gen imports):

```ts
export const icmpv6Packet: RecordParser = (bytes) => {
  const parsed = parse(Icmpv6Packet, bytes);
  const echo = parsed.echo;
  return {
    root: {
      icmp_type: parsed.icmpType,
      code: parsed.code,
      echo_id: echo ? echo.identifier : null,
      echo_seq: echo ? echo.seqNum : null,
    },
  };
};
```

`parsers.ts`: add `['icmpv6_packet', icmpv6Packet]`.

`pcap.tables.yaml`: add the table (after `icmp`):

```yaml
  - name: icmpv6
    rows: $
    key: icmpv6_id
    parent_key: { table: packets, column: packet_id }
    columns:
      type: { expr: _.icmp_type, type: int16 }
      code: { expr: _.code, type: int16 }
      echo_id: { expr: _.echo_id, type: uint16 }
      echo_seq: { expr: _.echo_seq, type: uint16 }
```

and add to the `from: ipv6_packet` chain:

```yaml
      - { when: _.l4_proto == 58, parser: icmpv6_packet, table: icmpv6 }
```

`project-pcap.ts` `pcapNullability`: add
`icmpv6: new Set(['_src_start', '_src_end', 'echo_id', 'echo_seq'])`.

`pack.ts` `schemas()`: add (mirroring the `icmp` block, with `code`):

```ts
  columns('icmpv6', [
    ['icmpv6_id', 'int64'],
    ['packet_id', 'int64'],
    ['type', 'int16'],
    ['code', 'int16'],
    ['echo_id', 'uint16'],
    ['echo_seq', 'uint16'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
```

`build-pcap.ts`:

```ts
export function icmpv6Type(opts: { type: number; code: number }): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = opts.type; b[1] = opts.code;                       // checksum bytes 2..3 left 0
  return b;
}
export function icmpv6Echo(opts: { id: number; seq: number }): Uint8Array {
  const b = new Uint8Array(8);
  b[0] = 128;                                               // echo request
  new DataView(b.buffer).setUint16(4, opts.id, false);
  new DataView(b.buffer).setUint16(6, opts.seq, false);
  return b;
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter @byteql/pcap test -- --run` → PASS. If a `spec.test`/`pack` test enumerates the
table set, update it to include `icmpv6` (7→8 tables).

- [ ] **Step 6: Commit**

```bash
git add packages/formats/pcap/ksy/icmpv6.ksy packages/formats/pcap/PATCHES.md \
  packages/formats/pcap/src/wrappers.ts packages/formats/pcap/src/parsers.ts \
  packages/formats/pcap/pcap.tables.yaml packages/formats/pcap/src/project-pcap.ts \
  packages/formats/pcap/src/pack.ts packages/formats/pcap/test/build-pcap.ts \
  packages/formats/pcap/test/wrappers.test.ts packages/formats/pcap/test/project-pcap.test.ts
git commit -m "feat(pcap): add ICMPv6 parser, table, and ipv6 next-header dissect"
```

---

### Task 4: Full-workspace verification + docs

**Files:**

- Modify: `AGENTS.md` (note the Slice A extensions on the pcap pack)

- [ ] **Step 1: Run the full gate**

Run:

```bash
pnpm -r check && pnpm -r test -- --run && pnpm --filter @byteql/web check:bundle
```

Expected: all green (typecheck+lint+format; core/db/pcap/midi/web suites; bundle audit shows no new
network deps — no new external dependency was added).

- [ ] **Step 2: Run e2e**

Run: `pnpm --filter @byteql/web test:e2e`
Expected: MIDI, pcap, and privacy specs all pass (the new tables are additive; the existing pcap e2e
is unaffected).

- [ ] **Step 3: Update docs**

`AGENTS.md`: in the pcap-pack status line, note the Slice A dissect extensions shipped (normalized
`ip.length`, single-segment DNS-over-TCP, ICMPv6); keep the deferred list accurate (TCP reassembly,
multi-segment TLS/DNS-over-TCP, pcapng remain). Run `rumdl fmt AGENTS.md`; ensure it still passes
`pnpm -r check` (prettier).

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs: record pcap Slice A dissect extensions"
```

---

## Self-review

**Spec coverage:** `ip.length` normalization (T1) · DNS-over-TCP single-segment with conditional
`$.message` emission + handshake/over-length skip + udp regression (T2) · ICMPv6 authored `.ksy` +
wrapper + `icmpv6` table + `ipv6 next_header==58` link + schema + nullability (T3) · full-gate
verification + docs (T4). Every design section maps to a task.

**Placeholder scan:** no TBD/TODO; every code step shows real code grounded in the verified current
shapes.

**Type consistency:** `dnsPacket` and `dnsTcpMessage` both return `{ root: { message: flattenDns(...) } }`
so the `dns` table's `$.message` anchor matches both; parser ids `dns_tcp_message`/`icmpv6_packet`
match between `parsers.ts`, the dissect `parser:` fields, and `compile.mjs` output (`Icmpv6Packet`);
`icmpv6` appears consistently in the YAML table, `schemas()`, and `pcapNullability`.
