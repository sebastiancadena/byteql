# Paged Query Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every reported query row reachable while streaming large DuckDB results into a
bounded, OPFS-backed, seamlessly scrolling grid.

**Architecture:** Replace the whole-result database call with a single-execution `QuerySession`
that pulls Arrow pages, persists them to origin-private storage, and exposes a bounded decoded
cache. The app retains a maximum 16,384-row render window, prefetches at its edges, and uses global
row indexes so scrolling never creates a browser-height-sized spacer.

**Tech Stack:** TypeScript, DuckDB-WASM, Apache Arrow/Arrow IPC, OPFS, Svelte 5, TanStack Virtual,
Vitest, Playwright Chromium.

**Spec:** `docs/superpowers/specs/2026-08-25-paged-query-results-design.md`

## Global Constraints

- Privacy remains absolute: no external URLs, requests, runtime-loaded code, analytics, fonts,
  or CDNs; query pages are origin-private scratch and are deleted on replacement/disposal/reload.
- DuckDB executes the user's SQL once. Do not implement result paging by rewriting SQL with
  `LIMIT/OFFSET` or by issuing `COUNT(*)`.
- Initial fetch target is `1_024`; later page target is `8_192`; render-window cap is `16_384`;
  decoded page budget is `64 * 1024 * 1024` bytes.
- Incomplete copy is `<N> loaded · more available`; exact `<N> rows` appears only after EOF.
- Arrow IPC remains the storage boundary; never materialize a whole result as JavaScript row
  objects.
- Every production change follows red-green-refactor. Browser behavior requires Playwright proof,
  not jsdom-only assertions.
- Preserve unrelated work and use conventional commits without trailers or AI branding.

---

### Task 1: Repair the Frozen Virtualizer

**Files:**

- Create: `apps/web/e2e/query-result-scrolling.spec.ts`
- Modify: `apps/web/src/components/ResultGrid.svelte:15-24`
- Modify: `apps/web/e2e/support/app.ts`

**Interfaces:**

- Consumes: existing `ResultGrid { table, selectedRow, onselect }` contract.
- Produces: a virtualizer that attaches after `scrollElement` mounts and reacts to a new table's
  row count; `openMidiSample(page)` e2e helper.
- [ ] **Step 1: Add a reusable sample-opening helper**

Add this literal flow to `apps/web/e2e/support/app.ts` so new tests do not repeat the stale
single-click sample assumption:

```ts
export async function openMidiSample(page: Page): Promise<void> {
  await page.goto('/');
  await waitForAppReady(page);
  await page.getByRole('button', { name: /Try sample/u }).click();
  await page.getByRole('menuitem', { name: 'MIDI song (.mid)' }).click();
  await expect(page.getByRole('button', { name: 'Browse events' })).toBeVisible();
}
```

- [ ] **Step 2: Write the failing 300-row browser regression**

Create `query-result-scrolling.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { openMidiSample } from './support/app.js';

test('physical scrolling reaches the last row of a 300-row result', async ({ page }) => {
  await openMidiSample(page);
  await page.getByRole('textbox', { name: 'SQL query' }).fill('select i from range(300) t(i)');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByRole('main', { name: 'Results' }).getByText('300 rows')).toBeVisible();

  const scroll = page.locator('.grid-scroll');
  await scroll.hover();
  await page.mouse.wheel(0, 20_000);

  await expect(page.getByRole('row', { name: 'Row 300', exact: true })).toBeVisible();
});
```

- [ ] **Step 3: Run the browser test and verify RED**

Run:

```bash
pnpm --filter @byteql/web test:e2e -- query-result-scrolling.spec.ts
```

Expected: FAIL because scrolling changes `.grid-scroll.scrollTop` but `Row 300` never replaces
the initial virtual rows.

- [ ] **Step 4: Attach and update the virtualizer after mount**

Make the element reactive and push the options from an effect. Keep the existing keyed
`ResultGrid` remount, but do not depend on it for element attachment:

```ts
let scrollElement = $state<HTMLDivElement | null>(null);

const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
  count: table.numRows,
  getScrollElement: () => scrollElement,
  estimateSize: () => 36,
  overscan: 8,
  initialRect: { width: 960, height: 360 },
});

$effect(() => {
  const element = scrollElement;
  const count = table.numRows;
  untrack(() => $virtualizer.setOptions({ count, getScrollElement: () => element }));
});
```

- [ ] **Step 5: Verify GREEN and protect the component suite**

Run:

```bash
pnpm --filter @byteql/web test:e2e -- query-result-scrolling.spec.ts
pnpm --filter @byteql/web test -- --run src/components/Workbench.test.ts
pnpm --filter @byteql/web check
```

Expected: all PASS with pristine output.

- [ ] **Step 6: Commit the immediate regression fix**

```bash
git add apps/web/e2e/query-result-scrolling.spec.ts apps/web/e2e/support/app.ts \
  apps/web/src/components/ResultGrid.svelte
git commit -m "fix(web): attach result grid virtualizer after mount"
```

---

### Task 2: Add the Origin-Private Query Page Store

**Files:**

