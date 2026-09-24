// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QueryLibrary } from '../lib/queries/library.js';
import { MemoryQueryStore } from '../lib/queries/store.js';
import SaveQueryPopover from './SaveQueryPopover.svelte';

const openLibrary = () => QueryLibrary.open(new MemoryQueryStore());

describe('SaveQueryPopover', () => {
  afterEach(() => cleanup());

  it('saves a new query under a default name taken from the SQL', async () => {
    const library = await openLibrary();
    const onsaved = vi.fn();
    render(SaveQueryPopover, {
      library,
      format: 'pcap',
      sql: '-- note\nselect src from ip',
      loaded: null,
      onsaved,
      onclose: vi.fn(),
    });

    const name = screen.getByLabelText('Query name') as HTMLInputElement;
    expect(name.value).toBe('select src from ip');
    await fireEvent.input(name, { target: { value: 'Sources' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(library.savedFor('pcap').map((query) => query.name)).toEqual(['Sources']);
    expect(onsaved).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sources' }));
  });

  it('saves on Enter and closes on Escape', async () => {
    const library = await openLibrary();
    const onclose = vi.fn();
    render(SaveQueryPopover, {
      library,
      format: 'pcap',
      sql: 'select 1',
      loaded: null,
      onsaved: vi.fn(),
      onclose,
    });
    const name = screen.getByLabelText('Query name');
    await fireEvent.keyDown(name, { key: 'Enter' });
    expect(library.savedFor('pcap')).toHaveLength(1);
    await fireEvent.keyDown(name, { key: 'Escape' });
    expect(onclose).toHaveBeenCalled();
  });

  it('offers Update and Save as new when the loaded query has changed', async () => {
    const library = await openLibrary();
    const loaded = library.save({ format: 'pcap', name: 'Talkers', sql: 'select 1' });
    render(SaveQueryPopover, {
      library,
      format: 'pcap',
      sql: 'select 2',
      loaded,
      onsaved: vi.fn(),
      onclose: vi.fn(),
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Update "Talkers"' }));
    expect(library.savedFor('pcap')).toEqual([expect.objectContaining({ id: loaded.id, sql: 'select 2' })]);
  });

  it('saves a copy with Save as new', async () => {
    const library = await openLibrary();
    const loaded = library.save({ format: 'pcap', name: 'Talkers', sql: 'select 1' });
    render(SaveQueryPopover, {
      library,
      format: 'pcap',
      sql: 'select 2',
      loaded,
      onsaved: vi.fn(),
      onclose: vi.fn(),
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Save as new' }));
    expect(library.savedFor('pcap').map((query) => query.sql)).toEqual(['select 1', 'select 2']);
  });

  it('disables saving when the loaded query is unchanged', async () => {
    const library = await openLibrary();
    const loaded = library.save({ format: 'pcap', name: 'Talkers', sql: 'select 1' });
    render(SaveQueryPopover, {
      library,
      format: 'pcap',
      sql: 'select 1',
      loaded,
      onsaved: vi.fn(),
      onclose: vi.fn(),
    });

    expect((screen.getByRole('button', { name: 'Already saved' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves as new when the loaded query was deleted elsewhere', async () => {
    const library = await openLibrary();
    const loaded = library.save({ format: 'pcap', name: 'Talkers', sql: 'select 1' });
    library.remove(loaded.id);
    render(SaveQueryPopover, {
      library,
      format: 'pcap',
      sql: 'select 2',
      loaded,
      onsaved: vi.fn(),
      onclose: vi.fn(),
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Update "Talkers"' }));
    expect(library.savedFor('pcap')).toEqual([expect.objectContaining({ name: 'Talkers', sql: 'select 2' })]);
  });
});
