// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QueryLibrary } from '../lib/queries/library.js';
import { MemoryQueryStore } from '../lib/queries/store.js';
import QueryLibraryPanel from './QueryLibraryPanel.svelte';

async function setup(format = 'pcap') {
  const library = await QueryLibrary.open(new MemoryQueryStore());
  const props = { library, format, onload: vi.fn(), onsaverecent: vi.fn(), onnotice: vi.fn() };
  return { library, props };
}

describe('QueryLibraryPanel', () => {
  afterEach(() => cleanup());

  it('shows the empty state and the storage notice for a non-persistent library', async () => {
    const { props } = await setup();
    render(QueryLibraryPanel, props);
    const saved = screen.getByRole('region', { name: 'Saved queries' });
    expect(within(saved).getByText('Save a query to keep it for later visits.')).toBeTruthy();
    expect(
      within(saved).getByText('This browser is blocking storage — queries last until the tab closes.'),
    ).toBeTruthy();
  });

  it('lists only the current format and loads a query without running it', async () => {
    const { library, props } = await setup();
    const kept = library.save({ format: 'pcap', name: 'Talkers', sql: 'select 1' });
    library.save({ format: 'midi', name: 'Notes', sql: 'select 2' });
    render(QueryLibraryPanel, props);

    expect(screen.queryByRole('button', { name: 'Notes' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Talkers' }));
    expect(props.onload).toHaveBeenCalledWith('select 1', kept);
  });

  it('updates when the library changes', async () => {
    const { library, props } = await setup();
    render(QueryLibraryPanel, props);
    library.save({ format: 'pcap', name: 'Later', sql: 'select 1' });
    expect(await screen.findByRole('button', { name: 'Later' })).toBeTruthy();
  });

  it('renames inline from the row menu', async () => {
    const { library, props } = await setup();
    library.save({ format: 'pcap', name: 'Old', sql: 'select 1' });
    render(QueryLibraryPanel, props);

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Old' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByLabelText('Rename Old');
    await fireEvent.input(field, { target: { value: 'New' } });
    await fireEvent.keyDown(field, { key: 'Enter' });

    expect(library.savedFor('pcap').map((query) => query.name)).toEqual(['New']);
  });

  it('deletes with an undo notice', async () => {
    const { library, props } = await setup();
    library.save({ format: 'pcap', name: 'Gone', sql: 'select 1' });
    render(QueryLibraryPanel, props);

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Gone' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(library.savedFor('pcap')).toEqual([]);
    const notice = props.onnotice.mock.calls[0]![0];
    expect(notice.message).toBe('Deleted Gone');
    notice.undo();
    expect(library.savedFor('pcap').map((query) => query.name)).toEqual(['Gone']);
  });

  it('copies SQL to the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { library, props } = await setup();
    library.save({ format: 'pcap', name: 'Copy me', sql: 'select 7' });
    render(QueryLibraryPanel, props);

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Copy me' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Copy SQL' }));
    expect(writeText).toHaveBeenCalledWith('select 7');
    vi.unstubAllGlobals();
  });

  it('lists recent runs for this format, loads them, and saves them', async () => {
    const { library, props } = await setup();
    library.recordRun({ format: 'pcap', sql: 'select 1\nfrom ip', status: 'ok', rowCount: 3 });
    library.recordRun({ format: 'midi', sql: 'select 9', status: 'ok', rowCount: 1 });
    render(QueryLibraryPanel, props);

    const recent = screen.getByRole('region', { name: 'Recent' });
    expect(within(recent).getByText('select 1 …')).toBeTruthy();
    expect(within(recent).getByText(/3 rows/u)).toBeTruthy();
    expect(within(recent).queryByText('select 9')).toBeNull();
    // Anchored: the Save button's accessible name ("Save select 1 …") also contains "select 1",
    // so an unanchored /select 1/ matches both buttons. Anchoring to the start picks only the
    // row button, which is what this click needs to hit.
    await fireEvent.click(within(recent).getByRole('button', { name: /^select 1/u }));
    expect(props.onload).toHaveBeenCalledWith('select 1\nfrom ip', null);
    await fireEvent.click(within(recent).getByRole('button', { name: 'Save select 1 …' }));
    expect(props.onsaverecent).toHaveBeenCalledWith('select 1\nfrom ip');
  });

  it('toggles history persistence and clears history', async () => {
    const { library, props } = await setup();
    library.recordRun({ format: 'pcap', sql: 'select 1', status: 'ok', rowCount: 1 });
    render(QueryLibraryPanel, props);

    const keep = screen.getByRole('checkbox', {
      name: 'Keep history after this tab closes',
    }) as HTMLInputElement;
    expect(keep.checked).toBe(false);
    await fireEvent.click(keep);
    expect(library.settings.persistHistory).toBe(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    expect(library.historyFor('pcap')).toEqual([]);
  });
});
