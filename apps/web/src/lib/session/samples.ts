import skypeIrcUrl from '../../assets/SkypeIRC.cap?url';
import v6Url from '../../assets/v6.pcap?url';
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
    files: [
      { name: 'SkypeIRC.cap', url: skypeIrcUrl },
      { name: 'v6.pcap', url: v6Url },
    ],
  },
  {
    id: 'midi',
    label: 'MIDI song (.mid)',
    files: [{ name: 'fur_Elise_opening.mid', url: furEliseUrl }],
  },
];
