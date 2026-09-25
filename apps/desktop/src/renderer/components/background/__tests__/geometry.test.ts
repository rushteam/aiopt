import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_VARIANTS,
  CIRCUIT_GRID,
  circuitTraces,
  pickBackground,
  seededRng,
  tracePath,
  wavePath,
  waveReach,
  waveY,
  type WaveSpec,
} from '../geometry';

const SPEC: WaveSpec = { amplitude: 18, wavelength: 420, phase: 1.3 };

describe('pickBackground', () => {
  it('covers every variant across the rng range, including its edges', () => {
    const seen = new Set([0, 0.25, 0.5, 0.75, 0.999999].map((v) => pickBackground(() => v)));
    expect([...seen].sort()).toEqual([...BACKGROUND_VARIANTS].sort());
    // An rng that (wrongly) returns 1 must still land on a real variant.
    expect(BACKGROUND_VARIANTS).toContain(pickBackground(() => 1));
  });
});

describe('seededRng', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('waves', () => {
  // The drift translates a line by exactly one wavelength per loop; the loop is only
  // seamless if the curve repeats at that period.
  it('repeats exactly every wavelength', () => {
    for (let x = 0; x < SPEC.wavelength; x += 7) {
      expect(waveY(SPEC, x + SPEC.wavelength)).toBeCloseTo(waveY(SPEC, x), 9);
    }
  });

  it('never leaves the reach the layout reserves for it', () => {
    for (let x = 0; x < SPEC.wavelength; x += 1) {
      expect(Math.abs(waveY(SPEC, x))).toBeLessThanOrEqual(waveReach(SPEC));
    }
  });

  it('spans the visible width plus one wavelength, ending exactly at the edge', () => {
    const d = wavePath(SPEC, 1000, 50);
    expect(d.startsWith('M0 ')).toBe(true);
    const xs = [...d.matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1]));
    expect(xs[xs.length - 1]).toBe(1000 + SPEC.wavelength);
    expect(xs.every((x, i) => i === 0 || x > xs[i - 1]!)).toBe(true);
  });
});

describe('circuit traces', () => {
  const W = 1024;
  const H = 680;
  const traces = circuitTraces(W, H, seededRng(7));

  it('produces a handful of traces for a window-sized view', () => {
    expect(traces.length).toBeGreaterThanOrEqual(5);
    expect(traces.length).toBeLessThanOrEqual(12);
  });

  it('keeps every vertex on the grid, inside the view, in its lower part', () => {
    const cols = Math.floor(W / CIRCUIT_GRID);
    const rows = Math.floor(H / CIRCUIT_GRID);
    for (const t of traces) {
      for (const [x, y] of t.points) {
        expect(x % CIRCUIT_GRID).toBe(0);
        expect(y % CIRCUIT_GRID).toBe(0);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(cols * CIRCUIT_GRID);
        expect(y).toBeGreaterThanOrEqual(Math.floor(rows * 0.45) * CIRCUIT_GRID);
        expect(y).toBeLessThanOrEqual(rows * CIRCUIT_GRID);
      }
    }
  });

  it('draws only right angles, and reports the length it draws', () => {
    for (const t of traces) {
      let sum = 0;
      for (let i = 1; i < t.points.length; i++) {
        const [x0, y0] = t.points[i - 1]!;
        const [x1, y1] = t.points[i]!;
        expect((x0 === x1) !== (y0 === y1)).toBe(true);
        sum += Math.abs(x1 - x0) + Math.abs(y1 - y0);
      }
      expect(t.length).toBe(sum);
      expect(tracePath(t).startsWith(`M${t.points[0]![0]} ${t.points[0]![1]}`)).toBe(true);
    }
  });

  it('regenerates the same layout for the same seed, and nothing for a tiny view', () => {
    expect(circuitTraces(W, H, seededRng(7))).toEqual(traces);
    expect(circuitTraces(60, 60, seededRng(7))).toEqual([]);
  });
});
