import { initialSessionState, reduceSession, type SessionEvent, type SessionState } from './state.js';

/**
 * The state every session collaborator publishes into, plus the session-wide fences they share.
 *
 * State only ever changes through the pure reducer in `state.ts`; this class merely holds the
 * current value and fans it out. The session generation moves whenever a file opens, the session
 * is cancelled, or the controller is disposed, and every asynchronous continuation compares the
 * generation it captured against it before publishing anything.
 */
export class SessionStore {
  private current: SessionState = initialSessionState;
  private readonly subscribers = new Set<(state: SessionState) => void>();
  private generation = 0;
  private isDisposed = false;

  get state(): SessionState {
    return this.current;
  }

  get sessionGeneration(): number {
    return this.generation;
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  /** Invalidates every continuation captured under the previous session generation. */
  nextSession(): number {
    return ++this.generation;
  }

  isCurrent(generation: number): boolean {
    return !this.isDisposed && generation === this.generation;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.subscribers.add(listener);
    try {
      listener(this.current);
    } catch (error) {
      this.subscribers.delete(listener);
      throw error;
    }
    return () => this.subscribers.delete(listener);
  }

  dispatch(event: SessionEvent): void {
    this.current = reduceSession(this.current, event);
    for (const listener of this.subscribers) {
      try {
        listener(this.current);
      } catch {
        this.subscribers.delete(listener);
      }
    }
  }

  /** Marks the session disposed; listeners stay until `release`, so final events still reach them. */
  markDisposed(): void {
    this.isDisposed = true;
  }

  /** Drops every listener and forgets the published state. */
  release(): void {
    this.subscribers.clear();
    this.current = { ...initialSessionState, tables: [], issues: [] };
  }
}
