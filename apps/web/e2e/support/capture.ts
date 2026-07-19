import {
  buildPcap,
  dnsQuery,
  ethFrame,
  ipv4,
  tcp,
  udp,
  type PcapPacket,
} from '../../../../packages/formats/pcap/test/build-pcap.js';

export interface GeneratedCapture {
  bytes: Uint8Array;
  packetCount: number;
  dnsCount: number;
  seed: number;
}

const PCAP_GLOBAL_HEADER_SIZE = 24;
const PCAP_RECORD_HEADER_SIZE = 16;

/**
 * A tiny 32-bit LCG (Numerical Recipes constants) seeded once per `generateCapture` call.
 * Deterministic across processes/browsers: the same `seed` always yields the same draw
 * sequence, and `draw(index)` only ever depends on how many times `next()` has been called
 * before it — never on wall-clock time or `bytesTarget`.
 */
function createLcg(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// TCP payload packets land on a plain, non-well-known destination port deliberately: the pcap
// spec's dissect chain only opens stream reassembly (TLS on 443, DNS-over-TCP on 53) for those
// two ports, and reassembling thousands of synthetic streams full of unparsable filler bytes
// would add stream-flush "gap" issues and cost with nothing to verify here.
const TCP_FILLER_DST_PORT = 51_000;
const TCP_PAYLOAD_BYTES = 1024;

/**
 * Builds a deterministic, seeded synthetic `.pcap` capture over the Task 3 fixture builders:
 * ethernet/IPv4 framing, ~70% small UDP/DNS-query packets (name `host-<n>`, one question each)
 * and ~30% ~1 KB TCP payload packets, sized to at least `bytesTarget` bytes.
 *
 * Packet *shape* at index `i` depends only on `seed` and `i`, never on `bytesTarget` — the LCG
 * is redrawn from the same seed every call and consumed in strict index order. So a smaller
 * `bytesTarget` call and a larger one that share a `seed` always produce a byte-identical
 * PREFIX of packets (the smaller capture is exactly a truncation, packet-for-packet, of the
 * larger one's start). That determinism is what lets e2e specs read a provenance literal
 * (e.g. `_src_start`/`_src_end` for packet 1) off a small memory-tier run and assert a large
 * spill-tier run of "the same capture" reproduces it exactly, instead of hard-coding a value.
 *
 * Reused verbatim by Task 12 — keep the signature and packet-shape rules stable.
 */
export function generateCapture(bytesTarget: number, seed: number): GeneratedCapture {
  const next = createLcg(seed);
  const packets: PcapPacket[] = [];
  let dnsCount = 0;
  let totalBytes = PCAP_GLOBAL_HEADER_SIZE;
  let index = 0;

  while (totalBytes < bytesTarget) {
    const isDns = next() < 0.7;
    const data = isDns
      ? ethFrame({
          etherType: 0x0800,
          payload: ipv4({
            protocol: 17,
            src: '10.0.0.1',
            dst: '10.0.0.2',
            payload: udp({
              srcPort: 40_000 + (index % 1000),
              dstPort: 53,
              payload: dnsQuery({ txId: index & 0xffff, name: `host-${index}`, type: 1 }),
            }),
          }),
        })
      : ethFrame({
          etherType: 0x0800,
          payload: ipv4({
            protocol: 6,
            src: '10.0.1.1',
            dst: '10.0.1.2',
            payload: tcp({
              srcPort: 50_000 + (index % 1000),
              dstPort: TCP_FILLER_DST_PORT,
              flags: 0x18, // PSH|ACK: a plain in-flow data segment
              seq: index * TCP_PAYLOAD_BYTES,
              payload: new Uint8Array(TCP_PAYLOAD_BYTES).fill(index & 0xff),
            }),
          }),
        });

    packets.push({ tsSec: index, tsFrac: 0, data });
    if (isDns) dnsCount += 1;
    totalBytes += PCAP_RECORD_HEADER_SIZE + data.length;
    index += 1;
  }

  const bytes = buildPcap({ magic: 'be_us', linktype: 1, packets });
  return { bytes, packetCount: packets.length, dnsCount, seed };
}
