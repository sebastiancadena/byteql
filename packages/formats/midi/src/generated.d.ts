declare module '*StandardMidiFile.js' {
  export interface GeneratedDebugRange {
    start: number;
    end: number;
    ioOffset: number;
  }

  export interface GeneratedArrayDebugRange extends GeneratedDebugRange {
    arr: GeneratedDebugRange[];
  }

  export interface GeneratedTrackEventsDebug {
    event: GeneratedArrayDebugRange;
  }

  export interface GeneratedEventBody {
    note: number;
    velocity: number;
    pressure: number;
    controller: number;
    value: number;
    program: number;
    b1: number;
    b2: number;
    readonly bendValue: number;
    readonly adjBendValue: number;
  }

  export interface GeneratedVlq {
    readonly value: number;
  }

  export interface GeneratedMetaEventBody {
    metaType: number;
    len: GeneratedVlq;
    body: Uint8Array;
  }

  export interface GeneratedSysexEventBody {
    len: GeneratedVlq;
    data: Uint8Array;
  }

  export interface GeneratedTrackEvent {
    vTime: GeneratedVlq;
    eventHeader: number;
    eventBody: GeneratedEventBody;
    metaEventBody?: GeneratedMetaEventBody;
    sysexBody?: GeneratedSysexEventBody;
    readonly eventType: number;
    readonly channel?: number;
  }

  export interface GeneratedTrackEvents {
    event: GeneratedTrackEvent[];
    _debug: GeneratedTrackEventsDebug;
  }

  export interface GeneratedTrack {
    magic: Uint8Array;
    lenEvents: number;
    events: GeneratedTrackEvents;
  }

  export class StandardMidiFile {
    constructor(stream: unknown);
    _read(): void;
    tracks: GeneratedTrack[];
  }
}
