<script lang="ts">
  /* global DOMException, DragEvent, Event, File, HTMLInputElement, window */

  import { SAMPLES, type SampleId } from '../lib/session/samples.js';
  import BrandLockup from './BrandLockup.svelte';
  import SampleMenu from './SampleMenu.svelte';

  interface Props {
    busy?: boolean;
    error?: string | null;
    onopen: (files: File[]) => void;
    onsample: (id: SampleId) => void;
  }

  let { busy = false, error = null, onopen, onsample }: Props = $props();
  let dragging = $state(false);
  let input = $state<HTMLInputElement>();
  let pickerError = $state<string | null>(null);

  /**
   * The one file action. The native picker must be called straight from the user gesture — an
   * `await` before it costs the transient activation the browser requires — so this is not async.
   * Exported so the Mod+O shortcut reaches the same path while the session is still idle.
   */
  export function openFile(): void {
    if (busy) return;
    pickerError = null;
    if (!window.showOpenFilePicker) {
      input?.click();
      return;
    }
    void window
      .showOpenFilePicker({ multiple: true })
      .then((handles) => Promise.all(handles.map((handle) => handle.getFile())))
      .then((files) => {
        if (files.length) onopen(files);
      })
      .catch((error: unknown) => {
        // Dismissing the picker is a normal outcome, not a failure worth reporting.
        if (error instanceof DOMException && error.name === 'AbortError') return;
        pickerError = error instanceof Error ? error.message : 'The file picker could not open.';
      });
  }

  function chooseFile(event: Event): void {
    const element = event.currentTarget as HTMLInputElement;
    const files = Array.from(element.files ?? []);
    if (files.length > 0) onopen(files);
    element.value = '';
  }

  function dropFile(event: DragEvent): void {
    event.preventDefault();
    dragging = false;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) onopen(files);
  }
</script>

<section
  class:dragging
  class="intake"
  aria-labelledby="intake-title"
  ondragenter={(event) => {
    event.preventDefault();
    dragging = true;
  }}
  ondragover={(event) => event.preventDefault()}
  ondragleave={() => (dragging = false)}
  ondrop={dropFile}
>
  <div class="intake-lede">
    <BrandLockup />
    <div>
      <h1 id="intake-title">Open a binary file.</h1>
      <p class="intake-copy">Query its tables with SQL. Select a row to inspect its source bytes.</p>
    </div>
  </div>

  <div class="intake-columns">
    <div class="intake-open">
      <button class="button button-primary" type="button" disabled={busy} onclick={openFile}>
        Open file
      </button>
      <dl class="intake-facts">
        <div>
          <dt>Formats</dt>
          <dd>MIDI, pcap/pcapng, ZIP</dd>
        </div>
      </dl>
      <p class="drop-hint">Drop MIDI, pcap/pcapng, or ZIP files anywhere to open.</p>
      <p class="intake-privacy">Files are processed in this browser. Nothing is uploaded.</p>
      {#if pickerError}
        <p class="inline-diagnostic" role="alert">{pickerError}</p>
        <button class="button button-secondary" type="button" onclick={() => input?.click()}>
          Use file input
        </button>
      {/if}
    </div>

    <div class="intake-samples">
      <h2>Explore a sample</h2>
      <ul class="sample-list">
        {#each SAMPLES as sample (sample.id)}
          <li>
            <strong>{sample.label}</strong>
            <span>{sample.description}</span>
          </li>
        {/each}
      </ul>
      <SampleMenu {busy} onselect={onsample} />
    </div>
  </div>

  <!-- Kept attached for drag-and-drop, automation and the picker fallback; never a second
       competing affordance, so it stays out of the visual flow. -->
  <input
    bind:this={input}
    class="visually-hidden"
    type="file"
    aria-label="Open file input"
    multiple
    disabled={busy}
    onchange={chooseFile}
  />

  {#if error}
    <p class="inline-diagnostic" role="alert">{error}</p>
  {/if}
</section>
