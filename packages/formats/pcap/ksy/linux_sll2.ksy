# byteql-authored: the vendored kaitai-io/kaitai_struct_formats `network/` set has no Linux
# cooked-capture spec (see PATCHES.md). This file has no `network/` counterpart.
meta:
  id: linux_sll2
  title: Linux cooked capture v2 header (LINKTYPE_LINUX_SLL2, 276; byteql-authored)
  endian: be
doc: |
  The 20-byte pseudo link-layer header newer libpcap writes for `-i any` captures on Linux.
  Unlike v1 it leads with the protocol and records the capturing interface index.
doc-ref: https://www.tcpdump.org/linktypes/LINKTYPE_LINUX_SLL2.html
seq:
  - id: protocol
    type: u2
    doc: An Ethernet type (0x0800, 0x86dd, ...) for the IP traffic this pack dissects.
  - id: reserved
    type: u2
  - id: interface_index
    type: u4
  - id: arphrd_type
    type: u2
  - id: packet_type
    type: u1
  - id: addr_len
    type: u1
  - id: addr
    size: 8
  - id: body
    size-eos: true
