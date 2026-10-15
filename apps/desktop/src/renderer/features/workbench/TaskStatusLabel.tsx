import { token, fontSize, space } from '../../themes/tokens';
import type { TranslateFn } from '../../i18n';
import type { TaskStatus } from '../../../shared/workbench';

const dotStyle = { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 } as const;

/** `approved` turns a waiting `proposed` task into "approved, queued" (it starts on its own). */
export function StatusLabel({ status, approved = false, t }: { status: TaskStatus; approved?: boolean; t: TranslateFn }) {
  const queued = approved && status === 'proposed';
  const dot =
    status === 'working' || status === 'starting'
      ? token('accent')
      : status === 'blocked' || status === 'failed'
        ? token('danger')
        : status === 'review' || status === 'done'
          ? token('success')
          : queued
            ? token('accent')
            : token('borderStrong');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: space.xs, flexShrink: 0, fontSize: fontSize.sm, color: token('textMuted') }}>
      <span aria-hidden style={{ ...dotStyle, background: dot }} />
      {queued ? t('workbench.plan.queued') : t(`workbench.taskStatus.${status}`)}
    </span>
  );
}