- Create: `packages/db/src/query-pages.ts`
- Create: `packages/db/src/query-pages.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**

- Consumes: Arrow `Table`, Arrow IPC serialization, `navigator.storage.getDirectory`.
- Produces:
  `QueryPageStore.put(index, startRow, table)`, `get(index)`, `pin(indexes)`,
  `materialize(maxBytes)`, `dispose()`, and `sweepQueryPageOrphans()`.
- [ ] **Step 1: Write failing tests for memory, OPFS, and lifecycle behavior**

Define a narrow injectable persistence seam in the test and assert real Arrow values:

```ts
interface QueryPagePersistence {
  write(index: number, ipc: Uint8Array): Promise<void>;
  read(index: number): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

class FakePersistence implements QueryPagePersistence {
  readonly files = new Map<number, Uint8Array>();
  readonly reads: number[] = [];
  readonly writes: Array<{ index: number; ipc: Uint8Array }> = [];
  failWriteOnce = false;
  disposeCalls = 0;

  async write(index: number, ipc: Uint8Array): Promise<void> {
    this.writes.push({ index, ipc });
    if (this.failWriteOnce) {
      this.failWriteOnce = false;
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    }
    this.files.set(index, ipc.slice());
  }

  async read(index: number): Promise<Uint8Array> {
    this.reads.push(index);
    const ipc = this.files.get(index);
    if (!ipc) throw new Error(`missing page ${index}`);
    return ipc.slice();
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.files.clear();
  }
}

it('evicts unpinned decoded pages and reloads exact Arrow values from persistence', async () => {
  const persistence = new FakePersistence();
  const store = new QueryPageStore({ persistence, memoryLimitBytes: 80 });
  await store.put(0, 0, tableFromArrays({ value: [10, 11] }));
  await store.put(1, 2, tableFromArrays({ value: [12, 13] }));
  store.pin([1]);

  const page = await store.get(0);

  expect(page.startRow).toBe(0);
  expect(Array.from(page.table.getChild('value')!.toArray())).toEqual([10, 11]);
  expect(persistence.reads).toContain(0);
});

it('retains a failed write as pending and retries the same bytes', async () => {
  const persistence = new FakePersistence();
  persistence.failWriteOnce = true;
  const store = new QueryPageStore({ persistence });
  const table = tableFromArrays({ value: [7] });

  await expect(store.put(0, 0, table)).rejects.toMatchObject({
    message: expect.stringContaining('RESULT_SPILL_QUOTA_EXCEEDED'),
  });
  await store.retryPending();

  expect((await store.get(0)).table.getChild('value')!.get(0)).toBe(7);
  expect(persistence.writes.map(({ index }) => index)).toEqual([0, 0]);
});

it('rejects an over-budget no-OPFS result without discarding prior pages', async () => {
  const store = new QueryPageStore({ persistence: null, memoryLimitBytes: 1 });
  await expect(store.put(0, 0, tableFromArrays({ value: [1] }))).rejects.toThrow(
    'RESULT_SPILL_UNSUPPORTED',
  );
});

it('materializes only a complete result within the byte limit and disposes once', async () => {
  const persistence = new FakePersistence();
  const store = new QueryPageStore({ persistence });
  await store.put(0, 0, tableFromArrays({ value: [1, 2] }));
  await store.put(1, 2, tableFromArrays({ value: [3] }));
  store.markComplete();

  expect((await store.materialize(64 * 1024 * 1024))!.numRows).toBe(3);
  await Promise.all([store.dispose(), store.dispose()]);
  expect(persistence.disposeCalls).toBe(1);
});
```

Also test generated-only path segments, recursive generation deletion, and reload orphan sweep
with fake `FileSystemDirectoryHandle` objects following `spill-files.test.ts`.

- [ ] **Step 2: Run the store tests and verify RED**

Run:

```bash
pnpm --filter @byteql/db test -- --run src/query-pages.test.ts
```

Expected: FAIL because `query-pages.ts` and its exports do not exist.

- [ ] **Step 3: Implement the page store and OPFS persistence**

Use these constants and exported shapes:

```ts
export const QUERY_RESULT_MEMORY_BYTES = 64 * 1024 * 1024;
const QUERY_RESULT_ROOT = 'byteql-results';

export interface StoredQueryPage {
  readonly index: number;
  readonly startRow: number;
  readonly rowCount: number;
  readonly ipcBytes: number;
  readonly table: Table;
}

export interface QueryPageStoreOptions {
  persistence: QueryPagePersistence | null;
  memoryLimitBytes?: number;
}

export class QueryPageStore {
  readonly storedBytes: number;
  put(index: number, startRow: number, table: Table): Promise<StoredQueryPage>;
  retryPending(): Promise<StoredQueryPage>;
  get(index: number): Promise<StoredQueryPage>;
  pin(indexes: readonly number[]): void;
  markComplete(): void;
  materialize(maxBytes: number): Promise<Table | null>;
  dispose(): Promise<void>;
}

export function createOpfsQueryPagePersistence(
  generation: number,
): Promise<QueryPagePersistence | null>;
export function sweepQueryPageOrphans(): Promise<void>;
```

Serialize with `tableToIPC(table, 'stream')`; decode with `tableFromIPC`. Maintain metadata for
every stored page separately from the decoded LRU. Count bytes using the serialized IPC length.
Pin before eviction. When `persistence === null`, fail before accepting bytes beyond the budget.
Map quota-shaped errors through the existing `isQuotaError` predicate.

- [ ] **Step 4: Verify GREEN and package exports**

Export `QueryPageStore`, constants, persistence factory, sweep function, and their public types
from `packages/db/src/index.ts`, then run:

```bash
pnpm --filter @byteql/db test -- --run src/query-pages.test.ts
pnpm --filter @byteql/db check
```

Expected: PASS.

- [ ] **Step 5: Commit the page store**

```bash
git add packages/db/src/query-pages.ts packages/db/src/query-pages.test.ts packages/db/src/index.ts
git commit -m "feat(db): add origin-private query page store"
```

---

### Task 3: Replace Whole-Result Queries with a Pull-Based Cursor

**Files:**

- Modify: `packages/db/src/types.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/browser.ts`
- Modify: `packages/db/src/browser.test.ts`

**Interfaces:**

- Consumes: `QueryPageStore` from Task 2 and DuckDB's async Arrow reader.
- Produces: `ByteqlDatabase.startQuery(sql): Promise<QuerySession>` and the exact public
  `QueryPage`, `QueryStatus`, and `QuerySession` contracts from the design spec.
- [ ] **Step 1: Replace the old query test with failing cursor tests**

Create a fake async reader whose iterator increments `pulls` and whose `schema` is the DuckDB
result schema:

```ts
const duckdbResultTable = (start: number, rows: number): DuckdbTable =>
  new DuckdbTable({
    value: duckdbVectorFromArray(
      Array.from({ length: rows }, (_, offset) => start + offset),
      new DuckdbInt32(),
    ),
  });

const batchReader = (tables: readonly DuckdbTable[]) => {
  const batches = tables.flatMap((table) => table.batches);
  let pulls = 0;
  return {
    schema: batches[0]!.schema,
    get pulls() { return pulls; },
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          pulls += 1;
          return index < batches.length
            ? { done: false as const, value: batches[index++]! }
            : { done: true as const, value: undefined };
        },
      };
    },
  };
};
```

Add these assertions before changing production types:

```ts
it('pulls only the requested initial page and preserves the remainder', async () => {
  const reader = batchReader([duckdbResultTable(0, 700), duckdbResultTable(700, 700)]);
  duckdbMocks.connection.send.mockResolvedValueOnce(reader);
  const database = await createBrowserDatabase();

  const session = await database.startQuery('select * from events');
  const first = await session.fetchNext(1_024);

  expect(first).toMatchObject({ index: 0, startRow: 0, rowCount: 1_024 });
  expect(first!.table.numRows).toBe(1_024);
  expect(reader.pulls).toBeLessThanOrEqual(2);
  expect(session.status()).toMatchObject({ loadedRows: 1_024, complete: false });

  const second = await session.fetchNext(8_192);
  expect(second).toMatchObject({ index: 1, startRow: 1_024, rowCount: 376 });
  expect(session.status()).toMatchObject({ loadedRows: 1_400, complete: true });
});

