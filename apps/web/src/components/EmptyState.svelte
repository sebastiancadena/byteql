<script lang="ts">
  /* global DOMException, DragEvent, Event, File, HTMLInputElement, window */

  import BrandMark from './BrandMark.svelte';

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

  const filePickerSupported = 'showOpenFilePicker' in window;

  function browseFiles(): void {
    if (!window.showOpenFilePicker) return;
    window
      .showOpenFilePicker()
      .then(([handle]) => {
        if (!handle) throw new DOMException('No file was selected.', 'AbortError');
        return handle.getFile();
      })
      .then(onopen)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        throw err;
      });
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
  <div class="empty-hero-copy">
    <BrandMark size="medium" />
    <p class="eyebrow">Browser-native binary intelligence</p>
    <h1 id="empty-title">Query the file. <span>Prove the answer.</span></h1>
    <p class="empty-copy">
      Turn local binary files into queryable tables, then trace every result back to its exact source
      bytes. Files never leave this browser.
    </p>
    <ul class="format-badges" aria-label="Supported formats">
      <li>MIDI</li>
      <li>pcap</li>
    </ul>
  </div>

  <div class="empty-intake">
    <p class="empty-intake-label">Start a local investigation</p>
    <div class="empty-actions">
      <label class="button button-primary">
        Open file
        <input type="file" aria-label="Open file" disabled={busy} onchange={chooseFile} />
      </label>
      <button class="button button-secondary" type="button" disabled={busy} onclick={onsample}>
        Try sample
      </button>
      {#if filePickerSupported}
        <button class="button button-secondary" type="button" disabled={busy} onclick={browseFiles}>
          Browse files
        </button>
      {/if}
    </div>
    <p class="drop-hint">Drop a binary file anywhere in this panel</p>
  </div>

  <div class="empty-proof-grid" aria-label="Privacy guarantees">
    <div>
      <strong>No upload. No server.</strong><span>Parsing, storage, and SQL stay on this device.</span>
    </div>
    <div>
      <strong>Source-linked evidence.</strong><span>Every projected row retains its byte range.</span>
    </div>
  </div>
  {#if error}
    <p class="inline-diagnostic" role="alert">{error}</p>
  {/if}
</section>
