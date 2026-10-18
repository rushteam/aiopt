// Per-seat cooldown after a failover-eligible failure.
//
// Pure in-memory map. A resting seat is tried last (not skipped), so a group of
// one still answers, and a seat whose rest has expired is tried again.

import { ROUTING_COOLDOWN_MS } from '../../../shared/routingGroups';

export interface CooldownBook {
  rest(seat: string, now?: number): void;
  isResting(seat: string, now?: number): boolean;
  restingSeats(now?: number): Set<string>;
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
    clear() {
      until.clear();
    },
  };
}
