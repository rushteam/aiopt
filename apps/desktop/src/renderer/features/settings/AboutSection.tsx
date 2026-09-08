// About settings — version strings read from main via the app-info IPC.

import { useEffect, useState } from 'react';
import type { AppVersionsResult } from '../../../shared/ipc-channels';
import { token, fontSize } from '../../themes/tokens';
import { useT } from '../../i18n';

export function AboutSection() {
  const t = useT();
  const [versions, setVersions] = useState<AppVersionsResult | null>(null);

  useEffect(() => {
    let active = true;
    void window.hearth.getVersions().then((v) => {
      if (active) setVersions(v);
    });
    return () => {
      active = false;
    };
  }, []);

  const rows: Array<[string, string | undefined]> = [
    [t('about.appVersion'), versions?.app],
    [t('about.electron'), versions?.electron],
    [t('about.chrome'), versions?.chrome],
    [t('about.node'), versions?.node],
  ];

  return (
    <section>
      <h2 style={{ margin: '0 0 16px', fontSize: fontSize['2xl'] }}>{t('about.title')}</h2>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 24px', margin: 0 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt style={{ color: token('textMuted'), fontSize: fontSize.base }}>{label}</dt>
            <dd style={{ margin: 0, fontSize: fontSize.base, fontFamily: 'ui-monospace, monospace' }}>
              {value ?? t('about.loading')}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
