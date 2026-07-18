import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ProjectionCompileError, isProjectionStateName } from './expression.js';

export type ArrowTypeName =
  'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'int64' | 'uint64' | 'bool' | 'utf8';

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

export interface TableSpec {
  name: string;
  rows: string;
  where?: string;
  key: string;
  state?: Record<string, ProjectionStateSpec>;
  columns: Record<string, ProjectionColumnSpec>;
}

export interface ProjectionSpec {
  version: '0.1';
  format: string;
  tables: TableSpec[];
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

const tableSpec = z.strictObject({
  name: identifier,
  rows: nonEmptyString,
  where: nonEmptyString.optional(),
  key: identifier,
  state: namedRecord(stateSpec).optional(),
  columns: namedRecord(columnSpec),
});

const projectionSpec = z.strictObject({
  version: z.union([z.literal('0.1'), z.literal(0.1)]).transform((): '0.1' => '0.1'),
  format: nonEmptyString,
  tables: z.array(tableSpec).min(1),
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

  return parsed.data as ProjectionSpec;
};