it('serializes concurrent fetchNext calls without duplicating rows', async () => {
  const reader = batchReader([duckdbResultTable(0, 2), duckdbResultTable(2, 2)]);
  duckdbMocks.connection.send.mockResolvedValueOnce(reader);
  const database = await createBrowserDatabase();
  const session = await database.startQuery('select * from events');
  const [first, second] = await Promise.all([session.fetchNext(2), session.fetchNext(2)]);
  expect([first!.startRow, second!.startRow]).toEqual([0, 2]);
  expect([
    ...first!.table.getChild('value')!.toArray(),
    ...second!.table.getChild('value')!.toArray(),
  ]).toEqual([0, 1, 2, 3]);
});

it('cancels and closes the active cursor before a replacement query', async () => {
  const first = await database.startQuery('select 1');
  await database.startQuery('select 2');
  await expect(first.fetchNext()).rejects.toThrow('Query result session is closed.');
  expect(duckdbMocks.connection.cancelSent).toHaveBeenCalledOnce();
});
```

Retain disposal, cancellation, operation serialization, and performance timing coverage, but
assert them through `QuerySession` rather than the removed `QueryResult`.

- [ ] **Step 2: Run the database tests and verify RED**

Run:

```bash
pnpm --filter @byteql/db test -- --run src/browser.test.ts
```

Expected: TypeScript/test failure because `startQuery` and `QuerySession` do not exist.

- [ ] **Step 3: Define the cursor interfaces and constants**

In `types.ts`, remove `QueryResult` and add:

```ts
export const QUERY_INITIAL_ROWS = 1_024;
export const QUERY_PAGE_ROWS = 8_192;

export interface QueryPage {
  readonly index: number;
  readonly startRow: number;
  readonly rowCount: number;
  readonly table: Table;
}

export type QueryPageSummary = Omit<QueryPage, 'table'>;

export interface QueryStatus {
  readonly loadedRows: number;
  readonly complete: boolean;
  readonly elapsedMs: number;
  readonly storedBytes: number;
}

