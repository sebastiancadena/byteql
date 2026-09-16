import type { FormatCapability } from '@byteql/core';
import { resultColumnLabel } from '@byteql/db/result-columns';
import type { Table } from 'apache-arrow';
import type { Component } from 'svelte';

import AudioViewer from '../../components/AudioViewer.svelte';
import type { AudioEngine } from './tone-engine.js';

export type FormatViewerMetadata = Readonly<Record<string, FormatCapability>>;

export interface ViewerCapability {
  id: string;
  label: string;
  accepts(
    columns: readonly { name: string; type: string }[],
    capability: FormatCapability | undefined,
  ): boolean;
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
  accepts(columns, capability) {
    if (!capability?.enabled) return false;
    const counts = new Map<string, number>();
    for (const column of columns) counts.set(column.name, (counts.get(column.name) ?? 0) + 1);
    if (['seconds', 'note', 'velocity', 'kind'].some((name) => counts.get(name) !== 1)) return false;
    if (['channel', 'program'].some((name) => (counts.get(name) ?? 0) > 1)) return false;
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
  return trustedCapabilities.filter((viewer) => viewer.accepts(columns, formatMetadata[viewer.id]));
}

/**
 * Returns viewers only when the entire query result was safely materialized.
 * A null table represents either a still-streaming or over-budget result; neither
 * may be handed to viewers because doing so would silently present a truncation.
 */
export function compatibleTableViewers(
  completeTable: Table | null,
  formatMetadata: FormatViewerMetadata,
): ViewerCapability[] {
  if (!completeTable) return [];
  return compatibleViewers(
    completeTable.schema.fields.map((field) => ({
      name: resultColumnLabel(field),
      type: field.type.toString(),
    })),
    formatMetadata,
  );
}
