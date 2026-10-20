/**
 * Idle accounting. Idle = intervals where the agent is waiting on the user
 * (permission prompts, questions). A wait starts on a waiting/notification
 * event and ends on the next tool or assistant event.
 *
 *   active_ms = finished_at - submitted_at - idle_ms
 */
export class IdleClock {
  idleMs = 0;
  waitingSince: number | null = null;
  reason: string | null = null;

  startWait(ts: number, reason: string | null = null): void {
    if (this.waitingSince !== null) return; // already waiting; keep the earliest start
    this.waitingSince = ts;
    this.reason = reason;
  }

  /** End the current wait. Returns the length of the closed interval. */
  endWait(ts: number): number {
    if (this.waitingSince === null) return 0;
    const d = Math.max(0, ts - this.waitingSince);
    this.idleMs += d;
    this.waitingSince = null;
    this.reason = null;
    return d;
  }

  get waiting(): boolean {
    return this.waitingSince !== null;
  }

  /** Idle time up to `now`, including an open wait. */
  total(now: number): number {
    return this.idleMs + (this.waitingSince !== null ? Math.max(0, now - this.waitingSince) : 0);
  }
}

export function activeMs(submittedAt: number, finishedAt: number, idleMs: number): number {
  return Math.max(0, finishedAt - submittedAt - idleMs);
}

/** Sum of the union of [start, end] intervals (overlapping waits are not double counted). */
export function unionLength(intervals: [number, number][]): number {
  const xs = intervals.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curA = -Infinity, curB = -Infinity;
  for (const [a, b] of xs) {
    if (a > curB) {
      if (curB > curA) total += curB - curA;
      curA = a; curB = b;
    } else if (b > curB) {
      curB = b;
    }
  }
  if (curB > curA) total += curB - curA;
  return total;
}
