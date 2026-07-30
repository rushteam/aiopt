// Update settings — shows the current version + update status and a check button.
//
// The bundled stub always resolves to "up to date". Status is owned by main; we
// read it once, subscribe to pushes, and reflect the in-flight `checking` state.

import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../../shared/ipc-channels';
import { token } from '../../themes/tokens';
import { useT } from '../../i18n';

export function UpdateSection() {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let active = true;
    void window.hearth.update.getStatus().then((s) => {
      if (active) setStatus(s);
    });
    const unsubscribe = window.hearth.update.onStatusChanged((s) => setStatus(s));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const checking = status?.state === 'checking';

  return (
    <section>
      <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>{t('updates.title')}</h2>
      <p style={{ margin: '0 0 8px', fontSize: 14 }}>
        {t('updates.currentVersion')}{' '}
        <strong style={{ fontFamily: 'ui-monospace, monospace' }}>
          {status?.currentVersion ?? '…'}
        </strong>
      </p>
      <p style={{ margin: '0 0 16px', color: token('textMuted'), fontSize: 13 }}>
        {t(`updates.state.${status?.state ?? 'idle'}`)}
        {status?.state === 'update-available' && status.nextVersion
          ? ` (${status.nextVersion})`
          : ''}
      </p>
      <button
        type="button"
        onClick={() => void window.hearth.update.check()}
        disabled={checking}
        style={{
          padding: '8px 16px',
          borderRadius: 8,
          border: `1px solid ${token('border')}`,
          background: token('surface'),
          color: token('text'),
          cursor: checking ? 'default' : 'pointer',
          fontSize: 14,
        }}
      >
        {checking ? t('updates.checking') : t('updates.check')}
      </button>
    </section>
  );
}
