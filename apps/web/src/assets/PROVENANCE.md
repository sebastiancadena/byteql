# Bundled sample assets — provenance

These files back the empty-state "Try sample" picker (`src/lib/session/samples.ts`).

## Network captures

- `SkypeIRC.cap` — Wireshark wiki, SampleCaptures.
  Source: https://wiki.wireshark.org/uploads/__moin_import__/attachments/SampleCaptures/SkypeIRC.cap
  Contents: Skype, IRC, and DNS traffic over IPv4 (classic libpcap, Ethernet).
- `v6.pcap` — Wireshark wiki, SampleCaptures.
  Source: https://wiki.wireshark.org/uploads/__moin_import__/attachments/SampleCaptures/v6.pcap
  Contents: IPv6 (6bone) and ICMPv6 packets (classic libpcap, Ethernet).
- `dns-stream.pcap` — byteql-generated synthetic fixture (also used by the pcap e2e).
  Built by `packages/formats/pcap/test/build-pcap.ts`: a two-segment DNS-over-TCP query for
  `stream.example` split across TCP seq 0/10, so it exercises TCP stream reassembly (the
  `streams` table / "TCP flows" saved query) on the bundled sample. Not from the Wireshark wiki.

Redistribution follows the Wireshark wiki SampleCaptures terms
(https://wiki.wireshark.org/SampleCaptures).

## MIDI

- `fur_Elise_opening.mid` — opening of Beethoven's _Für Elise_ (WoO 59).
  The composition is public domain; the MIDI file was user-supplied.