export interface QuerySession {
  readonly schema: Schema;
  status(): QueryStatus;
  pages(): readonly QueryPageSummary[];
  fetchNext(targetRows?: number): Promise<QueryPage | null>;
  retryPending(): Promise<QueryPage>;
  readPage(index: number): Promise<QueryPage>;
  pinPages(indexes: readonly number[]): void;
  materialize(maxBytes?: number): Promise<Table | null>;
  cancel(): Promise<boolean>;
  dispose(): Promise<void>;
}
```

Change `ByteqlDatabase.query` to `startQuery` and export all new types/constants.

- [ ] **Step 4: Implement `QuerySessionImpl` without full-result materialization**

In `browser.ts`, retain the DuckDB reader's async iterator. Convert its Arrow-17 schema once with
`new DuckdbTable(reader.schema)` → page-local IPC → Arrow-21 `tableFromIPC`, without pulling any
rows. Accumulate only page-local DuckDB record batches. Split a crossing batch with
`batch.slice(0, needed)` and retain `batch.slice(needed)` as the next page's remainder. Convert one
page at a time through
`RecordBatchStreamWriter.writeAll(new DuckdbTable(reader.schema, pageBatches)).toUint8Array()` and
`tableFromIPC`; never invoke `writeAll(reader)`.

Serialize `fetchNext` using a private promise tail. Publish `loadedRows` only after
`QueryPageStore.put` succeeds. When iterator `done` is observed, call `store.markComplete()`.
`retryPending` only republishes the page retained after a storage failure. `materialize` delegates
to the store and returns `null` above the configured limit.

`BrowserDatabase` tracks `activeQuery`. `startQuery` cancels/disposes the previous session before
calling `connection.send`. `beginIngest` and `dispose` do the same. Collection/statistics calls
reject while a cursor owns the connection. Keep `cancelQuery` outside the operation queue so it
can interrupt `send`/iteration.

- [ ] **Step 5: Verify GREEN and the full DB suite**

Run:

```bash
pnpm --filter @byteql/db test -- --run src/browser.test.ts src/query-pages.test.ts
pnpm --filter @byteql/db check
```

Expected: PASS; the old whole-result test and `QueryResult` export are absent.

- [ ] **Step 6: Commit the cursor API**

```bash
git add packages/db/src/types.ts packages/db/src/index.ts packages/db/src/browser.ts \
  packages/db/src/browser.test.ts
git commit -m "feat(db): stream query results through paged cursors"
```

---

### Task 4: Model Global Rows and Bounded Result Windows

**Files:**

- Create: `apps/web/src/lib/session/result-window.ts`
- Create: `apps/web/src/lib/session/result-window.test.ts`
- Modify: `apps/web/src/lib/session/state.ts`
- Modify: `apps/web/src/lib/session/state.test.ts`

**Interfaces:**

- Consumes: `QueryPage` summaries and Arrow page tables.
- Produces: `PagedResultState`, reducer events, `RESULT_WINDOW_ROWS`,
  `pageIndexesForWindow`, and `assembleResultWindow`.
- [ ] **Step 1: Write failing pure window tests**

```ts
const page = (index: number, startRow: number, values: readonly number[]): QueryPage => ({
  index,
  startRow,
  rowCount: values.length,
  table: tableFromArrays({ value: Int32Array.from(values) }),
});

const pageSummaries = (counts: readonly number[]): QueryPageSummary[] => {
  let startRow = 0;
  return counts.map((rowCount, index) => {
    const summary = { index, startRow, rowCount };
    startRow += rowCount;
    return summary;
  });
};

it('selects only pages intersecting a 16384-row window around the anchor', () => {
  const pages = pageSummaries([1_024, 8_192, 8_192, 8_192]);
  const selected = pageIndexesForWindow(pages, 17_000, 16_384);
  expect(selected).toEqual([1, 2, 3]);
});

it('assembles exact global order and slices boundary pages', () => {
  const window = assembleResultWindow(
    [page(0, 0, [0, 1, 2]), page(1, 3, [3, 4, 5])],
    { startRow: 2, rowCount: 3 },
  );
  expect(window.startRow).toBe(2);
  expect(window.table.getChild('value')!.toArray()).toEqual([2, 3, 4]);
});
```

- [ ] **Step 2: Write failing reducer tests for partial and completed results**

Use the desired state shape:

```ts
const pagedResult: PagedResultState = {
  generation: 1,
  schema: table.schema,
  loadedRows: 1_024,
  complete: false,
  loadingMore: false,
  windowStart: 0,
  window: table,
  completeTable: null,
  elapsedMs: 7,
  pageError: null,
  pageErrorRetryable: false,
};

expect(reduceSession(querying, { type: 'querySucceeded', result: pagedResult })).toMatchObject({
  phase: 'ready', result: pagedResult, queryError: null,
});

expect(reduceSession(ready, {
  type: 'queryWindowUpdated',
  result: { ...pagedResult, loadedRows: 9_216, loadingMore: false },
}).selectedRow).toBe(ready.selectedRow);
```

Also assert `queryPageFailed`, retry start, EOF completion, cancellation, replacement opening,
and the removal of `queryElapsedMs`.

- [ ] **Step 3: Run the tests and verify RED**

Run:

```bash
pnpm --filter @byteql/web test -- --run \
  src/lib/session/result-window.test.ts src/lib/session/state.test.ts
```

Expected: FAIL because the window module and paged reducer events do not exist.

- [ ] **Step 4: Implement the pure window planner**

Export:

```ts
export const RESULT_WINDOW_ROWS = 16_384;

export function pageIndexesForWindow(
  pages: readonly QueryPageSummary[],
  anchorRow: number,
  maximumRows = RESULT_WINDOW_ROWS,
): number[];

