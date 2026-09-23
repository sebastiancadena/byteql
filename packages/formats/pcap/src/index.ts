import { definePack } from '@byteql/core';

import { pcapFramer, pcapngFramer } from './framer.js';
import { definition, type Hooks } from './pack.generated.js';
import { probePcapng } from './probe.js';
import { dnsTcp, tcpFlowKey, tlsRecord } from './streams.js';
import {
  dnsPacket,
  dnsTcpMessage,
  ethernetFrame,
  icmpPacket,
  icmpv6Packet,
  ipv4Packet,
  ipv6Packet,
  tcpSegment,
  tlsClientHello,
  udpDatagram,
} from './wrappers.js';

export const pcapFormatPack = definePack<Hooks>(definition, {
  framers: { pcap: pcapFramer, pcapng: pcapngFramer },
  parsers: {
    ethernet_frame: ethernetFrame,
    ipv4_packet: ipv4Packet,
    ipv6_packet: ipv6Packet,
    tcp_segment: tcpSegment,
    udp_datagram: udpDatagram,
    dns_packet: dnsPacket,
    dns_tcp_message: dnsTcpMessage,
    icmp_packet: icmpPacket,
    icmpv6_packet: icmpv6Packet,
    tls_client_hello: tlsClientHello,
  },
  keyExtractors: { tcp_flow_key: tcpFlowKey },
  streamFramers: { tls_record: tlsRecord, dns_tcp: dnsTcp },
  probes: { pcapng: probePcapng },
});
