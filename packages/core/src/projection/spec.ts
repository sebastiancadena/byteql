import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ProjectionCompileError, isProjectionStateName } from './expression.js';

export type ArrowTypeName =
  | 'int8'
  | 'uint8'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'int64'
  | 'uint64'
  | 'bool'
  | 'utf8'
  | 'timestamp_us'
  | 'binary';

export interface ProjectionStateSpec {
  scope: string;
  init: number;
  update: string;
}

export interface ProjectionColumnSpec {
  expr: string;
  type: ArrowTypeName;
  when?: string;
}

export interface ParentKeySpec {
  table: string;
  column: string;
}

export interface DissectChainLinkSpec {
  when: string;
  parser?: string;
  stream?: string;
  table?: string;
}

export interface StreamMessageLinkSpec {
  when: string;
  parser: string;
  table?: string;
}

export interface StreamSpec {
  name: string;
  key: string;
  offset: string;
  framer: string;
  table: string;
  segments_table: string;
  max_buffer: number;
  messages: StreamMessageLinkSpec[];
}

export interface DissectSpec {
  from: string;
  payload: string;
  chain: DissectChainLinkSpec[];
}

export interface TableSpec {
  name: string;
  rows: string;
  where?: string;
  key: string;
  state?: Record<string, ProjectionStateSpec>;
  columns: Record<string, ProjectionColumnSpec>;
  parent_key?: ParentKeySpec;
}

export interface ProjectionSpec {
  version: '0.1' | '0.2' | '0.3';
  format: string;
  tables: TableSpec[];
  dissect?: DissectSpec[];
  streams?: StreamSpec[];
}

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const forbiddenNames = new Set(['__proto__', 'constructor', 'prototype']);
const isSafeIdentifier = (name: string): boolean => identifierPattern.test(name) && !forbiddenNames.has(name);
const identifier = z.string().refine(isSafeIdentifier, 'must be an identifier-safe name');
const nonEmptyString = z.string().min(1);
const arrowType = z.enum([
  'int8',
  'uint8',
  'int16',
  'uint16',
  'int32',
  'uint32',
  'int64',
  'uint64',
  'bool',
  'utf8',
  'timestamp_us',
  'binary',
]);

const stateSpec = z.strictObject({
  scope: nonEmptyString,
  init: z.number(),
  update: nonEmptyString,
});
const columnSpec = z.strictObject({
  expr: nonEmptyString,
  type: arrowType,
  when: nonEmptyString.optional(),
});

const namedRecord = <T extends z.ZodType>(value: T) =>
  z.record(z.string(), value).superRefine((record, context) => {
    for (const name of Object.keys(record)) {
      if (!isSafeIdentifier(name)) {
        context.addIssue({
          code: 'custom',
          message: 'must be an identifier-safe name',
          path: [name],
        });
      }
    }
  });

const parentKeySpec = z.strictObject({ table: identifier, column: identifier });
const chainLinkSpec = z
  .strictObject({
    when: nonEmptyString,
    parser: identifier.optional(),
    stream: identifier.optional(),
    table: identifier.optional(),
  })
  .superRefine((link, context) => {
    if ((link.parser === undefined) === (link.stream === undefined)) {
      context.addIssue({ code: 'custom', message: 'exactly one of parser or stream is required' });
    }
    if (link.stream !== undefined && link.table !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'table is not allowed on a stream link',
        path: ['table'],
      });
    }
  });

const messageLinkSpec = z.strictObject({
  when: nonEmptyString,
  parser: identifier,
  table: identifier.optional(),
});

const streamSpec = z.strictObject({
  name: identifier,
  key: identifier,
  offset: nonEmptyString,
  framer: identifier,
  table: identifier,
  segments_table: identifier,
  max_buffer: z.number().int().positive(),
  messages: z.array(messageLinkSpec).min(1),
});

const dissectSpec = z.strictObject({
  from: identifier,
  payload: nonEmptyString,
  chain: z.array(chainLinkSpec).min(1),
});

