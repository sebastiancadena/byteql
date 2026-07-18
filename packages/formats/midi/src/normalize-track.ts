import { MidiParseError } from './errors.js';
import type { NormalizedEventMap, NormalizedTrack, TrackChunk } from './types.js';
import { decodeVlq } from './vlq.js';

function absoluteVlq(track: TrackChunk, offset: number): ReturnType<typeof decodeVlq> {
  try {
    return decodeVlq(track.body, offset);
  } catch (error) {
    if (!(error instanceof MidiParseError)) {
      throw error;
    }

    const detail = error.message.slice(error.message.indexOf(': ') + 2);
    throw new MidiParseError(error.code, track.bodyStart + error.offset, detail);
  }
}

function truncated(track: TrackChunk, offset: number, expected: string): MidiParseError {
  return new MidiParseError(
    'TRUNCATED_EVENT',
    track.bodyStart + offset,
    `expected ${expected} before the end of the track`,
  );
}

function appendCompletedEvent(
  normalized: number[],
  events: NormalizedEventMap[],
  eventBytes: Iterable<number>,
  deltaTime: number,
  sourceStart: number,
  sourceEnd: number,
): void {
  const normalizedStart = normalized.length;
  for (const byte of eventBytes) {
    normalized.push(byte);
  }
  events.push({
    index: events.length,
    deltaTime,
    normalizedStart,
    normalizedEnd: normalized.length,
    sourceStart,
    sourceEnd,
  });
}

export function normalizeTrack(track: TrackChunk): NormalizedTrack {
  const normalized: number[] = [];
  const events: NormalizedEventMap[] = [];
  let offset = 0;
  let runningStatus: number | undefined;

  try {
    while (offset < track.body.length) {
      const eventStart = offset;
      const delta = absoluteVlq(track, offset);
      const deltaBytes = track.body.slice(offset, delta.next);
      offset = delta.next;

      const nextByte = track.body[offset];
      if (nextByte === undefined) {
        throw truncated(track, offset, 'an event status or running-status data byte');
      }

      const hasExplicitStatus = nextByte >= 0x80;
      let status: number;
      if (hasExplicitStatus) {
        status = nextByte;
        offset += 1;
      } else {
        if (runningStatus === undefined) {
          throw new MidiParseError(
            'RUNNING_STATUS_MISSING',
            track.bodyStart + offset,
            'encountered a data byte without a current channel status',
          );
        }
        status = runningStatus;
      }

      if (status >= 0x80 && status <= 0xef) {
        if (hasExplicitStatus) {
          runningStatus = status;
        }

        const statusKind = status & 0xf0;
        const dataLength = statusKind === 0xc0 || statusKind === 0xd0 ? 1 : 2;
        const payloadStart = offset;
        for (let index = 0; index < dataLength; index += 1) {
          const dataOffset = payloadStart + index;
          const dataByte = track.body[dataOffset];
          if (dataByte === undefined) {
            throw truncated(track, dataOffset, `${dataLength} channel data byte(s)`);
          }
          if (dataByte >= 0x80) {
            throw new MidiParseError(
              'INVALID_DATA_BYTE',
              track.bodyStart + dataOffset,
              `expected a channel data byte below 0x80, received 0x${dataByte.toString(16)}`,
            );
          }
        }

        offset += dataLength;
        appendCompletedEvent(
          normalized,
          events,
          [...deltaBytes, status, ...track.body.slice(payloadStart, offset)],
          delta.value,
          track.bodyStart + eventStart,
          track.bodyStart + offset,
        );
        continue;
      }

      runningStatus = undefined;
      if (status === 0xff) {
        if (track.body[offset] === undefined) {
          throw truncated(track, offset, 'a meta event type');
        }

        offset += 1;
        const length = absoluteVlq(track, offset);
        offset = length.next;
        const payloadEnd = offset + length.value;
        if (payloadEnd > track.body.length) {
          throw truncated(track, track.body.length, `${length.value} meta payload byte(s)`);
        }
        offset = payloadEnd;
      } else if (status === 0xf0 || status === 0xf7) {
        const length = absoluteVlq(track, offset);
        offset = length.next;
        const payloadEnd = offset + length.value;
        if (payloadEnd > track.body.length) {
          throw truncated(track, track.body.length, `${length.value} SysEx payload byte(s)`);
        }
        offset = payloadEnd;
      } else {
        throw new MidiParseError(
          'UNSUPPORTED_STATUS',
          track.bodyStart + offset - 1,
          `unsupported system status 0x${status.toString(16)}`,
        );
      }

      appendCompletedEvent(
        normalized,
        events,
        track.body.slice(eventStart, offset),
        delta.value,
        track.bodyStart + eventStart,
        track.bodyStart + offset,
      );
    }
  } catch (error) {
    if (!(error instanceof MidiParseError)) {
      throw error;
    }

    return { bytes: Uint8Array.from(normalized), events, error };
  }

  return { bytes: Uint8Array.from(normalized), events };
}
