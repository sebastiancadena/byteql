export interface CsvClientPort {
  initialize(): Promise<void>;
  encode(
    ipc: Uint8Array,
    columns: readonly number[],
    header: boolean,
    write: (chunk: Uint8Array) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
  dispose(): Promise<void>;
}

export type CsvRequest =
  | { type: 'encode'; id: number; ipc: ArrayBuffer; columns: number[]; header: boolean }
  | { type: 'ack'; id: number; sequence: number }
  | { type: 'cancel'; id: number };

export type CsvResponse =
  | { type: 'ready' }
  | { type: 'chunk'; id: number; sequence: number; bytes: ArrayBuffer }
  | { type: 'done'; id: number }
  | { type: 'error'; id: number; message: string };
