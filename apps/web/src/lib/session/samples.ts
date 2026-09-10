import skypeIrcUrl from '../../assets/SkypeIRC.cap?url';
import v6Url from '../../assets/v6.pcap?url';
import dnsStreamUrl from '../../assets/dns-stream.pcap?url';
import furEliseUrl from '../../assets/fur_Elise_opening.mid?url';

export type SampleId = 'pcap' | 'midi';

export interface SampleFile {
  /** Filename shown in the _files catalog and the hex file switcher. */
  name: string;
  /** Build-time-resolved URL of the bundled asset. */
  url: string;
}

export interface SampleDefinition {
  id: SampleId;
  /** Menu-item text in the sample picker. */
  label: string;
  /** One sentence explaining what the sample contains, shown beside the picker on the intake screen. */
  description: string;
  files: readonly SampleFile[];
}

/**
 * The single source of truth for the empty-state sample picker. Order is
 * significant: the first entry is the picker's default/primary item.
 * pcap is the flagship because it exercises the most tables at once.
 */
export const SAMPLES: readonly SampleDefinition[] = [
  {
    id: 'pcap',
    label: 'Network capture (pcap)',
    description: 'Three captures projected into packet, IP, TCP, UDP, DNS and TLS tables.',
    files: [
      { name: 'SkypeIRC.cap', url: skypeIrcUrl },
      { name: 'v6.pcap', url: v6Url },
      { name: 'dns-stream.pcap', url: dnsStreamUrl },
    ],
  },
  {
    id: 'midi',
    label: 'MIDI song (.mid)',
    description: 'One short piece projected into header, event and tempo tables.',
    files: [{ name: 'fur_Elise_opening.mid', url: furEliseUrl }],
  },
];
