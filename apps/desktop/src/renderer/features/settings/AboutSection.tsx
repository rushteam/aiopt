// About settings — version strings read from main via the app-info IPC, the update
// check, and a link to the project's GitHub page.
//
// The link is a plain `target="_blank"` anchor: main's window-open handler denies the
// popup and hands http(s) URLs to the system browser (security/navigation.ts).

import { useEffect, useState } from 'react';
import type { AppVersionsResult } from '../../../shared/ipc-channels';
import { token, fontSize } from '../../themes/tokens';
import { useT } from '../../i18n';
import { UpdateSection } from './UpdateSection';

export const PROJECT_HOMEPAGE = 'https://github.com/rushteam/aiopt';

export function AboutSection() {
  const t = useT();
  const [versions, setVersions] = useState<AppVersionsResult | null>(null);

  useEffect(() => {
    let active = true;
    void window.aiopt.getVersions().then((v) => {
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
        <dt style={{ color: token('textMuted'), fontSize: fontSize.base }}>{t('about.homepage')}</dt>
        <dd style={{ margin: 0, fontSize: fontSize.base }}>
          <a
            href={PROJECT_HOMEPAGE}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: token('accent'), textDecoration: 'none' }}
          >
            {PROJECT_HOMEPAGE.replace('https://', '')} ↗
          </a>
        </dd>
      </dl>
      <UpdateSection />
    </section>
  );
}
