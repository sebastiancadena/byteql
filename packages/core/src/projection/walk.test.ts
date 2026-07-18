import { describe, expect, it } from 'vitest';
import { compileAnchor } from './anchors.js';
import { buildMatcher, walkMatcher } from './walk.js';

const collect = (
  root: unknown,
  sources: string[],
): Array<{ anchor: number; node: unknown; indexes: readonly number[]; ordinal: number }> => {
  const matcher = buildMatcher(sources.map((source) => compileAnchor(source)));
  const out: Array<{ anchor: number; node: unknown; indexes: readonly number[]; ordinal: number }> = [];
  walkMatcher(root, matcher, (anchor, match) =>
    out.push({ anchor, node: match.node, indexes: match.indexes, ordinal: match.ordinal }),
  );
  return out;
};

describe('walkMatcher', () => {
  const root = {
    hdr: { division: 96 },
    tracks: [{ events: { event: [{ id: 'a' }, { id: 'b' }] } }, { events: { event: [{ id: 'c' }] } }],
  };

  it('fires two anchors sharing a prefix in one walk with per-anchor ordinals', () => {
    const matches = collect(root, ['$.hdr', '$.tracks[*].events.event[*]']);
    expect(matches).toEqual([
      { anchor: 0, node: { division: 96 }, indexes: [], ordinal: 0 },
      { anchor: 1, node: { id: 'a' }, indexes: [0, 0], ordinal: 0 },
      { anchor: 1, node: { id: 'b' }, indexes: [0, 1], ordinal: 1 },
      { anchor: 1, node: { id: 'c' }, indexes: [1, 0], ordinal: 2 },
    ]);
  });

  it('fires anchors that share a terminal node in registration order', () => {
    const matches = collect(root, ['$.tracks[*].events.event[*]', '$.tracks[*].events.event[*]']);
    expect(matches.map((match) => match.anchor)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('supports explicit index steps and missing fields', () => {
    expect(collect(root, ['$.tracks[1].events.event[*]'])).toHaveLength(1);
    expect(collect(root, ['$.absent[*]'])).toHaveLength(0);
  });

  it('builds parents like traverseAnchor does', () => {
    const matcher = buildMatcher([compileAnchor('$.tracks[*].events.event[*]')]);
    let parents: readonly unknown[] = [];
    walkMatcher(root, matcher, (_anchor, match) => {
      if (match.ordinal === 0) parents = match.parents;
    });
    expect(parents).toHaveLength(5); // root, tracks[], track0, events, event[]
    expect(parents[0]).toBe(root);
    expect(parents[4]).toBe(root.tracks[0]!.events.event);
  });
});
