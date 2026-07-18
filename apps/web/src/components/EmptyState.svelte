<script lang="ts">
  /* global DragEvent, Event, File, HTMLInputElement */

  interface Props {
    busy?: boolean;
    error?: string | null;
    onopen: (file: File) => void;
    onsample: () => void;
  }

  let { busy = false, error = null, onopen, onsample }: Props = $props();
  let dragging = $state(false);

  function chooseFile(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) onopen(file);
    input.value = '';
  }

  function dropFile(event: DragEvent): void {
    event.preventDefault();
    dragging = false;
    const file = event.dataTransfer?.files[0];
    if (file) onopen(file);
  }
</script>

<section
  class:dragging
  class="empty-state"
  aria-labelledby="empty-title"
  ondragenter={(event) => {
    event.preventDefault();
    dragging = true;
  }}
  ondragover={(event) => event.preventDefault()}
  ondragleave={() => (dragging = false)}
  ondrop={dropFile}
>
  <div class="empty-mark" aria-hidden="true">⌁</div>
  <p class="eyebrow">Private by design</p>
  <h1 id="empty-title">Inspect structured data at its source</h1>
  <p class="empty-copy">
    Open a local file to explore its generated tables with SQL. Files stay on this device and are processed
    inside your browser.
  </p>

  <div class="empty-actions">
    <label class="button button-primary">
      Open file
      <input type="file" aria-label="Open file" disabled={busy} onchange={chooseFile} />
    </label>
    <button class="button button-secondary" type="button" disabled={busy} onclick={onsample}>
      Try sample
    </button>
  </div>
  <p class="drop-hint">or drop a file anywhere in this panel</p>
  {#if error}
    <p class="inline-diagnostic" role="alert">{error}</p>
  {/if}
</section>
