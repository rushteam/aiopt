// A bar shown on every screen when main has found a newer published release.
// It only announces the version. It does not download or install.
// Not everyone wants every update, so the bar can be closed. Closing hides it for that
// version only; a newer release brings it back.

import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../../shared/ipc-channels';
import { fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import {
  readDismissedUpdateVersion,
  shouldShowUpdateNotice,
  writeDismissedUpdateVersion,
} from './updateNoticeDismissal';

export function UpdateNotice({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState(readDismissedUpdateVersion);

  useEffect(() => {
    let sawPush = false;
    const unsubscribe = window.aiopt.update.onStatusChanged((next) => {
      sawPush = true;
      setStatus(next);
    });
    void window.aiopt.update.getStatus().then((next) => {
      if (!sawPush) setStatus(next);
    });
    return unsubscribe;
  }, []);

  if (status?.state !== 'update-available' || !status.nextVersion) return null;
  const nextVersion = status.nextVersion;
  if (!shouldShowUpdateNotice(nextVersion, dismissed)) return null;

  return (
    <div
      style={{
        position: 'relative',
        borderBottom: `1px solid ${token('border')}`,
        background: token('surface'),
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        {...hoverBackground(token('surface'), token('surfaceHover'))}
        style={{
          display: 'block',
          width: '100%',
          margin: 0,
          // Room on the right so the text never runs under the close button.
          padding: `8px ${space.xl + 28}px`,
          border: 'none',
          background: token('surface'),
          color: token('text'),
          cursor: 'pointer',
          textAlign: 'center',
          fontSize: fontSize.sm,
        }}
      >
        {t('updates.notice')}{' '}
        <strong style={{ fontFamily: 'ui-monospace, monospace', color: token('accent') }}>
          {nextVersion}
        </strong>
      </button>
      <button
        type="button"
        aria-label={t('updates.dismiss')}
        title={t('updates.dismiss')}
        onClick={() => {
          writeDismissedUpdateVersion(nextVersion);
          setDismissed(nextVersion);
        }}
        {...hoverBackground('transparent', token('surfaceHover'))}
        style={{
          position: 'absolute',
          top: '50%',
          right: space.md,
          transform: 'translateY(-50%)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          padding: 0,
          borderRadius: radius.sm,
          border: 'none',
          background: 'transparent',
          color: token('textMuted'),
          cursor: 'pointer',
          fontSize: fontSize.lg,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}
