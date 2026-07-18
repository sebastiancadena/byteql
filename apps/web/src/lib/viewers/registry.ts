import type { Table } from 'apache-arrow';
import type { Component } from 'svelte';

import AudioViewer from '../../components/AudioViewer.svelte';
import type { AudioEngine } from './tone-engine.js';

export interface FormatViewerMetadata {
  audio: { enabled: boolean; reason: string | null };
}

export interface ViewerCapability {
  id: string;
  label: string;
  accepts(columns: readonly { name: string; type: string }[], audioEnabled: boolean): boolean;
  component: Component<ViewerComponentProps>;
}

export interface ViewerComponentProps {
  table: Table;
  engineFactory?: (() => AudioEngine) | undefined;
  onclose: () => void;
}

const numericType = /^(?:u?int(?:8|16|32|64)|float(?:16|32|64)|decimal(?:128|256)?)(?:\b|$)/iu;
const utf8Type = /^(?:utf8|dictionary<[^,]+,\s*utf8>)$/iu;

const audioCapability: ViewerCapability = {
  id: 'audio',
  label: 'Audio playback',
  accepts(columns, audioEnabled) {
    if (!audioEnabled) return false;
    const byName = new Map(columns.map((column) => [column.name, column.type]));
    return (
      numericType.test(byName.get('seconds') ?? '') &&
      numericType.test(byName.get('note') ?? '') &&
      numericType.test(byName.get('velocity') ?? '') &&
      utf8Type.test(byName.get('kind') ?? '') &&
      (!byName.has('channel') || numericType.test(byName.get('channel') ?? ''))
    );
  },
  component: AudioViewer,
};

const trustedCapabilities: readonly ViewerCapability[] = [audioCapability];

export function compatibleViewers(
  columns: readonly { name: string; type: string }[],
  formatMetadata: FormatViewerMetadata,
): ViewerCapability[] {
  return trustedCapabilities.filter((capability) =>
    capability.accepts(columns, formatMetadata.audio.enabled),
  );
}
