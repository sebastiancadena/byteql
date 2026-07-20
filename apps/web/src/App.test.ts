// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionState } from './lib/session/state.js';

const { database, databaseDispose, initialize, dispose, createBrowserDatabase, SessionController } =
  vi.hoisted(() => {
    const databaseDispose = vi.fn<() => Promise<void>>();
    const database = { marker: 'browser database', dispose: databaseDispose };
    const initialize = vi.fn<() => Promise<void>>();
    const dispose = vi.fn<() => Promise<void>>();
    const createBrowserDatabase = vi.fn(async () => database);
    const SessionController = vi.fn(function (options: { stopViewer?: () => void }) {
      void options;
      return {
        subscribe(listener: (state: SessionState) => void) {
          listener({
            phase: 'idle',
            source: null,
            format: null,
            progress: null,
            openStartedAt: null,
            tables: [],
            issues: [],
            queries: [],
            capabilities: null,
            sql: '',
            result: null,
            queryElapsedMs: null,
            queryError: null,
            selectedRow: null,
            fatalError: null,
            byteSelection: null,
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
    return { database, databaseDispose, initialize, dispose, createBrowserDatabase, SessionController };
  });

vi.mock('@byteql/db', () => ({ createBrowserDatabase }));
vi.mock('./lib/session/controller.js', () => ({ SessionController }));

import App from './App.svelte';

describe('App lifecycle', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    initialize.mockResolvedValue(undefined);
    dispose.mockResolvedValue(undefined);
    databaseDispose.mockResolvedValue(undefined);
  });

  it('does not publish a ready Workbench until controller initialization resolves', async () => {
    let resolveInitialization!: () => void;
    initialize.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveInitialization = resolve;
      }),
    );
    const view = render(App);

    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    expect(createBrowserDatabase).toHaveBeenCalledOnce();
    expect(SessionController).toHaveBeenCalledWith({ database, stopViewer: expect.any(Function) });
    expect(screen.getByText('Browser-native binary intelligence')).toBeTruthy();
    expect(view.container.querySelector('[data-brand-lockup] img')).toBeTruthy();
    expect(screen.queryByText(/files never leave this browser/i)).toBeNull();
    expect(view.container.querySelector('[data-app-ready="true"]')).toBeNull();

    resolveInitialization();
    expect(await screen.findByText(/files never leave this browser/i)).toBeTruthy();
    expect(view.container.querySelector('[data-app-ready="true"]')).not.toBeNull();

    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('constructs the controller with a stopViewer callback that is safe before the Workbench mounts', async () => {
    let resolveInitialization!: () => void;
    initialize.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveInitialization = resolve;
      }),
    );
    render(App);
    await vi.waitFor(() => expect(SessionController).toHaveBeenCalledOnce());

    const stopViewer = SessionController.mock.calls[0]?.[0]?.stopViewer;
    expect(stopViewer).toBeTypeOf('function');
    expect(() => stopViewer!()).not.toThrow();

    resolveInitialization();
    expect(await screen.findByText(/files never leave this browser/i)).toBeTruthy();
    expect(() => stopViewer!()).not.toThrow();
  });

  it('disposes an initializing controller when the app unmounts', async () => {
    let resolveInitialization!: () => void;
    initialize.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveInitialization = resolve;
      }),
    );
    const view = render(App);
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());

    view.unmount();
    resolveInitialization();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });

  it('cleans up after initialization failure and retries without exposing the Workbench', async () => {
    initialize.mockRejectedValueOnce(new Error('WASM startup failed'));
    const view = render(App);

    expect((await screen.findByRole('alert')).textContent).toContain('WASM startup failed');
    expect(dispose).toHaveBeenCalledOnce();
    expect(view.container.querySelector('[data-app-ready="true"]')).toBeNull();
    expect(screen.queryByText(/files never leave this browser/i)).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: /retry startup/i }));
    expect(await screen.findByText(/files never leave this browser/i)).toBeTruthy();
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector('[data-app-ready="true"]')).not.toBeNull();
  });

  it('shows a safe startup diagnostic when the database cannot be created', async () => {
    createBrowserDatabase.mockRejectedValueOnce(new Error('Database worker unavailable'));
    render(App);

    expect((await screen.findByRole('alert')).textContent).toContain('Database worker unavailable');
    expect(screen.getByRole('button', { name: /retry startup/i })).toBeTruthy();
    expect(dispose).not.toHaveBeenCalled();
  });
});
