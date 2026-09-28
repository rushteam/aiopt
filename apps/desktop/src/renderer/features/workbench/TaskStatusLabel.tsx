import { token, fontSize, space } from '../../themes/tokens';
import type { TranslateFn } from '../../i18n';
import type { TaskStatus } from '../../../shared/workbench';

const dotStyle = { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 } as const;

export function StatusLabel({ status, t }: { status: TaskStatus; t: TranslateFn }) {
  const dot =
    status === 'working' || status === 'starting'
      ? token('accent')
      : status === 'blocked' || status === 'failed'
        ? token('danger')
        : status === 'review' || status === 'done'
          ? token('success')
          : token('borderStrong');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: space.xs, flexShrink: 0, fontSize: fontSize.sm, color: token('textMuted') }}>
      <span aria-hidden style={{ ...dotStyle, background: dot }} />
      {t(`workbench.taskStatus.${status}`)}
    </span>
  );
}
