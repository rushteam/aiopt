// Update settings — shows the current version + update status and a check button.
//
// The bundled stub always resolves to "up to date". Status is owned by main; we
// read it once, subscribe to pushes, and reflect the in-flight `checking` state.

import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../../shared/ipc-channels';
import { token, fontSize, radius } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';

export function UpdateSection() {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let active = true;
    void window.aiopt.update.getStatus().then((s) => {
      if (active) setStatus(s);
    });
    const unsubscribe = window.aiopt.update.onStatusChanged((s) => setStatus(s));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const checking = status?.state === 'checking';

  return (
    <section>
      <h2 style={{ margin: '0 0 16px', fontSize: fontSize['2xl'] }}>{t('updates.title')}</h2>
      <p style={{ margin: '0 0 8px', fontSize: fontSize.md }}>
        {t('updates.currentVersion')}{' '}
        <strong style={{ fontFamily: 'ui-monospace, monospace' }}>
          {status?.currentVersion ?? '…'}
        </strong>
      </p>
      <p style={{ margin: '0 0 16px', color: token('textMuted'), fontSize: fontSize.base }}>
        {t(`updates.state.${status?.state ?? 'idle'}`)}
        {status?.state === 'update-available' && status.nextVersion
          ? ` (${status.nextVersion})`
          : ''}
      </p>
      <button
        type="button"
        onClick={() => void window.aiopt.update.check()}
        disabled={checking}
        {...hoverBackground(token('surface'), token('surfaceHover'))}
        style={{
          padding: '8px 16px',
          borderRadius: radius.md,
          border: `1px solid ${token('border')}`,
          background: token('surface'),
          color: token('text'),
          cursor: checking ? 'default' : 'pointer',
          opacity: checking ? 0.5 : 1,
          fontSize: fontSize.md,
        }}
      >
        {checking ? t('updates.checking') : t('updates.check')}
      </button>
    </section>
  );
}
