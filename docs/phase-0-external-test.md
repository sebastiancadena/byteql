# ByteQL Phase 0 external test

## Current result

The automated Chromium acceptance suite covers the sample open-query-inspect loop, local fixture
upload, malformed-track partial recovery, query diagnostics, parser-worker crash recreation, audio
capability load/disposal, post-readiness privacy, and benchmark reporting.

**Manual audible smoke: pending.** This implementation run was headless and no human listened to its
audio output. The automated test proves that a compatible query opens the audio viewer and that the
trusted engine boundary receives rows and is disposed when closed; it does not prove audible sound.

**Unaided external test: pending.** A person who did not build ByteQL has not yet executed the script
below. Do not declare Phase 0 externally reproduced until the result block is completed by that
tester.

## Release-owner setup

1. Run a normal `pnpm build` and `pnpm --filter @byteql/web check:bundle`, then publish only the
   contents of `apps/web/dist` at one HTTPS URL with no authentication or developer tooling required.
   Never publish the instrumented `apps/web/dist-e2e` acceptance directory.
2. Send only that URL and this checklist to the tester. Do not demonstrate the product first.
3. Ask the tester to use a desktop Chromium browser with audio output enabled.

## Unaided tester script

1. Open the supplied URL in a new incognito Chromium window.
2. Confirm the empty screen says files stay on the device and offers `Open file` and `Try sample`.
3. Click `Try sample`. Confirm the Explorer shows `demo.mid`, four tables, and no parse diagnostic.
4. Confirm an overview result appears without entering SQL.
5. Replace the editor contents with `select * from events limit 5`, click `Run query`, and confirm the
   result reports five rows.
6. Select the first result row. Confirm the Inspector shows `Provenance`, `_src_start`, and
   `_src_end` values without changing the SQL editor.
7. Click the saved query `Play all notes`, then `Run query`. Confirm the result contains `seconds`,
   `note`, `velocity`, and `kind` columns.
8. Open `Open in…`, choose `Audio playback`, then click `Play`. Confirm notes are actually audible.
   Browser audio permission may require allowing sound for the site.
9. Close the audio viewer while it is playing and confirm sound stops immediately.
10. Click `Low notes`, run it, reopen Audio playback, and click Play. Confirm the scheduled-row count
    changes and the audible selection is smaller/lower than the all-notes query.
11. Reload the page, disconnect the machine from the network only after the empty screen is ready,
    and repeat steps 3–9. Confirm the sample, query, inspection, and playback still operate.
12. Record the exact browser version, OS, machine, URL, UTC time, and any confusing step below.

## Manual result record

```text
Tester:
UTC date/time:
Published URL and release identifier:
Browser version:
OS and machine:
Open-query-inspect: PASS / FAIL
Audible all-notes playback: PASS / FAIL
Predicate changed scheduled/audible notes: PASS / FAIL
Closing viewer stopped sound: PASS / FAIL
Post-readiness offline repeat: PASS / FAIL
Unaided completion: PASS / FAIL
Notes:
```

Any failed or ambiguous item remains a Phase 0 acceptance limitation until reproduced, diagnosed,
and rerun. A UI animation or a changing timer is not evidence of audible playback.
