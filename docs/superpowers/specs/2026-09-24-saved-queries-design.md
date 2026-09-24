# Saved queries and opt-in local history

Date: 2026-09-24

Status: Approved design, not yet implemented.

## Purpose and accepted behavior

`ROADMAP.md` priority 4: make repeat investigations easier. The main job is **reuse across
sessions**: a personal library of queries the user reruns on new files of the same format in
later visits, in the same browser.

Accepted scope:

- **Named saved queries, scoped per format.** A query is saved under the format pack active when
  it is saved (`pcap`, `midi`, `zip`, …). The Explorer shows only the loaded format's saved
  queries, beside that pack's example queries. Saving is an explicit act, so saved queries
  persist without a separate opt-in.
- **Recent executions.** Every run is recorded in memory for the current tab. Persisting history
  across visits is **opt-in, off by default**, capped, and clearable.
- **SQL import and export** as one annotated `.sql` file per format library.
- **Explicit persistence controls**, because SQL can contain sensitive literals (IP addresses,
  host names, hashes).

Everything stays in the browser. There is no sync, no sharing beyond the exported file, and zero
network requests after readiness, as today.

Success criteria:

1. Save a query on capture A, reload the page, open capture B of the same format, pick the saved
   query, and run it.
2. Export a format's library, import it into a fresh browser profile, and get identical entries.
3. With history persistence off (the default), no executed SQL is written to browser storage.
   Turning persistence off deletes any stored history immediately.

Out of scope (YAGNI): folders or tags, parameterized queries, a search box over saved queries,
cross-device sync, editing SQL inside the saved list, and exporting history.

## Current evidence

Inspected at `91405f0`.

- "Example queries" in `apps/web/src/components/Explorer.svelte` render `session.queries`, the
  active pack's `queries.yaml` entries (`PackQuery` in `packages/core/src/protocol.ts`).
  Clicking one calls `loadQuery` in `Workbench.svelte`, which fills the editor and never runs it;
  `run(sql)` calls `controller.runQuery(sql)`.
- The only durable app state today is UI preferences in `localStorage`
  (`byteql.hexpane.collapsed` and the hex-pane keys), read through guarded accessors because the
  `localStorage` getter throws when site data is blocked (`apps/web/src/main.ts`).
- OPFS holds only transient data: spill Parquet (`byteql-spill/`), retained result pages
  (`byteql-results/`), and export staging (`byteql-exports/`).
- `docs/privacy.md` states that SQL text stays in the browser process. No SQL is persisted
  anywhere today, so this feature introduces the first durable copy of user SQL.
- Neither `fake-indexeddb` nor `fast-check` is a dependency of any workspace package.

## Approaches considered

- **Chosen — IndexedDB behind a `QueryStore` interface.** Async, structured, transactional, and
  shared by all same-origin tabs; it fits several small stores (saved, history, settings) and
  per-record writes, so two tabs never overwrite each other's whole list. Cost: a small wrapper
  and `fake-indexeddb` for Node unit tests.
- **Rejected — `localStorage` JSON blobs.** Synchronous, about 5 MB, throws when site data is
  blocked, and whole-list writes are last-writer-wins across tabs.
- **Rejected — an OPFS JSON file.** Matches the spill/export pattern, but small frequent writes
  and multi-tab coordination would need Web Locks for a few KB of data.

## Data model and store

New module `apps/web/src/lib/queries/`, with no Svelte imports, so it is unit-testable in Node.

`types.ts`:

```ts
interface SavedQuery {
  id: string; // crypto.randomUUID()
  format: string; // FormatPack id
  name: string; // not unique; single line
  sql: string;
  createdAt: number; // epoch ms
  updatedAt: number;
}

interface HistoryEntry {
  id: string;
  format: string;
  sql: string;
  ranAt: number;
  status: 'ok' | 'error';
  rowCount: number | null; // null on error or when unknown
}

interface QuerySettings {
  persistHistory: boolean; // default false
  historyLimit: number; // default 100, across all formats
}
```