export function assembleResultWindow(
  pages: readonly QueryPage[],
  range: { startRow: number; rowCount: number },
): { startRow: number; table: Table };
```

Clamp the desired range to `[0, loadedRows)`, center around `anchorRow` where possible, and use
Arrow `Table.slice` plus `new Table(schema, batches)`/`concat` without row-object conversion.

- [ ] **Step 5: Implement paged session state**

Add `PagedResultState` exactly as shown in Step 2. Replace query events with:

```ts
| { type: 'querySucceeded'; result: PagedResultState }
| { type: 'queryWindowUpdated'; result: PagedResultState }
| { type: 'queryPageFailed'; message: string; retryable: boolean }
```

`queryStarted` clears selection/error but retains the displayed prior result. Initial success
replaces the result and clears byte selection. Window updates preserve global selection and byte
selection. Remove `SessionState.queryElapsedMs`; timing lives at `result.elapsedMs`.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
pnpm --filter @byteql/web test -- --run \
  src/lib/session/result-window.test.ts src/lib/session/state.test.ts
pnpm --filter @byteql/web check
```

Then commit:

```bash
git add apps/web/src/lib/session/result-window.ts apps/web/src/lib/session/result-window.test.ts \
  apps/web/src/lib/session/state.ts apps/web/src/lib/session/state.test.ts
git commit -m "feat(web): model paged query result windows"
```

---

### Task 5: Drive Demand, Retry, and Cleanup from `SessionController`

**Files:**

- Modify: `apps/web/src/lib/session/controller.ts`
- Modify: `apps/web/src/lib/session/controller.test.ts`

**Interfaces:**

- Consumes: `ByteqlDatabase.startQuery`, `QuerySession`, window helpers, and paged reducer events.
- Produces: `loadMoreResults()`, `loadResultWindow(globalRow)`, and `retryResultPage()`.
- [ ] **Step 1: Replace the fake whole-query database with fake query sessions**

Add a `FakeQuerySession` whose methods are deferred and observable:

```ts
class FakeQuerySession implements QuerySession {
  readonly schema = tableFromArrays({ value: [0] }).schema;
  readonly fetchCalls: number[] = [];
  readonly readCalls: number[] = [];
  pagesValue: QueryPageSummary[] = [];
  nextPages: QueryPage[] = [];
  complete = false;
  disposed = 0;
  cancelled = 0;
  retryPage: QueryPage | null = null;
  readonly fetched = new Map<number, QueryPage>();
  fetchGate: Promise<void> | null = null;

  async fetchNext(targetRows = QUERY_PAGE_ROWS): Promise<QueryPage | null> {
    this.fetchCalls.push(targetRows);
    if (this.fetchGate) await this.fetchGate;
    const page = this.nextPages.shift() ?? null;
    if (page) {
      this.fetched.set(page.index, page);
      this.pagesValue.push({
        index: page.index,
        startRow: page.startRow,
        rowCount: page.rowCount,
      });
    }
    else this.complete = true;
    return page;
  }

  status(): QueryStatus {
    return {
      loadedRows: this.pagesValue.reduce((sum, page) => sum + page.rowCount, 0),
      complete: this.complete,
      elapsedMs: 2,
      storedBytes: 0,
    };
  }

  pages(): readonly QueryPageSummary[] { return this.pagesValue; }
  pinPages(): void {}

  async retryPending(): Promise<QueryPage> {
    if (!this.retryPage) throw new Error('no pending page');
    return this.retryPage;
  }

  async readPage(index: number): Promise<QueryPage> {
    this.readCalls.push(index);
    const page = this.fetched.get(index);
    if (!page) throw new Error(`missing page ${index}`);
    return page;
  }

  async materialize(): Promise<Table | null> {
    if (!this.complete) return null;
    const pages = [...this.fetched.values()].sort((a, b) => a.index - b.index);
    return pages.length === 0
      ? null
      : pages[0]!.table.concat(...pages.slice(1).map((page) => page.table));
  }

  async cancel(): Promise<boolean> { this.cancelled += 1; return true; }
  async dispose(): Promise<void> { this.disposed += 1; }
}
```

Make `fakeDatabase.startQuery` allocate one and return it.

Use real Arrow pages in the tests:

```ts
const rangeValues = (count: number, start = 0): number[] =>
  Array.from({ length: count }, (_, offset) => start + offset);

const page = (index: number, startRow: number, values: readonly number[]): QueryPage => ({
  index,
  startRow,
  rowCount: values.length,
  table: tableFromArrays({ value: Int32Array.from(values) }),
});
```

- [ ] **Step 2: Write failing controller behavior tests**

Cover the following as separate tests:

```ts
it('publishes the first page without draining the cursor', async () => {
  const running = controller.runQuery('select * from events');
  const query = querySessions[0]!;
  query.nextPages.push(page(0, 0, rangeValues(1_024)));
  query.complete = false;
  await running;
  expect(query.fetchCalls).toEqual([QUERY_INITIAL_ROWS]);
  expect(controller.getState().result).toMatchObject({ loadedRows: 1_024, complete: false });
});

it('coalesces repeated tail demand into one fetch and appends global rows once', async () => {
  const first = controller.loadMoreResults();
  const second = controller.loadMoreResults();
  expect(first).toBe(second);
  await first;
  expect(query.fetchCalls.filter((rows) => rows === QUERY_PAGE_ROWS)).toHaveLength(1);
});

it('loads an evicted prior window from stored pages without starting SQL again', async () => {
  await controller.loadResultWindow(500);
  expect(database.startQuery).toHaveBeenCalledOnce();
  expect(query.readCalls).toContain(0);
  expect(controller.getState().result!.windowStart).toBe(0);
});

it('disposes a stale cursor and never publishes its late page', async () => {
  const gate = deferred<void>();
  firstQuery.fetchGate = gate.promise;
  firstQuery.nextPages.push(page(1, 1_024, rangeValues(8_192, 1_024)));
  const staleLoad = controller.loadMoreResults();
  const replacement = controller.runQuery('select 2');
  gate.resolve();
  await Promise.allSettled([staleLoad, replacement]);
  expect(firstQuery.disposed).toBe(1);
  expect(controller.getState().sql).toBe('select 2');
});
```

