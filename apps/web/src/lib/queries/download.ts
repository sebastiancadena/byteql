interface SaveHandle {
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveHandle>;

/** Object URLs outlive the click, so the browser can finish the download before revocation. */
const REVOKE_AFTER_MS = 60_000;

/** Saves a small text file locally: a save handle when available, otherwise a download link. */
export async function saveTextFile(filename: string, text: string): Promise<'saved' | 'cancelled'> {
  const picker = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [{ description: 'SQL queries', accept: { 'text/plain': ['.sql'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return 'saved';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
      throw error;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  return 'saved';
}
