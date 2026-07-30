// Keyboard shortcuts settings — lists the app shortcuts from the shared registry.
//
// The list and the native menu's accelerators come from the SAME source
// (shared/shortcuts.ts), so what's shown here always matches what's bound.

import { SHORTCUT_LIST, formatAccelerator } from '../../../shared/shortcuts';
import { token } from '../../themes/tokens';
import { useT } from '../../i18n';

export function ShortcutsSection() {
  const t = useT();
  const isMac = window.hearth.platform === 'darwin';

  return (
    <section>
      <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>{t('shortcuts.title')}</h2>
      <dl style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px 24px', margin: 0 }}>
        {SHORTCUT_LIST.map((shortcut) => (
          <div key={shortcut.id} style={{ display: 'contents' }}>
            <dt style={{ fontSize: 14 }}>{t(`shortcuts.items.${shortcut.id}`)}</dt>
            <dd style={{ margin: 0 }}>
              <kbd
                style={{
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 13,
                  padding: '2px 8px',
                  borderRadius: 6,
                  border: `1px solid ${token('border')}`,
                  background: token('surface'),
                  color: token('text'),
                }}
              >
                {formatAccelerator(shortcut.accelerator, isMac)}
              </kbd>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