Also test storage retry, terminal cursor failure, cancellation during demand, initial failure
retaining the previous window as a static result, complete-table materialization below 64 MiB,
viewer disablement above it, open-file cleanup, and controller disposal.

- [ ] **Step 3: Run the focused controller tests and verify RED**

Run:

```bash
pnpm --filter @byteql/web test -- --run src/lib/session/controller.test.ts
```

Expected: compile/test failures for the missing query-session methods and paged state.

- [ ] **Step 4: Implement query-session ownership and initial fetch**

Add private fields:

```ts
private activeQuery: QuerySession | null = null;
private resultDemand: Promise<void> | null = null;
```

`executeQuery` starts a cursor, fetches `QUERY_INITIAL_ROWS`, builds the initial result window,
and asks `materialize()` only when EOF is already known. Do not publish if either generation is
stale. Dispose the prior cursor on replacement while retaining its last immutable state for the
existing failed-query behavior; if that state was incomplete, set a literal stopped-result
diagnostic because its cursor is no longer resumable.

- [ ] **Step 5: Implement forward and backward demand**

`loadMoreResults` returns the existing `resultDemand` promise when present. Otherwise it fetches
`QUERY_PAGE_ROWS`, updates summaries, and rebuilds a 16,384-row window anchored at the former
tail. At EOF, set `complete: true` and request `completeTable = await query.materialize()`.

`loadResultWindow(globalRow)` validates `0 <= globalRow < loadedRows`, finds intersecting page
summaries with `pageIndexesForWindow`, pins them, reads them, and publishes the assembled window.
Every async boundary repeats `isCurrentQuery` before dispatch.

`retryResultPage` invokes `activeQuery.retryPending`, then follows the same publish path as a
successful forward page. Terminal cursor errors set `pageErrorRetryable: false`.

- [ ] **Step 6: Centralize exact-once cursor cleanup**

Add `closeActiveQuery({ cancel }: { cancel: boolean })`. Use it from new query, open batch,
cancel, failure, and dispose. Call `cancel()` before `dispose()` when work is active. Clear
`resultDemand` in `finally`; never let cleanup rejection overwrite the primary action error.

- [ ] **Step 7: Verify GREEN and commit**

Run:

```bash
pnpm --filter @byteql/web test -- --run \
  src/lib/session/controller.test.ts src/lib/session/state.test.ts \
  src/lib/session/result-window.test.ts
pnpm --filter @byteql/web check
```

Then commit:

```bash
git add apps/web/src/lib/session/controller.ts apps/web/src/lib/session/controller.test.ts
git commit -m "feat(web): stream query pages through session state"
```

---

### Task 6: Build the Sliding Infinite Grid and Adapt Consumers

**Files:**

- Create: `apps/web/src/lib/session/result-scroll.ts`
- Create: `apps/web/src/lib/session/result-scroll.test.ts`
- Modify: `apps/web/src/components/ResultGrid.svelte`
- Modify: `apps/web/src/components/Workbench.svelte`
- Modify: `apps/web/src/components/Workbench.test.ts`
- Modify: `apps/web/src/components/Inspector.svelte`
- Modify: `apps/web/src/components/StatusBar.svelte`
- Modify: `apps/web/src/lib/hex/coverage.ts`
- Modify: `apps/web/src/lib/hex/coverage.test.ts`
- Modify: `apps/web/src/lib/sql-literal.ts`
- Modify: `apps/web/src/lib/sql-literal.test.ts`
- Modify: `apps/web/src/lib/viewers/registry.ts`
- Modify: affected component/viewer tests under `apps/web/src/components/`

**Interfaces:**

- Consumes: `PagedResultState` and the controller demand methods.
- Produces: seamless edge demand, global row selection/provenance, honest loaded/complete copy,
  quoted Browse SQL, and complete-only viewers.
- [ ] **Step 1: Write failing pure scroll and identifier tests**

```ts
it('requests forward demand within eight rows of the window tail', () => {
  expect(resultDemand({ firstVisible: 16_360, lastVisible: 16_380, windowStart: 0,
    windowRows: 16_384, loadedRows: 16_384, complete: false })).toBe('forward');
});

it('requests backward demand near an evicted window head', () => {
  expect(resultDemand({ firstVisible: 2, lastVisible: 20, windowStart: 20_000,
    windowRows: 16_384, loadedRows: 40_000, complete: false })).toBe('backward');
});

it('quotes SQL identifiers including embedded double quotes', () => {
  expect(sqlIdentifier('dns records')).toBe('"dns records"');
  expect(sqlIdentifier('a"b')).toBe('"a""b"');
});
```

Also test `scrollCompensation(previousStart, nextStart, 36)` returns the signed pixel adjustment
and never uses total loaded rows.

- [ ] **Step 2: Write failing Workbench and grid integration tests**

Assert:

