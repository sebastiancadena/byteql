/**
 * Ambient typings for the `kaitai-struct-compiler` output in
 * `packages/formats/pcap/gen/*.js`. Each generated file is a UMD/CommonJS module
 * that assigns its parser class onto `exports` (e.g. `exports.EthernetFrame`),
 * so the default import is that `{ ClassName }` holder object (mirrors
 * `packages/formats/midi/src/generated.d.ts`). Only the fields the wrappers read
 * are typed; `_debug.<field>` records `{ start, end, ioOffset }` where `start`
 * is the field's offset relative to the buffer the parser was constructed from.
 */

interface GeneratedDebugRange {
  start: number;
  end: number;
  ioOffset: number;
}

declare module '*EthernetFrame.js' {
  export class EthernetFrame {
    constructor(stream: unknown);
    _read(): void;
    body: Uint8Array;
    readonly etherType: number;
    _debug: { body: GeneratedDebugRange };
  }
  const generatedModule: { EthernetFrame: typeof EthernetFrame };
  export default generatedModule;
}

declare module '*Ipv4Packet.js' {
  export class Ipv4Packet {
    constructor(stream: unknown);
    _read(): void;
    protocol: number;
    ttl: number;
    totalLength: number;
    srcIpAddr: Uint8Array;
    dstIpAddr: Uint8Array;
    body: Uint8Array;
    _debug: { body: GeneratedDebugRange };
  }
  const generatedModule: { Ipv4Packet: typeof Ipv4Packet };
  export default generatedModule;
}

declare module '*Ipv6Packet.js' {
  export class Ipv6Packet {
    constructor(stream: unknown);
    _read(): void;
    nextHeaderType: number;
    hopLimit: number;
    payloadLength: number;
    srcIpv6Addr: Uint8Array;
    dstIpv6Addr: Uint8Array;
    body: Uint8Array;
    _debug: { body: GeneratedDebugRange };
  }
  const generatedModule: { Ipv6Packet: typeof Ipv6Packet };
  export default generatedModule;
}

declare module '*TcpSegment.js' {
  export interface TcpSegmentFlags {
    cwr: boolean;
    ece: boolean;
    urg: boolean;
    ack: boolean;
    psh: boolean;
    rst: boolean;
    syn: boolean;
    fin: boolean;
  }
  export class TcpSegment {
    constructor(stream: unknown);
    _read(): void;
    srcPort: number;
    dstPort: number;
    seqNum: number;
    ackNum: number;
    flags: TcpSegmentFlags;
    windowSize: number;
    body: Uint8Array;
    _debug: { body: GeneratedDebugRange };
  }
  const generatedModule: { TcpSegment: typeof TcpSegment };
  export default generatedModule;
}

declare module '*UdpDatagram.js' {
  export class UdpDatagram {
    constructor(stream: unknown);
    _read(): void;
    srcPort: number;
    dstPort: number;
    length: number;
    body: Uint8Array;
    _debug: { body: GeneratedDebugRange };
  }
  const generatedModule: { UdpDatagram: typeof UdpDatagram };
  export default generatedModule;
}

declare module '*DnsPacket.js' {
  export interface DnsLabel {
    length: number;
    name?: string;
  }
  export interface DnsDomainName {
    name: DnsLabel[];
  }
  export interface DnsQuery {
    name: DnsDomainName;
    type: number;
  }
  export interface DnsPacketFlags {
    flag: number;
  }
  export class DnsPacket {
    constructor(stream: unknown);
    _read(): void;
    transactionId: number;
    flags: DnsPacketFlags;
    qdcount?: number;
    ancount?: number;
    queries?: DnsQuery[];
  }
  const generatedModule: { DnsPacket: typeof DnsPacket };
  export default generatedModule;
}

declare module '*IcmpPacket.js' {
  export interface IcmpEcho {
    identifier: number;
    seqNum: number;
  }
  export class IcmpPacket {
    constructor(stream: unknown);
    _read(): void;
    icmpType: number;
    echo?: IcmpEcho;
  }
  const generatedModule: { IcmpPacket: typeof IcmpPacket };
  export default generatedModule;
}

declare module '*Icmpv6Packet.js' {
  export interface Icmpv6Echo {
    identifier: number;
    seqNum: number;
  }
  export class Icmpv6Packet {
    constructor(stream: unknown);
    _read(): void;
    icmpType: number;
    code: number;
    echo?: Icmpv6Echo;
  }
  const generatedModule: { Icmpv6Packet: typeof Icmpv6Packet };
  export default generatedModule;
}

declare module '*TlsClientHello.js' {
  export interface TlsVersion {
    major: number;
    minor: number;
  }
  export interface TlsExtension {
    type: number;
    body: unknown;
  }
  export interface TlsExtensions {
    extensions: TlsExtension[];
  }
  export class TlsClientHello {
    constructor(stream: unknown);
    _read(): void;
    version: TlsVersion;
    extensions?: TlsExtensions;
  }
  const generatedModule: { TlsClientHello: typeof TlsClientHello };
  export default generatedModule;
}
