// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SAMPLES } from '../lib/session/samples.js';
import EmptyState from './EmptyState.svelte';

function renderIntake(overrides: Record<string, unknown> = {}) {
  return render(EmptyState, { onopen: vi.fn(), onsample: vi.fn(), ...overrides });
}

describe('EmptyState intake', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('offers exactly one visible file action', () => {
    renderIntake();

    expect(screen.getByRole('button', { name: 'Open file' })).toBeTruthy();
    // No competing Browse/second-opener control, whether or not the native picker exists.
    expect(screen.queryByRole('button', { name: 'Browse files' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use file input' })).toBeNull();

    vi.stubGlobal('showOpenFilePicker', vi.fn());
    cleanup();
    renderIntake();
    expect(screen.getAllByRole('button', { name: /open file/iu })).toHaveLength(1);
  });

  it('keeps an attached, labelled, multiple file input for drop, automation and fallback', async () => {
    const onopen = vi.fn();
    renderIntake({ onopen });

    const input = screen.getByLabelText<HTMLInputElement>('Open file input');
    expect(input.type).toBe('file');
    expect(input.multiple).toBe(true);
    expect(input.isConnected).toBe(true);

    const files = [new File([new Uint8Array([1])], 'a.pcap'), new File([new Uint8Array([2])], 'b.pcap')];
    await fireEvent.change(input, { target: { files } });
    expect(onopen).toHaveBeenCalledWith(files);
    // Reset so re-selecting the same file fires change again.
    expect(input.value).toBe('');
  });

  it('clicks the file input when the native picker is unavailable', async () => {
    expect('showOpenFilePicker' in window).toBe(false);
    renderIntake();
    const input = screen.getByLabelText<HTMLInputElement>('Open file input');
    const click = vi.spyOn(input, 'click');

    await fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    expect(click).toHaveBeenCalledOnce();
  });

  it('forwards every file the native picker returns', async () => {
    const files = [
      new File([new Uint8Array([1])], 'capture.pcap'),
      new File([new Uint8Array([2])], 'b.pcap'),
    ];
    const picker = vi.fn(async () => files.map((file) => ({ getFile: vi.fn(async () => file) })));
    vi.stubGlobal('showOpenFilePicker', picker);
    const onopen = vi.fn();
    renderIntake({ onopen });
    const input = screen.getByLabelText<HTMLInputElement>('Open file input');
    const click = vi.spyOn(input, 'click');

    await fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    await vi.waitFor(() => expect(onopen).toHaveBeenCalledWith(files));
    expect(picker).toHaveBeenCalledWith({ multiple: true });
    // The native picker and the input must never both fire for one gesture.
    expect(click).not.toHaveBeenCalled();
  });

  it('is silent when the user dismisses the native picker', async () => {
    const picker = vi.fn(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    });
    vi.stubGlobal('showOpenFilePicker', picker);
    const onopen = vi.fn();
    renderIntake({ onopen });

    await fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    await vi.waitFor(() => expect(picker).toHaveBeenCalledOnce());
    expect(onopen).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use file input' })).toBeNull();
  });

  it('explains a non-abort picker failure and offers the file input instead', async () => {
    vi.stubGlobal(
      'showOpenFilePicker',
      vi.fn(async () => {
        throw new Error('Picker is blocked by policy');
      }),
    );
    renderIntake();

    await fireEvent.click(screen.getByRole('button', { name: 'Open file' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Picker is blocked by policy');

    const fallback = screen.getByRole('button', { name: 'Use file input' });
    const input = screen.getByLabelText<HTMLInputElement>('Open file input');
    const click = vi.spyOn(input, 'click');
    await fireEvent.click(fallback);
    expect(click).toHaveBeenCalledOnce();
  });

  it('does not open anything while intake is busy', async () => {
    const picker = vi.fn();
    vi.stubGlobal('showOpenFilePicker', picker);
    renderIntake({ busy: true });

    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Open file' });
    expect(button.disabled).toBe(true);
    await fireEvent.click(button);
    expect(picker).not.toHaveBeenCalled();
  });

  it('presents the work-surface copy, samples and privacy sentence', () => {
    const { container } = renderIntake();

    expect(screen.getByRole('heading', { name: 'Open a binary file.' })).toBeTruthy();
    expect(
      screen.getByText('Query its tables with SQL. Select a row to inspect its source bytes.'),
    ).toBeTruthy();
    expect(screen.getByText('Files are processed in this browser. Nothing is uploaded.')).toBeTruthy();
    expect(screen.getByText('Drop MIDI, pcap, or ZIP files anywhere to open.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Explore a sample' })).toBeTruthy();

    // Sample rows describe the choices; the Try sample menu remains the only click target.
    for (const sample of SAMPLES) {
      expect(screen.getByText(sample.label)).toBeTruthy();
      expect(screen.getByText(sample.description)).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: /Try sample/u })).toBeTruthy();
    expect(container.querySelector('[data-brand-lockup]')).toBeTruthy();
  });

  it('drops the Command Deck slogans and proof cards', () => {
    renderIntake();

    expect(screen.queryByText(/Query the file/iu)).toBeNull();
    expect(screen.queryByText(/Browser-native binary intelligence/iu)).toBeNull();
    expect(screen.queryByText(/No upload\. No server\./iu)).toBeNull();
    expect(screen.queryByText(/Source-linked evidence/iu)).toBeNull();
    expect(screen.queryByLabelText('Privacy guarantees')).toBeNull();
  });

  it('opens files dropped onto the intake surface', async () => {
    const onopen = vi.fn();
    const { container } = renderIntake({ onopen });
    const files = [new File([new Uint8Array([1])], 'a.mid')];

    await fireEvent.drop(container.querySelector('section')!, { dataTransfer: { files } });
    expect(onopen).toHaveBeenCalledWith(files);
  });
});
