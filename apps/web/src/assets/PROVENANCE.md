# Bundled assets — provenance

## Brand

- `byteql.svg` — selected `byteql1_card_clean.png` from the sibling `byteql-assets`
  repository. The original raster artwork is embedded unchanged. A solid `#fafafa`
  rounded rectangle supplies the border; the image is clipped 12 source pixels inside
  that boundary to remove residual matte noise on all four edges. The square viewBox
  trims unused outer canvas while retaining the full card and wordmark.
- `byteql-favicon.svg` — the same embedded artwork, framed around the blue query symbol
  for legibility at browser-tab sizes. No separately traced or redrawn mark.
- `byteql-favicon.png` — the 64 × 64 raster export of that SVG used by the browser tab,
  avoiding loading the full source image for a tiny icon.

Both SVGs are self-contained and require no external resources. The cleaned card is
also saved as `assets/svg/byteql1_card_clean_v2.svg` in `byteql-assets`.

## Samples

These files back the empty-state "Try sample" picker (`src/lib/session/samples.ts`).

## Network captures

- `SkypeIRC.cap` — Wireshark wiki, SampleCaptures.
  Source: <https://wiki.wireshark.org/uploads/__moin_import__/attachments/SampleCaptures/SkypeIRC.cap>
  Contents: Skype, IRC, and DNS traffic over IPv4 (classic libpcap, Ethernet).
- `v6.pcap` — Wireshark wiki, SampleCaptures.
  Source: <https://wiki.wireshark.org/uploads/__moin_import__/attachments/SampleCaptures/v6.pcap>
  Contents: IPv6 (6bone) and ICMPv6 packets (classic libpcap, Ethernet).
- `dns-stream.pcap` — byteql-generated synthetic fixture (also used by the pcap e2e).
  Built by `packages/formats/pcap/test/build-pcap.ts`: a two-segment DNS-over-TCP query for
  `stream.example` split across TCP seq 0/10, so it exercises TCP stream reassembly (the
  `streams` table / "TCP flows" saved query) on the bundled sample. Not from the Wireshark wiki.
- `http2-16-ssl.pcapng` — Wireshark wiki, SampleCaptures.
  Source: <https://wiki.wireshark.org/uploads/__moin_import__/attachments/SampleCaptures/http2-16-ssl.pcapng>
  Contents: HTTP/2 over TLS on loopback (IPv4 and IPv6, TCP/443) with a TLS ClientHello carrying
  SNI `localhost` (pcapng, Ethernet, nanosecond timestamps, one interface statistics block).

Redistribution follows the Wireshark wiki SampleCaptures terms
(<https://wiki.wireshark.org/SampleCaptures>).

## MIDI

- `fur_Elise_opening.mid` — opening of Beethoven's _Für Elise_ (WoO 59).
  The composition is public domain; the MIDI file was user-supplied.