const tableSpec = z.strictObject({
  name: identifier,
  rows: nonEmptyString,
  where: nonEmptyString.optional(),
  key: identifier,
  state: namedRecord(stateSpec).optional(),
  columns: namedRecord(columnSpec),
  parent_key: parentKeySpec.optional(),
});

const projectionSpec = z.strictObject({
  version: z
    .union([
      z.literal('0.1'),
      z.literal(0.1),
      z.literal('0.2'),
      z.literal(0.2),
      z.literal('0.3'),
      z.literal(0.3),
    ])
    .transform((value): '0.1' | '0.2' | '0.3' => {
      if (value === '0.3' || value === 0.3) return '0.3';
      if (value === '0.2' || value === 0.2) return '0.2';
      return '0.1';
    }),
  format: nonEmptyString,
  tables: z.array(tableSpec).min(1),
  dissect: z.array(dissectSpec).optional(),
  streams: z.array(streamSpec).optional(),
});

const issuePath = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? '$' : path.map(String).join('.');

const readOwnDataProperty = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};

const validateRawMappingNames = (yamlValue: unknown): void => {
  const tables = readOwnDataProperty(yamlValue, 'tables');
  if (!Array.isArray(tables)) return;

  for (const [tableIndex, table] of tables.entries()) {
    for (const section of ['state', 'columns'] as const) {
      const mapping = readOwnDataProperty(table, section);
      if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) continue;

      for (const name of Object.keys(mapping)) {
        if (!isSafeIdentifier(name)) {
          throw new ProjectionCompileError(
            'PROJECTION_SPEC_INVALID',
            `tables.${tableIndex}.${section}.${name}`,
            'must be an identifier-safe name',
          );
        }
        if (section === 'state' && !isProjectionStateName(name)) {
          throw new ProjectionCompileError(
            'PROJECTION_SPEC_INVALID',
            `tables.${tableIndex}.state.${name}`,
            'state name is reserved by the expression evaluator',
          );
        }
      }
    }
  }
};

export const parseProjectionSpec = (yamlText: string): ProjectionSpec => {
  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(yamlText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProjectionCompileError('PROJECTION_YAML_INVALID', '$', detail);
  }

  validateRawMappingNames(parsedYaml);

  const parsed = projectionSpec.safeParse(parsedYaml);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const path = issuePath(issue.path);
    throw new ProjectionCompileError('PROJECTION_SPEC_INVALID', path, issue.message);
  }

  const names = new Set<string>();
  for (const [index, table] of parsed.data.tables.entries()) {
    if (names.has(table.name)) {
      throw new ProjectionCompileError(
        'PROJECTION_TABLE_DUPLICATE',
        `tables.${index}.name`,
        `table ${JSON.stringify(table.name)} is declared more than once`,
      );
    }
    names.add(table.name);
  }

  if (parsed.data.version === '0.1') {
    if (parsed.data.dissect !== undefined) {
      throw new ProjectionCompileError(
        'PROJECTION_VERSION_REQUIRED',
        'dissect',
        'dissect requires version 0.2',
      );
    }
    const indexed = parsed.data.tables.findIndex((table) => table.parent_key !== undefined);
    if (indexed >= 0) {
      throw new ProjectionCompileError(
        'PROJECTION_VERSION_REQUIRED',
        `tables.${indexed}.parent_key`,
        'parent_key requires version 0.2',
      );
    }
  }

  if (parsed.data.version !== '0.3') {
    if (parsed.data.streams !== undefined) {
      throw new ProjectionCompileError(
        'PROJECTION_VERSION_REQUIRED',
        'streams',
        'streams requires version 0.3',
      );
    }
    const entryIndex = (parsed.data.dissect ?? []).findIndex((entry) =>
      entry.chain.some((link) => link.stream !== undefined),
    );
    if (entryIndex >= 0) {
      throw new ProjectionCompileError(
        'PROJECTION_VERSION_REQUIRED',
        `dissect.${entryIndex}.chain`,
        'stream chain links require version 0.3',
      );
    }
  }

  return parsed.data as ProjectionSpec;
};
