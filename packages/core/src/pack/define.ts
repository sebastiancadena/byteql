import { compileProjection } from '../projection/project.js';
import type { RecordParser } from '../projection/parsers.js';
import { parseProjectionSpec } from '../projection/spec.js';
import type { StreamFramer, StreamKeyExtractor } from '../projection/streams.js';
import type { ByteSource, FormatPack, OpenOptions, PackQuery, RecordSource } from '../protocol.js';
import { openFramedSource } from './driver.js';
import type { DriverTuning, Framer } from './framer.js';
import type { PackManifest } from './manifest.js';
import { projectionSchemas } from './schemas.js';

export interface PackDefinition {
  manifest: PackManifest;
  specYaml: string;
  queries: readonly PackQuery[];
}

export interface PackHooks<
  F extends string = string,
  P extends string = string,
  K extends string = string,
  S extends string = string,
  H extends string = string,
> {
  framers: Record<F, Framer>;
  parsers: Record<P, RecordParser>;
  keyExtractors: Record<K, StreamKeyExtractor>;
  streamFramers: Record<S, StreamFramer>;
  probes: Record<H, (head: Uint8Array) => number | null>;
}

export interface OpenWithOptions extends DriverTuning {
  container?: string;
  strictFields?: boolean;
}

export interface DefinedPack extends FormatPack {
  readonly manifest: PackManifest;
  probeContainer(head: Uint8Array): { container: string; confidence: number } | null;
  openWith(source: ByteSource, opts: OpenOptions, options?: OpenWithOptions): RecordSource;
}

/** Bytes a declarative probe may inspect; matches the app's PROBE_HEAD_BYTES. */
const hexBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../gu)!, (pair) => Number.parseInt(pair, 16));

export const definePack = <Hooks extends PackHooks<string, string, string, string, string>>(
  definition: PackDefinition,
  hooks: Hooks,
): DefinedPack => {
  const { manifest } = definition;
  const spec = parseProjectionSpec(definition.specYaml);
  if (spec.format !== manifest.id) {
    throw new Error(
      `PACK_FORMAT_MISMATCH: spec format ${JSON.stringify(spec.format)} != pack id ${JSON.stringify(manifest.id)}`,
    );
  }
  const compiled = compileProjection(spec, new Map(Object.entries(hooks.parsers)), {
    keyExtractors: new Map(Object.entries(hooks.keyExtractors)),
    framers: new Map(Object.entries(hooks.streamFramers)),
  });
  const schemas = projectionSchemas(compiled, { ordinalColumn: manifest.errors.ordinal });

  const probes = manifest.containers.map((container) => {
    if ('hook' in container.probe) {
      const hook = (hooks.probes as Record<string, (head: Uint8Array) => number | null>)[
        container.probe.hook
      ]!;
      return { id: container.id, probe: hook };
    }
    const magics = container.probe.magic.map((m) => ({ ...m, bytes: hexBytes(m.hex) }));
    return {
      id: container.id,
      probe: (head: Uint8Array): number | null => {
        let best: number | null = null;
        for (const m of magics) {
          if (head.byteLength < m.at + m.bytes.length) continue;
          if (m.bytes.every((byte, i) => head[m.at + i] === byte) && (best === null || m.confidence > best)) {
            best = m.confidence;
          }
        }
        return best;
      },
    };
  });

  const probeContainer = (head: Uint8Array): { container: string; confidence: number } | null => {
    let best: { container: string; confidence: number } | null = null;
    for (const { id, probe } of probes) {
      const confidence = probe(head);
      if (confidence !== null && confidence > 0 && (best === null || confidence > best.confidence)) {
        best = { container: id, confidence };
      }
    }
    return best;
  };

  const framerFor = (id: string): Framer | null => {
    const container = manifest.containers.find((entry) => entry.id === id);
    return container ? ((hooks.framers as Record<string, Framer>)[container.framer] ?? null) : null;
  };

  const openWith = (source: ByteSource, opts: OpenOptions, options: OpenWithOptions = {}): RecordSource => {
    let inner: RecordSource | null = null;
    let failure: { error: unknown } | null = null;
    const start = async (): Promise<RecordSource> => {
      if (inner) return inner;
      let id = options.container ?? opts.container;
      if (id === undefined) {
        const head = await source.read(0, Math.min(source.size, 4096));
        id = probeContainer(head)?.container ?? manifest.containers[0]!.id;
      }
      const framer = framerFor(id);
      if (!framer)
        throw new Error(`PACK_CONTAINER_UNKNOWN: ${manifest.id} has no container ${JSON.stringify(id)}`);
      inner = openFramedSource(compiled, framer, source, opts, {
        ordinalColumn: manifest.errors.ordinal,
        ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}),
        ...(options.flushRowThreshold !== undefined ? { flushRowThreshold: options.flushRowThreshold } : {}),
        ...(options.yieldInterval !== undefined ? { yieldInterval: options.yieldInterval } : {}),
        ...(options.strictFields !== undefined ? { strictFields: options.strictFields } : {}),
      });
      return inner;
    };
    return {
      async nextBatch() {
        if (failure) throw failure.error;
        try {
          return await (await start()).nextBatch();
        } catch (error) {
          failure = { error };
          throw error;
        }
      },
      finish() {
        if (failure) throw failure.error;
        if (!inner) throw new Error('RECORD_SOURCE_NOT_DRAINED: call nextBatch() until null before finish()');
        return inner.finish();
      },
    };
  };

  return {
    id: manifest.id,
    title: manifest.title,
    manifest,
    queries: definition.queries,
    probe: (head) => probeContainer(head)?.confidence ?? null,
    probeContainer,
    schemas: () => schemas,
    open: (source, opts) => openWith(source, opts),
    openWith,
  };
};
