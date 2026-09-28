import { useRef, useState, type ReactNode } from 'react';
import { token, space } from '../../themes/tokens';
import {
  clampSplitRatioToWidth,
  readWorkbenchSplitRatio,
  writeWorkbenchSplitRatio,
} from './workbenchSplit';

export function WorkbenchSplitPane({
  left,
  right,
  resizeLabel,
}: {
  left: ReactNode;
  right: ReactNode;
  resizeLabel: string;
}) {
  const [ratio, setRatio] = useState(readWorkbenchSplitRatio);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const applyRatio = (next: number): void => {
    const el = containerRef.current;
    const width = el?.getBoundingClientRect().width ?? 0;
    const clamped = clampSplitRatioToWidth(next, width);
    setRatio(clamped);
  };

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: 'flex',
        alignItems: 'stretch',
      }}
    >
      <div
        style={{
          flex: `${ratio} 1 0`,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={resizeLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          draggingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.style.background = token('surfaceHover');
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current || !containerRef.current) return;
          const rect = containerRef.current.getBoundingClientRect();
          applyRatio((e.clientX - rect.left) / rect.width);
        }}
        onPointerUp={(e) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
          e.currentTarget.style.background = 'transparent';
          writeWorkbenchSplitRatio(ratioRef.current);
        }}
        onPointerCancel={(e) => {
          draggingRef.current = false;
          e.currentTarget.style.background = 'transparent';
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.08 : 0.04;
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            applyRatio(ratioRef.current - step);
            writeWorkbenchSplitRatio(ratioRef.current);
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            applyRatio(ratioRef.current + step);
            writeWorkbenchSplitRatio(ratioRef.current);
          }
        }}
        style={{
          flexShrink: 0,
          width: space.sm,
          margin: `0 ${space.xs}px`,
          cursor: 'col-resize',
          touchAction: 'none',
          background: 'transparent',
          borderLeft: `1px solid ${token('border')}`,
          borderRight: `1px solid ${token('border')}`,
        }}
      />
      <div
        style={{
          flex: `${1 - ratio} 1 0`,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {right}
      </div>
    </div>
  );
}
