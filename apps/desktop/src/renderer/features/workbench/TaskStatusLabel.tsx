import { token, fontSize, space } from '../../themes/tokens';
import type { TranslateFn } from '../../i18n';
import type { TaskStatus } from '../../../shared/workbench';

const dotStyle = { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 } as const;

/**
 * `approved` turns a waiting `proposed` task into "approved, queued" (it starts on its own);
 * `waiting` says its worker waits for the user to allow a write outside the folders.
 */
export function StatusLabel({
  status,
  approved = false,
  waiting = false,
  t,
}: {
  status: TaskStatus;
  approved?: boolean;
  waiting?: boolean;
  t: TranslateFn;
}) {
  const queued = approved && status === 'proposed';
  const dot = waiting
    ? token('warning')
    : status === 'working' || status === 'starting'
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
      {waiting
        ? t('workbench.writeGate.waiting')
        : queued
          ? t('workbench.plan.queued')
          : t(`workbench.taskStatus.${status}`)}
    </span>
  );
}