`store.ts` defines `QueryStore`:

- `listSaved(format)`, `save(input)`, `update(id, patch)`, `delete(id)`, `restore(query)` (for
  undo after delete)
- `listHistory(format)`, `appendHistory(entry)`, `clearHistory()`
- `getSettings()`, `setSettings(patch)`
- `subscribe(listener)`: notified after local writes and after writes from other tabs

Implementations:

- **`IndexedDbQueryStore`**: database `byteql-queries`, version 1, object stores `saved`
  (keyPath `id`, index `format`), `history` (keyPath `id`, index `[format, ranAt]`), and
  `settings` (one record).
- **`MemoryQueryStore`**: backs unit tests, and is the runtime fallback when `indexedDB` is
  missing, `open` throws, or `open` fails (private windows or blocked site data). The UI shows
  the storage-unavailable notice in that case.

History rules:

- The tab always keeps an in-memory history. The IndexedDB `history` store is written **only
  while `persistHistory` is true**.
- On turning persistence on, the tab's current in-memory history is written through. On turning
  it off, the stored `history` store is cleared in the same operation. "Off" never means "hidden
  but still on disk".
- Each append trims to `historyLimit` across all formats, removing the oldest first.
- A run whose format and SQL match the newest entry for that format updates that entry's
  `ranAt`, `status`, and `rowCount` instead of adding a new entry.
- The entry is recorded by `Workbench` after `controller.runQuery` settles, from the SQL that
  actually executed and its outcome. `packages/db` and the session controller do not change.

Cross-tab: after each committed write the store posts `{ kind }` (no SQL) on
`BroadcastChannel('byteql-queries')`. Other tabs re-read the affected list and notify
subscribers. `BroadcastChannel` is same-origin and makes no network request.

Errors: a failed write (quota exceeded, aborted transaction) keeps the in-memory state, reports
"Couldn't save to browser storage" through the status live region, and never affects query
execution.

## UI (`apps/web`)

No new panels. The Trace Workspace layout and panel-resize contracts are unchanged.

Editor toolbar:

- A **Save query** button next to Run query, disabled while the editor is empty or
  whitespace-only.
- It opens an inline popover with a name field, Save, and Cancel. The default name is the first
  non-comment line of the SQL, truncated to 60 characters. Enter saves, Escape cancels, and focus
  returns to the editor.
- If the editor was last loaded from a saved query of the current format and its SQL has since
  changed, the popover offers **Update "‹name›"** (the default) and **Save as new**. If the SQL is
  unchanged, Save is disabled with "Already saved".
- `Ctrl/⌘+S` opens the popover while the editor has focus, overriding the browser's save-page
  action. It gets an entry in the shortcuts overlay.
- Saving never runs the query.

Explorer, **Saved queries** section (above "Example queries"):

- Shown whenever a file is loaded, scoped to the loaded format.
- Empty state: "Save a query to keep it for later visits." plus an Import action.
- Clicking a row loads it into the editor without running it, through the same `loadQuery` path
  (and `loadQueryFromCatalog` in drawer mode).
- Each row has a `⋯` menu with Rename (inline), Copy SQL, and Delete. Delete shows "Deleted
  ‹name› — Undo" in the status bar for a few seconds instead of a confirmation dialog.
- The section header has **Import** and **Export** actions for the loaded format's library.
- Storage-unavailable notice: "This browser is blocking storage — queries last until the tab
  closes." Saving still works in memory.

Explorer, **Recent** section (below Saved, a `<details>` collapsed by default):

- The loaded format's history, newest first. Each entry shows a one-line SQL preview, relative
  time, and ok or error with the row count. Clicking an entry loads it without running it, and a
  row action saves it as a named query (it opens the same popover).
- Footer: a checkbox **"Keep history after this tab closes"** with the helper text "Stored only in
  this browser. SQL may contain sensitive values.", and **Clear history**, which clears both the
  in-memory and stored history for all formats. Unchecking asks nothing and deletes the stored
  history immediately.

