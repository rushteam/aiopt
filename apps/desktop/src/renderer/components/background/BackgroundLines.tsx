// Ambient line background behind the active screen. Purely decorative: aria-hidden
// and never hit-testable. Every card, table and list on the tab screens paints an
// opaque fill, so the lines only show in the gaps between them and the empty space
// below — at most behind a section heading, never behind data. A new transparent
// container on a tab screen would let the lines through; give it `bg` or `surface`.
//
// One of two variants (see geometry.ts) is picked at random once per launch and kept
// for the session, so switching tabs or closing Settings doesn't reshuffle it.
//
// Cost is kept near zero for an app that stays open in the menu bar:
//   • waves: each line is its own small <svg> animated with `transform` only, which
//     the compositor moves without repainting.
//   • circuit: the grid and traces are static; only a short dash per trace repaints.
//   • Everything pauses while the window is hidden, and `prefers-reduced-motion`
//     freezes it into a still picture (global.css).
//
// Animation keyframes live in global.css (a bundled same-origin sheet); the per-line
// values ride inline custom properties, which are CSSOM writes and so CSP-safe.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { token } from '../../themes/tokens';
import {
  circuitTraces,
  pickBackground,
  seededRng,
  tracePath,
  wavePath,
  waveReach,
  type BackgroundVariant,
  type WaveSpec,
} from './geometry';

// Per launch: which variant, and the seed its layout grows from.
const LAUNCH_VARIANT = pickBackground(Math.random);
const LAUNCH_SEED = Math.floor(Math.random() * 2 ** 32);

interface Size {
  width: number;
  height: number;
}

export function BackgroundLines({ variant = LAUNCH_VARIANT }: { variant?: BackgroundVariant }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [paused, setPaused] = useState(() => document.hidden);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A window closed to the tray is hidden, not destroyed: stop the loops until it's back.
  useEffect(() => {
    const onVisibility = (): void => setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="aiopt-bg"
      data-variant={variant}
      data-paused={paused ? '' : undefined}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        ...(variant === 'waves'
          ? { background: `radial-gradient(ellipse 90% 60% at 70% 105%, ${token('decorGlow')}, transparent 70%)` }
          : null),
      }}
    >
      {size && size.width > 0 && size.height > 0 ? (
        variant === 'waves' ? <Waves {...size} /> : <Circuit {...size} />
      ) : null}
    </div>
  );
}

// ─── Waves ──────────────────────────────────────────────────────────────────

interface WaveLine extends WaveSpec {
  /** Baseline as a fraction of the view height — the lines gather in the lower part. */
  at: number;
  strokeWidth: number;
  opacity: number;
  /** Seconds to drift one full wavelength. */
  drift: number;
  /** Drift to the right instead of the left, so neighbours cross each other. */
  reverse: boolean;
  /** Seconds for one half of the up/down sway, and how far it moves (px). */
  sway: number;
  swayBy: number;
  /** Negative delay (s), so the lines don't start the sway in step. */
  offset: number;
}

// Tuned by eye: slow enough that the page reads as calm, not busy.
const WAVE_LINES: readonly WaveLine[] = [
  { at: 0.62, amplitude: 18, wavelength: 520, phase: 0, strokeWidth: 1.3, opacity: 0.55, drift: 46, reverse: false, sway: 11, swayBy: 7, offset: 0 },
  { at: 0.68, amplitude: 24, wavelength: 640, phase: 1.3, strokeWidth: 1.1, opacity: 0.75, drift: 58, reverse: true, sway: 13, swayBy: 9, offset: 4 },
  { at: 0.74, amplitude: 14, wavelength: 440, phase: 2.1, strokeWidth: 1, opacity: 0.9, drift: 40, reverse: false, sway: 9, swayBy: 6, offset: 2 },
  { at: 0.8, amplitude: 30, wavelength: 760, phase: 0.6, strokeWidth: 0.9, opacity: 1, drift: 66, reverse: true, sway: 15, swayBy: 10, offset: 7 },
  { at: 0.87, amplitude: 12, wavelength: 380, phase: 2.8, strokeWidth: 0.8, opacity: 0.85, drift: 36, reverse: false, sway: 10, swayBy: 5, offset: 5 },
  { at: 0.94, amplitude: 20, wavelength: 560, phase: 1.9, strokeWidth: 0.8, opacity: 0.7, drift: 52, reverse: true, sway: 12, swayBy: 8, offset: 9 },
];

