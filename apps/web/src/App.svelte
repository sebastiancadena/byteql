<script lang="ts">
  /* global __BYTEQL_E2E__ */

  import { createBrowserDatabase, type ByteqlDatabase } from '@byteql/db';
  import { onMount } from 'svelte';

  import BrandLockup from './components/BrandLockup.svelte';
  import Workbench from './components/Workbench.svelte';
  import { createBrowserE2EHarness } from './lib/e2e-harness.js';
  import type { QueryLibrary } from './lib/queries/library.js';
  import { openQueryLibrary } from './lib/queries/library.js';
  import { SessionController } from './lib/session/controller.js';
  import { prepareUiFonts } from './lib/ui/fonts.js';

  const e2eHarness = __BYTEQL_E2E__ ? createBrowserE2EHarness() : null;
  if (e2eHarness) {
    globalThis.__byteqlE2E = e2eHarness.control;
    globalThis.window.__BYTEQL_E2E__ = e2eHarness.control;
  }

  let controller = $state<SessionController | null>(null);
  let startupError = $state<string | null>(null);
  let starting = $state(true);
  let retryStartup = $state<() => void>(() => undefined);
  let workbench = $state<ReturnType<typeof Workbench> | null>(null);
  let queryLibrary = $state<QueryLibrary | null>(null);

  onMount(() => {
    let disposed = false;
    let generation = 0;
    let currentController: SessionController | null = null;

    const start = async (): Promise<void> => {
      const attempt = ++generation;
      let database: ByteqlDatabase | null = null;
      let ownedController: SessionController | null = null;
      startupError = null;
      starting = true;
      controller = null;
      // Fonts load beside the engine, never after it. The loader memoizes, so a retry reuses the
      // settled result rather than re-requesting the faces.
      const fontsReady = prepareUiFonts();
      // Started once, beside the engine and the fonts; `openQueryLibrary` never rejects, so this
      // never needs its own error handling. A retry reuses whatever the first attempt opened.
      const libraryReady = queryLibrary ? Promise.resolve(queryLibrary) : openQueryLibrary();
      try {
        database = await createBrowserDatabase();
        if (disposed || attempt !== generation) {
          await database.dispose();
          return;
        }
        e2eHarness?.attachDatabase(database);

        const stopViewer = (): void => workbench?.closeActiveViewer();
        ownedController = new SessionController(
          e2eHarness
            ? {
                database,
                parser: e2eHarness.createParser(),
                stopViewer,
                ...e2eHarness.control.sessionOverrides,
              }
            : { database, stopViewer },
        );
        currentController = ownedController;
        e2eHarness?.attachQueryController(ownedController);
        await ownedController.initialize();
        // Readiness means the whole interface is ready: no font request may outlive this marker.
        await fontsReady;
        const library = await libraryReady;
        if (disposed || attempt !== generation || currentController !== ownedController) return;

        queryLibrary = library;
        controller = ownedController;
        starting = false;
      } catch (error) {
        if (ownedController && currentController === ownedController) {
          currentController = null;
          try {
            await ownedController.dispose();
          } catch {
            // Preserve the startup error; disposal is best effort after failed initialization.
          }
        } else if (database && !ownedController) {
          try {
            await database.dispose();
          } catch {
            // Preserve the startup error; disposal is best effort after failed construction.
          }
        }
        if (disposed || attempt !== generation) return;

        starting = false;
        startupError =
          error instanceof Error && error.message
            ? error.message
            : 'The local query engine could not be started.';
      }
    };

    retryStartup = () => void start();
    void start();

    return () => {
      disposed = true;
      generation += 1;
      controller = null;
      const ownedController = currentController;
      currentController = null;
      if (ownedController) void ownedController.dispose();
      queryLibrary?.dispose();
    };
  });
</script>

{#if controller}
  <div data-app-ready="true">
    <Workbench
      bind:this={workbench}
      {controller}
      {queryLibrary}
      audioEngineFactory={e2eHarness?.audioEngineFactory}
    />
  </div>
{:else}
  <main class="startup-state" aria-busy={starting}>
    <div class="startup-card">
      <BrandLockup />
      <h1 class="visually-hidden">ByteQL</h1>
      {#if startupError}
        <p class="inline-diagnostic" role="alert">{startupError}</p>
        <button class="button button-primary" type="button" onclick={retryStartup}> Retry startup </button>
      {:else}
        <p>Starting the local query engine…</p>
      {/if}
    </div>
  </main>
{/if}
