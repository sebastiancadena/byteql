// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionState } from './lib/session/state.js';

const { database, initialize, dispose, createBrowserDatabase, SessionController } = vi.hoisted(() => {
  const database = { marker: 'browser database' };
  const initialize = vi.fn<() => Promise<void>>();
  const dispose = vi.fn<() => Promise<void>>();
  const createBrowserDatabase = vi.fn(async () => database);
  const SessionController = vi.fn(function () {
    return {
      subscribe(listener: (state: SessionState) => void) {
        listener({
          phase: 'idle',
          source: null,
          format: null,
          progress: null,
          tables: [],
          issues: [],
          sql: '',
          result: null,
          queryElapsedMs: null,
          queryError: null,
          selectedRow: null,
          fatalError: null,
        });
        return () => undefined;
      },
      openFile: vi.fn(),
      openSample: vi.fn(),
      runQuery: vi.fn(),
      cancel: vi.fn(),
      selectResultRow: vi.fn(),
      initialize,
      dispose,
    };
  });
  return { database, initialize, dispose, createBrowserDatabase, SessionController };
});

vi.mock('@byteql/db', () => ({ createBrowserDatabase }));
vi.mock('./lib/session/controller.js', () => ({ SessionController }));

import App from './App.svelte';

describe('App lifecycle', () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    initialize.mockResolvedValue(undefined);
    dispose.mockResolvedValue(undefined);
  });

  it('creates the browser database, initializes one session controller, and disposes it on teardown', async () => {
    const view = render(App);

    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    expect(createBrowserDatabase).toHaveBeenCalledOnce();
    expect(SessionController).toHaveBeenCalledWith({ database });
    expect(screen.getByText(/files stay on this device/i)).toBeTruthy();

    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('shows a safe startup diagnostic when the database cannot be created', async () => {
    createBrowserDatabase.mockRejectedValueOnce(new Error('Database worker unavailable'));
    render(App);

    expect((await screen.findByRole('alert')).textContent).toContain('Database worker unavailable');
  });
});
