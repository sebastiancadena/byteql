# Vendored Kaitai network formats — provenance

These `.ksy` files are **byte-identical, unmodified** copies vendored from the
upstream Kaitai format gallery for the ByteQL pcap pack (PRD Phase 1).

| Field | Value |
|---|---|
| Source repo | <https://github.com/kaitai-io/kaitai_struct_formats> (`network/`) |
| Web gallery | <https://formats.kaitai.io/> |
| Pinned commit | `1818b5447c1aaf51084999f1ce2c6c40b57b752e` (`master`) |
| Fetched | 2026-07-18 |

Kept unmodified on purpose: this directory is the clean provenance baseline.
The byteql-specific patching (see **Phase 1 patch notes** below) happens on top
of this, mirroring how the MIDI pack "vendored, then patched" its `.ksy`.

## Layout rationale

Files live under `network/` (not the pack root) so the upstream
`imports: /network/<name>` paths resolve **without editing a single file** — the
same within-package resolution the MIDI pack's `compile.mjs` uses for
`/common/vlq_base128_be`. The leading `/network/` maps to this directory.

## Files, licenses, and role

All files are `CC0-1.0` except `tls_client_hello.ksy` (`MIT`) — both permissive.
The SPDX id is declared in each file's `meta.license`.

### ByteQL dissect chain (PRD Appendix A worked example)

| File | License | Role in byteql |
|---|---|---|
| `pcap.ksy` | CC0-1.0 | Container. **Not** compiled as an eager Kaitai root — a thin streaming framer replaces it (see notes). Source of the linktype/magic enums. |
| `ethernet_frame.ksy` | CC0-1.0 | L2 dissector. `ether_type` selects ipv4/ipv6. |
| `ipv4_packet.ksy` | CC0-1.0 | L3 dissector. `protocol` selects tcp/udp/icmp. |
| `ipv6_packet.ksy` | CC0-1.0 | L3 dissector. `next_header_type` selects tcp/udp/icmp. |
| `tcp_segment.ksy` | CC0-1.0 | L4 dissector. Port selects dns/tls. |
| `udp_datagram.ksy` | CC0-1.0 | L4 dissector. Port 53 selects dns. |
| `dns_packet.ksy` | CC0-1.0 | Leaf parser (application layer). |

### Explicit v1-scope extra

| File | License | Role |
|---|---|---|
| `tls_client_hello.ksy` | MIT | Leaf parser. PRD scopes TLS to "ClientHello fits in one segment"; reassembly is Phase 2+. |

### Pulled in only to keep the upstream set self-contained & compilable

These satisfy upstream `imports:` for a faithful copy. Under byteql's model the
declarative dissect registry supersedes Kaitai's auto-descent, so these become
unused once the `body` fields below are patched to raw blobs — candidates for
removal in Phase 1.

| File | License | Why present |
|---|---|---|
| `protocol_body.ksy` | CC0-1.0 | Kaitai's protocol-number "router" imported by ipv4/ipv6. ByteQL's dissect registry replaces it. |
| `icmp_packet.ksy` | CC0-1.0 | Imported by `protocol_body`; also a legitimate future L4 dissector target. |
| `packet_ppi.ksy` | CC0-1.0 | PPI linktype, imported by `pcap.ksy`. Only relevant if we support DLT 192. |

## Import graph (upstream, as vendored)

```text
pcap ──> ethernet_frame ──> ipv4_packet ──> protocol_body ──┐
     └─> packet_ppi ──> ethernet_frame     ipv6_packet ──> ─┤
                                                            ├─> tcp_segment
protocol_body ──────────────────────────────────────────── ┼─> udp_datagram
                                                            ├─> icmp_packet
                                                            ├─> ipv4_packet (recursion)
                                                            └─> ipv6_packet (recursion)

dns_packet          (standalone leaf)
tls_client_hello    (standalone leaf, MIT)
```

## Phase 1 patch notes (do NOT apply here — this dir stays pristine)

ByteQL's architecture (PRD §9, Appendix A) inverts Kaitai's auto-descent: each
layer parser must **stop at a raw `body` blob**, and the declarative dissect
registry in `pcap.tables.yaml` routes that blob to the child parser. Concretely:

- **`pcap.ksy` — replace the eager root.** `seq.packets` uses `repeat: eos`
  (eager, whole-file). PRD mandates a thin streaming framer instead: the record
  header is 16 bytes (`ts_sec`, `ts_usec`, `incl_len`, `orig_len`, all u4). The
  framer slices each record's `body` and hands it to the registry.
  - Endianness + µs/ns comes from `magic_number` (`0xa1b2c3d4` = BE µs, etc.).
  - The L2 parser is selected by `hdr.network` (linktype; `1` = ethernet).
  - Upstream quirk to fix in the framer: packet `body` size is
    `incl_len < snaplen ? incl_len : snaplen` — use `incl_len` directly.
- **`ipv4_packet.ksy`** — `body` is `type: protocol_body(protocol)`. Patch to a
  raw blob (`size: total_length - ihl_bytes`, no `type:`) and drop the
  `/network/protocol_body` import. Registry routes on `protocol` (6→tcp, 17→udp,
  1→icmp).
- **`ipv6_packet.ksy`** — same: `body` is `protocol_body(next_header_type)` →
  raw blob, drop import.
- **`ethernet_frame.ksy`** — `body` switches on `ether_type`. Patch to raw blob;
  registry routes (0x0800→ipv4, 0x86DD→ipv6).
- **`tcp_segment.ksy` / `udp_datagram.ksy`** — body already terminal; registry
  routes on port (53→dns; tcp 443→tls_client_hello, ClientHello-in-one-segment
  only).
- Once the above land, `protocol_body.ksy` and `packet_ppi.ksy` are unused and
  can be pruned unless we choose to support the PPI linktype.

See `docs/superpowers/specs/2026-07-18-phase1-generalization-prep-design.md` for
the binding runtime contracts (payload offset convention, drain-before-finish).
