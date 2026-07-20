// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import EmptyState from './EmptyState.svelte';

describe('EmptyState native file picker intake', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('empty state renders the picker button only when showOpenFilePicker exists', () => {
    // jsdom does not implement the File System Access API, so the button is absent by default.
    expect('showOpenFilePicker' in window).toBe(false);
    render(EmptyState, { onopen: vi.fn(), onsample: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Browse files' })).toBeNull();
    // The required, e2e-load-bearing input stays untouched regardless.
    expect(screen.getByLabelText('Open file').getAttribute('type')).toBe('file');
    cleanup();

    vi.stubGlobal('showOpenFilePicker', vi.fn());
    render(EmptyState, { onopen: vi.fn(), onsample: vi.fn() });
    expect(screen.getByRole('button', { name: 'Browse files' })).toBeTruthy();
  });

  it('forwards every picked file and marks the input multiple', async () => {
    const onopen = vi.fn();
    render(EmptyState, { onopen, onsample: vi.fn() });
    const input = screen.getByLabelText<HTMLInputElement>('Open file');
    expect(input.multiple).toBe(true);
    const files = [new File([new Uint8Array([1])], 'a.pcap'), new File([new Uint8Array([2])], 'b.pcap')];
    await fireEvent.change(input, { target: { files } });
    expect(onopen).toHaveBeenCalledWith(files);
  });

  it('picker selection forwards the file to onopen and dismissal is silent', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'capture.pcap');
    const handle = { getFile: vi.fn(async () => file) };
    const picker = vi.fn(async () => [handle]);
    vi.stubGlobal('showOpenFilePicker', picker);
    const onopen = vi.fn();
    render(EmptyState, { onopen, onsample: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Browse files' }));
    await vi.waitFor(() => expect(onopen).toHaveBeenCalledWith([file]));
    expect(picker).toHaveBeenCalledWith({ multiple: true });
    cleanup();

    const abortError = new DOMException('The user aborted a request.', 'AbortError');
    const dismissingPicker = vi.fn(async () => {
      throw abortError;
    });
    vi.stubGlobal('showOpenFilePicker', dismissingPicker);
    const onopenAfterDismiss = vi.fn();
    render(EmptyState, { onopen: onopenAfterDismiss, onsample: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Browse files' }));
    await vi.waitFor(() => expect(dismissingPicker).toHaveBeenCalledOnce());
    expect(onopenAfterDismiss).not.toHaveBeenCalled();
  });

  it('presents the Command Deck promise, formats, and local-only proof', () => {
    const { container } = render(EmptyState, { props: { onopen: vi.fn(), onsample: vi.fn() } });

    expect(screen.getByRole('heading', { name: 'Query the file. Prove the answer.' })).toBeTruthy();
    expect(screen.getByText('Browser-native binary intelligence')).toBeTruthy();
    expect(screen.getByText('No upload. No server.')).toBeTruthy();
    expect(screen.getByText(/files never leave this browser/iu)).toBeTruthy();
    expect(screen.getByText('MIDI')).toBeTruthy();
    expect(screen.getByText('pcap')).toBeTruthy();
    expect(container.querySelector('[data-brand-lockup]')).toBeTruthy();
  });
});
