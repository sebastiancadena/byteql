import { ProjectionCompileError } from './expression.js';

export type AnchorStep =
  | { readonly kind: 'field'; readonly name: string }
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'index'; readonly index: number };

export interface CompiledAnchor {
  readonly source: string;
  readonly steps: readonly AnchorStep[];
  readonly wildcardCount: number;
}

export interface AnchorMatch {
  readonly node: unknown;
  readonly parents: readonly unknown[];
  readonly indexes: readonly number[];
  readonly ordinal: number;
}

const identifierStartPattern = /[A-Za-z_]/u;
const identifierPartPattern = /[A-Za-z0-9_]/u;
const forbiddenFields = new Set(['__proto__', 'constructor', 'prototype']);

const invalidAnchor = (path: string, source: string, offset: number, detail: string): never => {
  throw new ProjectionCompileError(
    'PROJECTION_ANCHOR_INVALID',
    path,
    `${detail} at offset ${offset} in ${JSON.stringify(source)}`,
  );
};

export const compileAnchor = (source: string, path = 'anchor'): CompiledAnchor => {
  if (source[0] !== '$') invalidAnchor(path, source, 0, 'anchor must start with $');

  const steps: AnchorStep[] = [];
  let wildcardCount = 0;
  let offset = 1;

  while (offset < source.length) {
    const token = source[offset];
    if (token === '.') {
      const start = offset + 1;
      if (start >= source.length || !identifierStartPattern.test(source[start]!)) {
        invalidAnchor(path, source, start, 'expected an identifier after .');
      }

      let end = start + 1;
      while (end < source.length && identifierPartPattern.test(source[end]!)) end += 1;
      const name = source.slice(start, end);
      if (forbiddenFields.has(name)) {
        invalidAnchor(path, source, start, `field ${JSON.stringify(name)} is not available`);
      }
      steps.push(Object.freeze({ kind: 'field', name }));
      offset = end;
      continue;
    }

    if (token === '[') {
      const close = source.indexOf(']', offset + 1);
      if (close < 0) invalidAnchor(path, source, offset, 'missing closing ]');
      const content = source.slice(offset + 1, close);
      if (content === '*') {
        steps.push(Object.freeze({ kind: 'wildcard' }));
        wildcardCount += 1;
      } else if (/^\d+$/u.test(content)) {
        const index = Number(content);
        if (!Number.isSafeInteger(index)) {
          invalidAnchor(path, source, offset + 1, 'array index must be a non-negative safe integer');
        }
        steps.push(Object.freeze({ kind: 'index', index }));
      } else {
        invalidAnchor(path, source, offset + 1, 'expected * or a non-negative integer');
      }
      offset = close + 1;
      continue;
    }

    invalidAnchor(path, source, offset, 'expected .identifier, [*], or [integer]');
  }

  return Object.freeze({ source, steps: Object.freeze(steps), wildcardCount });
};

export const isAnchorPrefix = (prefix: CompiledAnchor, anchor: CompiledAnchor): boolean => {
  if (prefix.steps.length > anchor.steps.length) return false;

  return prefix.steps.every((step, index) => {
    const candidate = anchor.steps[index];
    if (!candidate || candidate.kind !== step.kind) return false;
    if (step.kind === 'field') return candidate.kind === 'field' && candidate.name === step.name;
    if (step.kind === 'index') return candidate.kind === 'index' && candidate.index === step.index;
    return true;
  });
};

const missingProperty = Symbol('missing property');

const readOwnDataProperty = (value: unknown, key: string): unknown | typeof missingProperty => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return missingProperty;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : missingProperty;
};

interface TraversalCandidate {
  readonly node: unknown;
  readonly parents: readonly unknown[];
  readonly indexes: readonly number[];
}

export const traverseAnchor = (anchor: CompiledAnchor, root: unknown): readonly AnchorMatch[] => {
  let candidates: readonly TraversalCandidate[] = [{ node: root, parents: [], indexes: [] }];

  for (const step of anchor.steps) {
    const next: TraversalCandidate[] = [];
    for (const candidate of candidates) {
      if (step.kind === 'field') {
        const value = readOwnDataProperty(candidate.node, step.name);
        if (value !== missingProperty) {
          next.push({
            node: value,
            parents: [...candidate.parents, candidate.node],
            indexes: candidate.indexes,
          });
        }
        continue;
      }

      if (!Array.isArray(candidate.node)) continue;
      if (step.kind === 'index') {
        const length = readOwnDataProperty(candidate.node, 'length');
        if (typeof length !== 'number' || step.index >= length) continue;
        const value = readOwnDataProperty(candidate.node, String(step.index));
        if (value !== missingProperty) {
          next.push({
            node: value,
            parents: [...candidate.parents, candidate.node],
            indexes: candidate.indexes,
          });
        }
        continue;
      }

      const length = readOwnDataProperty(candidate.node, 'length');
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) continue;
      for (let index = 0; index < length; index += 1) {
        const value = readOwnDataProperty(candidate.node, String(index));
        if (value === missingProperty) continue;
        next.push({
          node: value,
          parents: [...candidate.parents, candidate.node],
          indexes: [...candidate.indexes, index],
        });
      }
    }
    candidates = next;
  }

  return candidates.map((candidate, ordinal) => ({ ...candidate, ordinal }));
};
