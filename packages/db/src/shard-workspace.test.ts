import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { describe, expect, it } from 'vitest';

import type { ExportFiles } from './export-files.js';
import { ShardWorkspace } from './shard-workspace.js';

describe('ShardWorkspace.stream', () => {
  it('keeps the primary failure first and as the cause when cancellation also fails', async () => {
    const controller = new AbortController();
    const cancelFailure = new Error('cancel failed');
    const connection = {
      send: async () => ({
        schema: {},
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            controller.abort(new Error('aborted'));
            return { done: false, value: {} };
          },
          return: async () => ({ done: true, value: undefined }),
        }),
      }),
      cancelSent: () => Promise.reject(cancelFailure),
    } as unknown as AsyncDuckDBConnection;
    const workspace = await ShardWorkspace.open(
      {
        database: { registerOPFSFileName: async () => {}, dropFile: async () => true },
        connect: async () => connection,
        createFiles: async () => ({}) as ExportFiles,
      },
      {
        staging: { kind: 'table-per-shard', table: 'staging' },
        label: 'Test operation',
        signal: controller.signal,
      },
    );
    await workspace.connect();

    const failure = await workspace.stream('select 1').then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors).toEqual([controller.signal.reason, cancelFailure]);
    expect(aggregate.cause).toBe(controller.signal.reason);
  });
});
