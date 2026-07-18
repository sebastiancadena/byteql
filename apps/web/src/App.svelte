<script lang="ts">
  import { createBrowserDatabase, type ByteqlDatabase } from '@byteql/db';
  import { onMount } from 'svelte';

  import Workbench from './components/Workbench.svelte';
  import { SessionController } from './lib/session/controller.js';

  const queries = [
    {
      id: 'overview',
      title: 'Table overview',
      sql: `select 'header' as table_name, count(*) as row_count from header
union all select 'events', count(*) from events
union all select 'tempo', count(*) from tempo
union all select 'errors', count(*) from errors
order by table_name
limit 100;`,
    },
    {
      id: 'records',
      title: 'Source records',
      sql: 'select * from events order by event_id limit 1000;',
    },
    {
      id: 'diagnostics',
      title: 'Parse diagnostics',
      sql: 'select * from errors order by error_id limit 100;',
    },
  ] as const;

  let controller = $state<SessionController | null>(null);
  let startupError = $state<string | null>(null);

  onMount(() => {
    let disposed = false;
    let database: ByteqlDatabase | null = null;
    let ownedController: SessionController | null = null;

    void (async () => {
      try {
        database = await createBrowserDatabase();
        if (disposed) {
          await database.dispose();
          return;
        }

        ownedController = new SessionController({ database });
        controller = ownedController;
        await ownedController.initialize();
      } catch (error) {
        if (!disposed) {
          startupError =
            error instanceof Error && error.message
              ? error.message
              : 'The local query engine could not be started.';
        }
      }
    })();

    return () => {
      disposed = true;
      controller = null;
      if (ownedController) void ownedController.dispose();
    };
  });
</script>

{#if controller}
  <Workbench {controller} {queries} />
  {#if startupError}
    <div class="startup-diagnostic" role="alert">{startupError}</div>
  {/if}
{:else}
  <main class="startup-state" aria-busy={!startupError}>
    <div class="startup-card">
      <span class="startup-mark" aria-hidden="true">⌁</span>
      <h1>ByteQL</h1>
      {#if startupError}
        <p class="inline-diagnostic" role="alert">{startupError}</p>
      {:else}
        <p>Starting the local inspector…</p>
      {/if}
    </div>
  </main>
{/if}