- incomplete heading is `1,024 loaded · more available`;
- complete heading is `300 rows`;
- `ResultGrid` receives/sends global indexes when `windowStart !== 0`;
- a near-tail virtual range calls `loadMoreResults` once while loading;
- a near-head range calls `loadResultWindow(windowStart - 1)`;
- page failure exposes `Retry loading rows` only when retryable;
- Explorer Browse calls `select * from "records"` without `limit`;
- Inspector receives `selectedRow - windowStart` and displays the global row label;
- viewer menu is absent for incomplete/oversized results and receives `completeTable` otherwise;
- coverage rows add `windowStart` before calling `selectResultRow`.
- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @byteql/web test -- --run \
  src/lib/session/result-scroll.test.ts src/lib/sql-literal.test.ts \
  src/components/Workbench.test.ts src/lib/hex/coverage.test.ts
```

Expected: FAIL on missing helpers and old whole-table rendering.

- [ ] **Step 4: Implement pure demand and compensation helpers**

Export from `result-scroll.ts`:

```ts
export type ResultDemand = 'forward' | 'backward' | null;
export const RESULT_EDGE_ROWS = 8;
export const RESULT_ROW_HEIGHT = 36;
export interface DemandInput {
  readonly firstVisible: number;
  readonly lastVisible: number;
  readonly windowStart: number;
  readonly windowRows: number;
  readonly loadedRows: number;
  readonly complete: boolean;
}
export function resultDemand(input: DemandInput): ResultDemand;
export function scrollCompensation(
  previousStart: number,
  nextStart: number,
  rowHeight = 36,
): number;
```

Return forward only when the result is incomplete and the visible global tail is within eight
rows of `loadedRows`. Return backward whenever `windowStart > 0` and the local visible head is
within eight rows of zero.

- [ ] **Step 5: Convert `ResultGrid` to global sliding-window props**

Use this contract:

```ts
interface Props {
  table: Table;
  windowStart: number;
  loadedRows: number;
  complete: boolean;
  loadingMore: boolean;
  pageError: string | null;
  pageErrorRetryable: boolean;
  selectedRow?: number | null;
  onselect(globalRow: number): void;
  onloadmore(): void;
  onloadwindow(globalRow: number): void;
  onretry(): void;
}
```

Keep virtualizer `count = table.numRows`. Render and key rows by global index. Set
`aria-rowcount={complete ? loadedRows + 1 : -1}` and `aria-busy={loadingMore}`. In a scroll/effect
handler, inspect `$virtualizer.getVirtualItems()`, call `resultDemand`, and fire callbacks through
an in-component direction guard so unchanged ranges do not loop. Apply `scrollCompensation` after
`windowStart` changes and before the next paint. Observe the tail sentinel with
`IntersectionObserver` for normal prefetch and run the same demand calculation from scroll events
as the deterministic fallback. Render loading/end/error sentinels outside the absolute row layer.

- [ ] **Step 6: Adapt Workbench, Inspector, coverage, viewers, and StatusBar**

Add the controller methods to `ControllerPort`. Pass `session.result.window` and paged metadata to
the grid. Compute:

```ts
const selectedLocalRow = $derived(
  session.result && session.selectedRow !== null &&
  session.selectedRow >= session.result.windowStart &&
  session.selectedRow < session.result.windowStart + session.result.window.numRows
    ? session.selectedRow - session.result.windowStart
    : null,
);
```

Use `completeTable` for viewer compatibility and viewer rendering. Use `window` for coverage and
add `windowStart` to returned coverage row indexes. Pass `selectedLocalRow` into Inspector plus a
new `selectedGlobalRow` prop for its chip copy. Update StatusBar and results heading from paged
metadata and timing; label timing as streaming while incomplete and total after EOF.

Add `sqlIdentifier` to `sql-literal.ts`; Browse uses
`` `select * from ${sqlIdentifier(name)}` ``. Update coverage empty-copy for incomplete results to
`No loaded result row covers this byte`.

- [ ] **Step 7: Verify GREEN and commit**

Run:

```bash
pnpm --filter @byteql/web test -- --run
pnpm --filter @byteql/web check
```

Then commit all Task 6 files:

```bash
git add apps/web/src/components apps/web/src/lib/hex apps/web/src/lib/session/result-scroll.ts \
  apps/web/src/lib/session/result-scroll.test.ts apps/web/src/lib/sql-literal.ts \
  apps/web/src/lib/sql-literal.test.ts apps/web/src/lib/viewers/registry.ts
