// Pure geometry for the ambient background (BackgroundLines). No DOM, no React, so
// every shape the background draws is unit-testable in the node test environment.
//
// Two variants, picked at random once per launch:
//   • waves   — layered sine lines that drift sideways and sway up and down.
//   • circuit — a faint grid with right-angle traces and a light pulse along each.

export type BackgroundVariant = 'waves' | 'circuit';

/** A source of uniform numbers in [0, 1) — `Math.random`, or a seeded one in tests. */
export type Rng = () => number;

export const BACKGROUND_VARIANTS: readonly BackgroundVariant[] = ['waves', 'circuit'];

export function pickBackground(rng: Rng): BackgroundVariant {
  const i = Math.min(Math.floor(rng() * BACKGROUND_VARIANTS.length), BACKGROUND_VARIANTS.length - 1);
  return BACKGROUND_VARIANTS[i]!;
}

/** Small seeded PRNG (mulberry32), so a layout can be regenerated identically on resize. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Waves ──────────────────────────────────────────────────────────────────

export interface WaveSpec {
  /** Amplitude of the fundamental (px). A second harmonic adds a third of this. */
  amplitude: number;
  /** One full period (px). The drift moves exactly this far per loop. */
  wavelength: number;
  /** Phase offset (radians), so stacked lines don't crest together. */
  phase: number;
}

/** Half the vertical room a wave needs: fundamental + harmonic. */
export function waveReach(spec: WaveSpec): number {
  return spec.amplitude * (1 + HARMONIC);
}

const HARMONIC = 1 / 3;

/**
 * A wave's y offset from its baseline at x. It depends on x only through
 * `x / wavelength`, and both terms have whole periods per wavelength, so
 * `waveY(x) === waveY(x + wavelength)` — which is what lets a translate of one
 * wavelength loop without a seam.
 */
export function waveY(spec: WaveSpec, x: number): number {
  const k = (2 * Math.PI * x) / spec.wavelength;
  return spec.amplitude * Math.sin(k + spec.phase) + spec.amplitude * HARMONIC * Math.sin(2 * k + spec.phase * 2);
}

/**
 * SVG path for a wave spanning `[0, width + wavelength]` around `baseline`: one extra
 * wavelength beyond the visible width, so the line still covers the view at every
 * point of its drift.
 */
export function wavePath(spec: WaveSpec, width: number, baseline: number, step = 8): string {
  const end = width + spec.wavelength;
  const parts: string[] = [];
  for (let x = 0; ; x += step) {
    const px = Math.min(x, end);
    parts.push(`${parts.length === 0 ? 'M' : 'L'}${px} ${(baseline + waveY(spec, px)).toFixed(1)}`);
    if (px >= end) break;
  }
  return parts.join('');
}

// ─── Circuit ────────────────────────────────────────────────────────────────

export interface Trace {
  /** Grid-aligned polyline, consecutive points differing on exactly one axis. */
  points: ReadonlyArray<readonly [number, number]>;
  /** Total length of the polyline (px). */
  length: number;
}

/** Grid pitch (px): the grid lines and every trace vertex sit on multiples of it. */
export const CIRCUIT_GRID = 24;

/**
 * Right-angle traces for a `width × height` view. Traces start from an edge and
 * wander inward, kept to the lower part of the view (the top is where the reading
 * starts, and a mask fades it anyway). Deterministic for a given rng.
 */
export function circuitTraces(width: number, height: number, rng: Rng, grid = CIRCUIT_GRID): Trace[] {
  const cols = Math.floor(width / grid);
  const rows = Math.floor(height / grid);
  if (cols < 4 || rows < 4) return [];
  const minRow = Math.floor(rows * 0.45);
  const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
  const count = Math.max(5, Math.min(12, Math.round((width * height) / 70000)));

  const traces: Trace[] = [];
  for (let n = 0; n < count; n++) {
    const side = int(0, 2); // 0 left, 1 right, 2 bottom
    let c = side === 0 ? 0 : side === 1 ? cols : int(1, cols - 1);
    let r = side === 2 ? rows : int(minRow, rows - 1);
    let horizontal = side !== 2;
    let dir = side === 1 ? -1 : side === 2 ? -1 : 1;
    const points: Array<[number, number]> = [[c * grid, r * grid]];
    let length = 0;

    const segments = int(3, 5);
    for (let s = 0; s < segments; s++) {
      if (s > 0) dir = rng() < 0.5 ? -1 : 1;
      const want = horizontal ? int(3, 9) : int(2, 5);
      const [lo, hi] = horizontal ? [0, cols] : [minRow, rows];
      const from = horizontal ? c : r;
      const to = Math.max(lo, Math.min(hi, from + dir * want));
      if (to === from) break;
      if (horizontal) c = to;
      else r = to;
      length += Math.abs(to - from) * grid;
      points.push([c * grid, r * grid]);
      horizontal = !horizontal;
    }
    if (points.length > 1) traces.push({ points, length });
  }
  return traces;
}

export function tracePath(trace: Trace): string {
  return trace.points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join('');
}
