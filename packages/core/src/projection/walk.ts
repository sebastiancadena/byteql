import { missingProperty, readOwnDataProperty } from './anchors.js';
import type { AnchorMatch, CompiledAnchor } from './anchors.js';

export interface MatcherNode {
  readonly fields: Map<string, MatcherNode>;
  readonly indexed: Map<number, MatcherNode>;
  wildcard: MatcherNode | null;
  readonly terminals: number[];
}

const emptyNode = (): MatcherNode => ({
  fields: new Map(),
  indexed: new Map(),
  wildcard: null,
  terminals: [],
});

export const buildMatcher = (anchors: readonly CompiledAnchor[]): MatcherNode => {
  const root = emptyNode();
  anchors.forEach((anchor, anchorIndex) => {
    let node = root;
    for (const step of anchor.steps) {
      if (step.kind === 'field') {
        let next = node.fields.get(step.name);
        if (!next) {
          next = emptyNode();
          node.fields.set(step.name, next);
        }
        node = next;
      } else if (step.kind === 'index') {
        let next = node.indexed.get(step.index);
        if (!next) {
          next = emptyNode();
          node.indexed.set(step.index, next);
        }
        node = next;
      } else {
        if (!node.wildcard) node.wildcard = emptyNode();
        node = node.wildcard;
      }
    }
    node.terminals.push(anchorIndex);
  });
  return root;
};

export type MatchVisitor = (anchorIndex: number, match: AnchorMatch) => void;

export const walkMatcher = (root: unknown, matcher: MatcherNode, visit: MatchVisitor): void => {
  const ordinals = new Map<number, number>();

  const recurse = (
    node: unknown,
    at: MatcherNode,
    parents: readonly unknown[],
    indexes: readonly number[],
  ): void => {
    for (const anchorIndex of at.terminals) {
      const ordinal = ordinals.get(anchorIndex) ?? 0;
      ordinals.set(anchorIndex, ordinal + 1);
      visit(anchorIndex, { node, parents, indexes, ordinal });
    }

    for (const [name, child] of at.fields) {
      const value = readOwnDataProperty(node, name);
      if (value !== missingProperty) recurse(value, child, [...parents, node], indexes);
    }

    if ((at.indexed.size > 0 || at.wildcard) && Array.isArray(node)) {
      const length = readOwnDataProperty(node, 'length');
      if (typeof length === 'number' && Number.isSafeInteger(length) && length >= 0) {
        for (const [index, child] of at.indexed) {
          if (index >= length) continue;
          const value = readOwnDataProperty(node, String(index));
          if (value !== missingProperty) recurse(value, child, [...parents, node], indexes);
        }
        if (at.wildcard) {
          for (let index = 0; index < length; index += 1) {
            const value = readOwnDataProperty(node, String(index));
            if (value === missingProperty) continue;
            recurse(value, at.wildcard, [...parents, node], [...indexes, index]);
          }
        }
      }
    }
  };

  recurse(root, matcher, [], []);
};
