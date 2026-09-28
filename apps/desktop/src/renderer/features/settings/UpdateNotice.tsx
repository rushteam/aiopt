// A bar shown on every screen when main has found a newer published release.
// It only announces the version. It does not download or install.

import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../../shared/ipc-channels';
import { fontSize, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';

export function UpdateNotice({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus | null>(null);

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

  return (
    <button
      type="button"
      onClick={onOpen}
      {...hoverBackground(token('surface'), token('surfaceHover'))}
      style={{
        display: 'block',
        width: '100%',
        margin: 0,
        padding: '8px 16px',
        border: 'none',
        borderBottom: `1px solid ${token('border')}`,
        background: token('surface'),
        color: token('text'),
        cursor: 'pointer',
        textAlign: 'center',
        fontSize: fontSize.sm,
      }}
    >
      {t('updates.notice')}{' '}
      <strong style={{ fontFamily: 'ui-monospace, monospace', color: token('accent') }}>
        {status.nextVersion}
      </strong>
    </button>
  );
}
