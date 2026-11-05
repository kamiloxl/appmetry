/**
 * Pure session state machine, driven by AppState. A session survives short trips to the
 * background: only a gap longer than `timeoutMs` starts a new one.
 */
export class SessionTracker {
  private sid: string | null = null;
  private activeSince: number | null = null;
  private backgroundedAt: number | null = null;

  constructor(
    private readonly timeoutMs: number,
    private readonly newId: () => string
  ) {}

  /** The app came to the foreground at `now`. `started` is true when this opened a new session. */
  onActive(now: number): { sid: string; started: boolean } {
    let started = false;
    if (this.sid === null || (this.backgroundedAt !== null && now - this.backgroundedAt > this.timeoutMs)) {
      this.sid = this.newId();
      started = true;
    }
    this.backgroundedAt = null;
    // A repeated 'active' without a background in between must not reset the running stint.
    if (this.activeSince === null) this.activeSince = now;
    return { sid: this.sid, started };
  }

  /**
   * The app went to the background at `now`. `foregroundMs` is the time since it last became
   * active (a delta, so summing pings gives total foreground time). Null if it was not active.
   */
  onBackground(now: number): { sid: string; foregroundMs: number } | null {
    if (this.sid === null || this.activeSince === null) return null;
    const foregroundMs = Math.max(0, now - this.activeSince);
    this.activeSince = null;
    this.backgroundedAt = now;
    return { sid: this.sid, foregroundMs };
  }

  current(): string | null {
    return this.sid;
  }
}
