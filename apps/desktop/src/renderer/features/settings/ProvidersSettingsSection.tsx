// Providers settings — virtual pool entries that should not appear as editable cards.

import { token, fontSize, radius, space } from '../../themes/tokens';
import { useT } from '../../i18n';
import { HelpHint } from '../../components/ui/HelpHint';
import { useProviders } from '../../hooks/useProviders';
import { isCombinedProviderId } from '../../../shared/combinedProvider';

export function ProvidersSettingsSection() {
  const t = useT();
  const { providers } = useProviders();
  const combined = providers.find((p) => isCombinedProviderId(p.id));
  const enabled = combined !== undefined;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: space.lg, maxWidth: 520 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
          <h2 style={{ margin: 0, fontSize: fontSize['2xl'], fontWeight: 600 }}>
            {t('providers.combined.name')}
          </h2>
          <HelpHint label={t('providers.combined.helpTooltip')} />
        </div>
        <p style={{ margin: 0, color: token('textMuted'), fontSize: fontSize.base, lineHeight: 1.45 }}>
          {t('providers.combined.description')}
        </p>
      </div>
      <div
        style={{
          padding: space.md,
          borderRadius: radius.md,
          border: `1px solid ${token('border')}`,
          background: token('surface'),
          fontSize: fontSize.sm,
          color: token('textMuted'),
        }}
      >
        {enabled ? (
          <p style={{ margin: 0 }}>
            {t('providers.combined.settingsStatus').replace('{{count}}', String(combined!.models.length))}
          </p>
        ) : (
          <p style={{ margin: 0 }}>{t('providers.combined.settingsDisabled')}</p>
        )}
      </div>
    </section>
  );
}
