# pcap `.ksy` patches

The `.ksy` files under `ksy/` are copies of the pristine vendored files in
`network/` (see `network/PROVENANCE.md`), pinned to upstream commit
[`1818b5447c1aaf51084999f1ce2c6c40b57b752e`](https://github.com/kaitai-io/kaitai_struct_formats/tree/1818b5447c1aaf51084999f1ce2c6c40b57b752e/network)
on `kaitai-io/kaitai_struct_formats` (`master`).

ByteQL's architecture (PRD §9, Appendix A) inverts Kaitai's auto-descent: each
layer parser must **stop at a raw `body` blob**, and the declarative dissect
registry (a future task's `pcap.tables.yaml`) routes that blob to the next
layer's parser. Three of the eight files needed edits to reach that shape; the
other five (`tcp_segment.ksy`, `udp_datagram.ksy`, `dns_packet.ksy`,
`icmp_packet.ksy`, `tls_client_hello.ksy`) already terminate at a raw/typed
leaf and have no `imports:`, so they are copied unmodified.

## `ethernet_frame.ksy`

Dropped the `meta.imports` block (`/network/ipv4_packet`, `/network/ipv6_packet`)
and removed the `body` field's `type:` switch, keeping `size-eos: true` so the
field is a raw byte blob instead of an eagerly-parsed `ipv4_packet` /
`ipv6_packet` object. The `ether_type` instance (used by the future registry to
route the blob) is left in place.

**Before:**

```yaml
meta:
  id: ethernet_frame
  ...
  ks-version: 0.8
  imports:
    - /network/ipv4_packet
    - /network/ipv6_packet
...
seq:
  ...
  - id: body
    size-eos: true
    type:
      switch-on: ether_type
      cases:
        'ether_type_enum::ipv4': ipv4_packet
        'ether_type_enum::ipv6': ipv6_packet
```

**After:**

```yaml
meta:
  id: ethernet_frame
  ...
  ks-version: 0.8
...
seq:
  ...
  - id: body
    size-eos: true
```

## `ipv4_packet.ksy`

Dropped the `meta.imports` block (`/network/protocol_body`) and removed
`type: protocol_body(protocol)` from the `body` field, keeping
`size: total_length - ihl_bytes`. The `protocol` field (used by the future
registry to route the blob: 6 -> tcp, 17 -> udp, 1 -> icmp) is left in place.

**Before:**

```yaml
meta:
  id: ipv4_packet
  ...
  ks-version: 0.8
  imports:
    - /network/protocol_body
seq:
  ...
  - id: body
    size: total_length - ihl_bytes
    type: protocol_body(protocol)
```

**After:**

```yaml
meta:
  id: ipv4_packet
  ...
  ks-version: 0.8
seq:
  ...
  - id: body
    size: total_length - ihl_bytes
```

## `ipv6_packet.ksy`

Dropped the `meta.imports` block (`/network/protocol_body`) and replaced both
the `next_header` field (typed `protocol_body(next_header_type)`) and the
trailing `rest` field (`size-eos: true`) with a single raw `body` field sized
by `payload_length`. The `next_header_type` field (used by the future registry
to route the blob) is left in place.

**Before:**

```yaml
meta:
  id: ipv6_packet
  title: IPv6 network packet
  license: CC0-1.0
  ks-version: 0.8
  imports:
    - /network/protocol_body
  endian: be
seq:
  ...
  - id: next_header
    type: protocol_body(next_header_type)
  - id: rest
    size-eos: true
```

**After:**

```yaml
meta:
  id: ipv6_packet
  title: IPv6 network packet
  license: CC0-1.0
  ks-version: 0.8
  endian: be
seq:
  ...
  - id: body
    size: payload_length
```

## `icmpv6.ksy`

Byteql-authored, not vendored: as of the pinned upstream commit,
`kaitai-io/kaitai_struct_formats`'s `network/` directory has no ICMPv6 spec,
so there is nothing to copy or patch. `ksy/icmpv6.ksy` lives only under
`ksy/` and has no `network/` counterpart. It mirrors `icmp_packet.ksy`'s
shape (an `echo_msg` subtype for echo request/reply) but adds a `code` field
alongside `icmp_type`, matching RFC 4443.

## Re-vendoring

If `network/` is ever re-fetched from a newer upstream commit, re-apply these
same three edits to the corresponding files in `ksy/` (diff the new
`network/*.ksy` against the old to spot any additional upstream drift first).
Re-check upstream for an ICMPv6 spec too; if one now exists, evaluate
replacing the byteql-authored `icmpv6.ksy` with a vendored+patched version
for consistency with the other seven files.
