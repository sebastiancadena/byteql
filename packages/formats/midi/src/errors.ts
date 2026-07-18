export class MidiParseError extends Error {
  constructor(
    readonly code: string,
    readonly offset: number,
    message: string,
  ) {
    super(`${code} at offset ${offset}: ${message}`);
    this.name = 'MidiParseError';
  }
}