function Waves({ width, height }: Size) {
  return (
    <>
      {WAVE_LINES.map((line, i) => {
        // Each line's box is only as tall as the wave needs, so its compositor layer stays small.
        const boxHeight = Math.ceil(2 * waveReach(line) + 2 * line.strokeWidth + 4);
        const from = line.reverse ? -line.wavelength : 0;
        const to = line.reverse ? 0 : -line.wavelength;
        return (
          <div
            key={i}
            className="aiopt-bg-anim"
            style={
              {
                position: 'absolute',
                left: 0,
                top: Math.round(height * line.at - boxHeight / 2),
                opacity: line.opacity,
                willChange: 'transform',
                '--sway': `${line.swayBy}px`,
                animation: `aiopt-bg-sway ${line.sway}s ease-in-out ${-line.offset}s infinite alternate`,
              } as CSSProperties
            }
          >
            <svg
              className="aiopt-bg-anim"
              width={width + line.wavelength}
              height={boxHeight}
              style={
                {
                  display: 'block',
                  willChange: 'transform',
                  '--drift-from': `${from}px`,
                  '--drift-to': `${to}px`,
                  animation: `aiopt-bg-drift ${line.drift}s linear infinite`,
                } as CSSProperties
              }
            >
              <path
                d={wavePath(line, width, boxHeight / 2)}
                fill="none"
                strokeWidth={line.strokeWidth}
                strokeLinecap="round"
                style={{ stroke: token('decorLine') }}
              />
            </svg>
          </div>
        );
      })}
    </>
  );
}

// ─── Circuit ────────────────────────────────────────────────────────────────

/** Length of the travelling light (px) and how fast it runs (px/s). */
const PULSE_LENGTH = 32;
const PULSE_SPEED = 110;
/** Share of each cycle the pulse is travelling; the rest is a pause before it runs again.
 *  Must match the `65%` stop of `aiopt-bg-pulse` in global.css. */
const PULSE_ACTIVE = 0.65;

function Circuit({ width, height }: Size) {
  const traces = circuitTraces(width, height, seededRng(LAUNCH_SEED));
  const pulseRng = seededRng(LAUNCH_SEED ^ 0x9e3779b9);
  // Fade the grid out toward the top, where the screen's content starts.
  const mask = 'radial-gradient(ellipse 90% 75% at 60% 100%, #000 30%, transparent 80%)';
  return (
    <>
      <svg
        width={width}
        height={height}
        style={{ position: 'absolute', inset: 0, WebkitMaskImage: mask, maskImage: mask }}
      >
        <defs>
          <pattern id="aiopt-bg-grid" width={24} height={24} patternUnits="userSpaceOnUse">
            <path d="M24 0H0V24" fill="none" strokeWidth={1} style={{ stroke: token('decorGrid') }} />
          </pattern>
        </defs>
        <rect width={width} height={height} fill="url(#aiopt-bg-grid)" />
        {traces.map((trace, i) => (
          <path key={i} d={tracePath(trace)} fill="none" strokeWidth={1} style={{ stroke: token('decorLine') }} />
        ))}
        {traces.map((trace, i) => {
          const [x, y] = trace.points[trace.points.length - 1]!;
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={2.5}
              strokeWidth={1}
              style={{ fill: token('bg'), stroke: token('decorLine') }}
            />
          );
        })}
      </svg>
      <svg
        className="aiopt-bg-pulses"
        width={width}
        height={height}
        style={{ position: 'absolute', inset: 0, WebkitMaskImage: mask, maskImage: mask }}
      >
        {traces.map((trace, i) => {
          const cycle = (trace.length + PULSE_LENGTH) / PULSE_SPEED / PULSE_ACTIVE;
          return (
            <path
              key={i}
              className="aiopt-bg-anim"
              d={tracePath(trace)}
              fill="none"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeDasharray={`${PULSE_LENGTH} ${trace.length + PULSE_LENGTH}`}
              style={
                {
                  stroke: token('decorPulse'),
                  strokeDashoffset: PULSE_LENGTH,
                  '--pulse-from': `${PULSE_LENGTH}px`,
                  '--pulse-to': `${-trace.length}px`,
                  animation: `aiopt-bg-pulse ${cycle.toFixed(2)}s linear ${(-pulseRng() * cycle).toFixed(2)}s infinite`,
                } as CSSProperties
              }
            />
          );
        })}
      </svg>
    </>
  );
}
