// Per-seat cooldown after a failover-eligible failure.
//
// Pure in-memory map. A resting seat is tried last (not skipped), so a group of
// one still answers, and a seat whose rest has expired is tried again.

import { ROUTING_COOLDOWN_MS } from '../../../shared/routingGroups';

export interface CooldownBook {
  rest(seat: string, now?: number): void;
  isResting(seat: string, now?: number): boolean;
  restingSeats(now?: number): Set<string>;
  /** When `seat`'s rest ends (ms epoch), or null when it is not resting. */
  restingUntil(seat: string, now?: number): number | null;
  /** End `seat`'s rest now (the user's "retry now"). True when it was resting. */
  lift(seat: string): boolean;
  clear(): void;
}

export function createCooldownBook(ttlMs: number = ROUTING_COOLDOWN_MS): CooldownBook {
  const until = new Map<string, number>();

  function purge(now: number): void {
    for (const [seat, t] of until) {
      if (t <= now) until.delete(seat);
    }
  }

  return {
    rest(seat, now = Date.now()) {
      until.set(seat, now + ttlMs);
    },
    isResting(seat, now = Date.now()) {
      const t = until.get(seat);
      if (t === undefined) return false;
      if (t <= now) {
        until.delete(seat);
        return false;
      }
      return true;
    },
    restingSeats(now = Date.now()) {
      purge(now);
      return new Set(until.keys());
    },
    restingUntil(seat, now = Date.now()) {
      const t = until.get(seat);
      if (t === undefined) return null;
      if (t <= now) {
        until.delete(seat);
        return null;
      }
      return t;
    },
    lift(seat) {
      const t = until.get(seat);
      until.delete(seat);
      return t !== undefined && t > Date.now();
    },
    clear() {
      until.clear();
    },
  };
}
