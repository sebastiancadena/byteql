# byteql-authored: no upstream Kaitai Struct ICMPv6 spec exists in
# kaitai-io/kaitai_struct_formats as of the pinned commit (see PATCHES.md).
# This file has no `network/` counterpart — it lives only under `ksy/`.
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