Accessibility: row menus and the popover are keyboard operable. Status messages use the existing
polite live region. The popover traps focus while it is open.

## Import and export

`lib/queries/sql-file.ts` holds pure `serializeQueryFile(format, queries)` and
`parseQueryFile(text, fallbackName)`.

File format:

```sql
-- byteql-queries v1
-- format: pcap

-- name: Top talkers
select src, count(*) from ip
group by 1 order by 2 desc;

-- name: TLS SNI list
select distinct sni from tls;
```

- **Export** writes `byteql-<format>-queries.sql` with the loaded format's saved queries in
  `createdAt` order. Newlines are stripped from names. A line inside a query's SQL that would read
  as a marker (`-- name:` or `-- format:` after optional whitespace) is escaped as `--\ name:` /
  `--\ format:`, and the parser reverses the escape. Delivery reuses the existing download path
  (a save handle when available, otherwise a Blob object URL). History is never exported.
- **Import** accepts one picked `.sql` file of at most 1 MiB, decoded as UTF-8 with
  `fatal: true`.
  - Blocks split on `-- name:` lines. A file with no markers becomes one query named after the
    file (without the extension).
  - A `-- format:` that differs from the loaded format warns ("These queries were saved for pcap.
    Import them into midi anyway?") and does not block.
  - Queries go into the loaded format. A block with the same name and the same SQL (after
    trimming) as an existing saved query is skipped. Everything else is added, never overwritten.
  - Empty blocks and blocks over 64 KiB of SQL are rejected per block. Non-UTF-8 input or an
    oversized file rejects the whole file, before parsing.
  - The result is reported in the status bar, for example "Imported 7 queries, skipped 2
    duplicates, rejected 1".
  - Import never runs anything.

## Privacy

`docs/privacy.md` gains a **Local query storage** section covering:

- what is stored and where (the `byteql-queries` IndexedDB database: saved queries, settings, and
  history only when opted in);
- that it is never sent anywhere;
- that history persists only while "Keep history after this tab closes" is on, and that turning
  it off deletes what was stored;
- how to remove it (Clear history, deleting saved queries, or clearing site data), and that
  export is the only backup.

`check:bundle` and `apps/web/e2e/privacy.spec.ts` stay authoritative. The privacy e2e gains save,
reload, history opt-in, export, and import steps under the post-readiness request listener, with
the SQL sentinel checked against every recorded request.

## Testing and evidence

- **Unit (vitest, Node):**
  - One shared `QueryStore` contract suite run against `MemoryQueryStore` and
    `IndexedDbQueryStore` (`fake-indexeddb`, a new dev dependency of `@byteql/web`).
  - History: trimming across formats, consecutive-duplicate collapse, no IndexedDB history writes
    while persistence is off, and stored history deleted when it is turned off.
  - Fallback: `indexedDB.open` failure yields the memory store and the unavailable flag.
  - `sql-file`: parse and serialize cases (no markers, format mismatch, empty and oversized
    blocks, CRLF input, marker-like lines inside SQL) plus a seeded round-trip test over generated
    names and SQL. There is no `fast-check` dependency.
- **Component (vitest + Testing Library):** the Save popover (default name, update versus save as
  new, disabled states, `Ctrl/⌘+S`), Saved and Recent scoped by format, load-without-run,
  delete-with-undo, and the storage-unavailable notice. This extends
  `Workbench.test.ts`/`Explorer.test.ts`.
- **e2e (`apps/web/e2e/saved-queries.spec.ts`, Chromium):**
  - Save on one pcap, reload, open a different pcap, load and run the saved query.
  - Opt into history, reload, and history is present. Opt out, and the IndexedDB `history` store
    is empty.
  - Export, then import into a fresh browser context, and the entries are identical.

## Documentation on completion

Update `CHANGELOG.md`, the `ROADMAP.md` item 4 status, the `AGENTS.md` status list, and
`docs/privacy.md` (as above), and add this spec's "Implementation notes".