git commit -m "feat(web): render paged results with infinite scrolling"
```

---

### Task 7: Prove Million-Row Reachability, Bounded Geometry, and Privacy

**Files:**

- Modify: `apps/web/e2e/query-result-scrolling.spec.ts`
- Modify: `apps/web/e2e/open-query-inspect.spec.ts`
- Modify: `apps/web/e2e/performance.spec.ts`
- Modify: `apps/web/e2e/support/app.ts`
- Modify: `apps/web/src/lib/e2e-harness.ts`
- Modify: `apps/web/e2e/privacy.spec.ts`

**Interfaces:**

- Consumes: the complete paged query UI and e2e-only instrumentation.
- Produces: acceptance proof that rows beyond the old browser ceiling remain reachable without
  re-executing SQL or leaking network requests.
- [ ] **Step 1: Extend the e2e harness with read-only query diagnostics**

Expose under the existing `BYTEQL_E2E` build guard:

```ts
queryResultMetrics(): {
  loadedRows: number;
  complete: boolean;
  windowStart: number;
  windowRows: number;
  sendCount: number;
  decodedBytes: number;
  resultOpfsPaths: readonly string[];
};
drainQueryResult(): Promise<void>;
loadResultWindow(globalRow: number): Promise<void>;
```

The harness reads counters already maintained by the production session/page store; it must not
add production behavior or publish SQL/result values.

- [ ] **Step 2: Write the failing million-row acceptance test**

Extend `query-result-scrolling.spec.ts`:

```ts
test('seamless demand reaches row one million with bounded geometry', async ({ page }) => {
  await openMidiSample(page);
  await page.getByRole('textbox', { name: 'SQL query' })
    .fill('select i from range(1000000) t(i)');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByText('1,024 loaded · more available', { exact: true })).toBeVisible();

  const scroll = page.locator('.grid-scroll');
  await scroll.hover();
  await page.mouse.wheel(0, 1_000_000);
  await expect.poll(async () => {
    const text = await page.locator('.results-heading-meta').textContent();
    return Number((text?.replaceAll(',', '').match(/\d+/u) ?? ['0'])[0]);
  }).toBeGreaterThan(1_024);

  await page.evaluate(async () => window.__BYTEQL_E2E__!.drainQueryResult());

  await expect(page.getByText('1,000,000 rows', { exact: true })).toBeVisible();
  await page.evaluate(async () => window.__BYTEQL_E2E__!.loadResultWindow(999_999));
  await expect(page.getByRole('row', { name: 'Row 1000000', exact: true })).toBeVisible();

  const metrics = await page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics());
  expect(metrics.windowRows).toBeLessThanOrEqual(16_384);
  expect(metrics.sendCount).toBe(1);
  expect(metrics.decodedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  expect(await page.locator('.grid-virtual-space').evaluate((node) => node.scrollHeight))
    .toBeLessThanOrEqual(16_384 * 36);
});
```

`drainQueryResult` repeatedly calls the same production `loadMoreResults` demand method; it is a
test accelerator, not a second loading path. `loadResultWindow` invokes the same production
backward-window method.

- [ ] **Step 3: Run the acceptance test and verify RED**

Run:

```bash
pnpm --filter @byteql/web test:e2e -- query-result-scrolling.spec.ts
```

Expected: FAIL until the e2e metrics/drain seam is wired and cleanup is observable.

- [ ] **Step 4: Wire the guarded harness and lifecycle assertions**

Add harness callbacks in `App.svelte`/controller setup only when `import.meta.env.BYTEQL_E2E` is
true. Extend the test to scroll back to an early OPFS-backed page and assert exact values with
`sendCount === 1`. Start a replacement query and assert the previous generation's paths disappear.

Repair `open-query-inspect.spec.ts` and `performance.spec.ts` to select the MIDI menu item through
`openMidiSample` rather than assuming one Try Sample click starts loading.

- [ ] **Step 5: Extend privacy coverage**

Run a multi-page query in `privacy.spec.ts` after readiness and assert the existing captured
request list remains empty. Enumerate `byteql-results/` only through the e2e harness and assert
the directory is local scratch, never a URL fetch target.

- [ ] **Step 6: Run targeted acceptance and verify GREEN**

Run:

```bash
pnpm --filter @byteql/web test:e2e -- \
  query-result-scrolling.spec.ts open-query-inspect.spec.ts performance.spec.ts privacy.spec.ts
pnpm --filter @byteql/web check:bundle
```

Expected: all PASS; query `sendCount` remains one for the million-row run and zero network
requests occur after readiness.

- [ ] **Step 7: Run the full release gate**

Run from repository root:

```bash
pnpm -r check
pnpm -r test -- --run
pnpm --filter @byteql/web check:bundle
pnpm --filter @byteql/web test:e2e
```

Expected: every command exits 0 with pristine test output. If the million-row browser test exceeds
the existing 30-second timeout solely while draining 123 local pages, set a timeout on that test
only and record the observed duration in its annotation; do not weaken assertions.

- [ ] **Step 8: Commit acceptance proof**

```bash
git add apps/web/e2e apps/web/src/lib/e2e-harness.ts apps/web/src/App.svelte
git commit -m "test(web): prove million-row result reachability"
```

---

### Task 8: Final Contract Audit

**Files:** None unless a preceding task's named regression fails; return that failure to its
own task before editing.

**Interfaces:**

- Consumes: all preceding tasks.
- Produces: literal alignment between the approved spec, public types, UI copy, and verified
  behavior.
- [ ] **Step 1: Search for removed whole-result assumptions**

Run:

```bash
rg -n "QueryResult|database\.query|queryElapsedMs|result\.numRows|limit 10000" \
  packages/db/src apps/web/src apps/web/e2e
```

Expected: no old database query API, standalone elapsed field, paged-result `numRows` assumption,
or Browse limit remains. Intentional SQL inside user-facing saved queries is not changed.

- [ ] **Step 2: Audit scratch lifecycle and public copy**

Verify every `byteql-results` creation has replacement, cancellation, disposal, and startup-sweep
coverage. Search all row-count copy and confirm only completed results say `<N> rows`.

- [ ] **Step 3: Re-run the full gate after returning any failure to its owning task**

Run the Task 7 full release gate again. Every audit fix requires its own failing regression before
production edits and belongs in that task's commit, not in an unscoped cleanup commit.
