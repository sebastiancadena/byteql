<script lang="ts">
  /* global __BYTEQL_E2E__ */

  import { createBrowserDatabase, type ByteqlDatabase } from '@byteql/db';
  import { onMount } from 'svelte';

  import BrandMark from './components/BrandMark.svelte';
  import Workbench from './components/Workbench.svelte';
  import { createBrowserE2EHarness } from './lib/e2e-harness.js';
  import { SessionController } from './lib/session/controller.js';

  const e2eHarness = __BYTEQL_E2E__ ? createBrowserE2EHarness() : null;
  if (e2eHarness) globalThis.__byteqlE2E = e2eHarness.control;

  let controller = $state<SessionController | null>(null);
  let startupError = $state<string | null>(null);
  let starting = $state(true);
  let retryStartup = $state<() => void>(() => undefined);
  let workbench = $state<ReturnType<typeof Workbench> | null>(null);

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
        await ownedController.initialize();
        if (disposed || attempt !== generation || currentController !== ownedController) return;

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
    };
  });
</script>

{#if controller}
  <div data-app-ready="true">
    <Workbench bind:this={workbench} {controller} audioEngineFactory={e2eHarness?.audioEngineFactory} />
  </div>
{:else}
  <main class="startup-state" aria-busy={starting}>
    <div class="startup-card">
      <BrandMark size="large" />
      <p class="startup-kicker">Browser-native binary intelligence</p>
      <h1>ByteQL</h1>
      {#if startupError}
        <p class="inline-diagnostic" role="alert">{startupError}</p>
        <button class="button button-primary" type="button" onclick={retryStartup}> Retry startup </button>
      {:else}
        <p>Starting the local inspector…</p>
      {/if}
    </div>
  </main>
{/if}
