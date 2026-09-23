import { describe, expect, it } from 'vitest';

import { parsePackManifest, PackManifestError } from './manifest.js';

const validPcapLike = {
  version: '0.1',
  id: 'pcap',
  title: 'Packet capture',
  spec: 'pcap.tables.yaml',
  queries: 'queries.yaml',
  containers: [
    {
      id: 'classic',
      framer: 'classicPcap',
      probe: { magic: [{ at: 0, hex: 'd4c3b2a1', confidence: 0.9 }] },
    },
  ],
};

describe('parsePackManifest', () => {
  it('parses a valid pcap-like manifest', () => {
    const manifest = parsePackManifest(validPcapLike);
    expect(manifest.id).toBe('pcap');
    expect(manifest.containers).toHaveLength(1);
    expect(manifest.containers[0]!.probe).toEqual({ magic: [{ at: 0, hex: 'd4c3b2a1', confidence: 0.9 }] });
  });

  it('defaults errors.ordinal to "record" and capabilities to [] when absent', () => {
    const manifest = parsePackManifest(validPcapLike);
    expect(manifest.errors).toEqual({ ordinal: 'record' });
    expect(manifest.capabilities).toEqual([]);
  });

  it('throws PackManifestError with path "containers" when containers is missing', () => {
    const rest = {
      version: validPcapLike.version,
      id: validPcapLike.id,
      title: validPcapLike.title,
      spec: validPcapLike.spec,
      queries: validPcapLike.queries,
    };
    let error: unknown;
    try {
      parsePackManifest(rest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PackManifestError);
    expect((error as PackManifestError).path).toBe('containers');
  });

  it('throws at containers.0.probe.magic.0.hex when hex is not even length', () => {
    const manifest = {
      ...validPcapLike,
      containers: [
        {
          id: 'classic',
          framer: 'classicPcap',
          probe: { magic: [{ at: 0, hex: 'abc', confidence: 0.9 }] },
        },
      ],
    };
    let error: unknown;
    try {
      parsePackManifest(manifest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PackManifestError);
    expect((error as PackManifestError).path).toBe('containers.0.probe.magic.0.hex');
  });

  it('throws at containers.0.probe.magic.0.hex when hex is not hex characters', () => {
    let error: unknown;
    try {
      parsePackManifest({
        ...validPcapLike,
        containers: [
          {
            id: 'classic',
            framer: 'classicPcap',
            probe: { magic: [{ at: 0, hex: 'zz', confidence: 0.9 }] },
          },
        ],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PackManifestError);
    expect((error as PackManifestError).path).toBe('containers.0.probe.magic.0.hex');
  });

  it('throws on unknown top-level key (strict object)', () => {
    expect(() => parsePackManifest({ ...validPcapLike, extra: true })).toThrow(PackManifestError);
  });

  it('throws on duplicate container ids', () => {
    const manifest = {
      ...validPcapLike,
      containers: [
        { id: 'classic', framer: 'a', probe: { magic: [{ at: 0, hex: 'aa', confidence: 0.5 }] } },
        { id: 'classic', framer: 'b', probe: { magic: [{ at: 0, hex: 'bb', confidence: 0.5 }] } },
      ],
    };
    let error: unknown;
    try {
      parsePackManifest(manifest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PackManifestError);
    expect((error as PackManifestError).path).toBe('containers.1.id');
  });

  describe('path containment', () => {
    it('rejects a spec path that walks up with ".."', () => {
      let error: unknown;
      try {
        parsePackManifest({ ...validPcapLike, spec: '../../etc/passwd' });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(PackManifestError);
      expect((error as PackManifestError).path).toBe('spec');
    });

    it('rejects an absolute queries path', () => {
      let error: unknown;
      try {
        parsePackManifest({ ...validPcapLike, queries: '/etc/passwd' });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(PackManifestError);
      expect((error as PackManifestError).path).toBe('queries');
    });

    it('rejects a ksy.dir that walks up with ".."', () => {
      let error: unknown;
      try {
        parsePackManifest({ ...validPcapLike, ksy: { dir: '../outside' } });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(PackManifestError);
      expect((error as PackManifestError).path).toBe('ksy.dir');
    });

    it('accepts an ordinary relative spec path', () => {
      expect(() => parsePackManifest({ ...validPcapLike, spec: 'nested/pcap.tables.yaml' })).not.toThrow();
    });
  });

  it('includes the file name in the error message', () => {
    let error: unknown;
    try {
      parsePackManifest({ ...validPcapLike, extra: true }, 'weird.yaml');
    } catch (caught) {
      error = caught;
    }
    expect((error as PackManifestError).message).toContain('weird.yaml');
  });
});
