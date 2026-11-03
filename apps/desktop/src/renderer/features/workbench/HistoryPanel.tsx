// Saved coordinator conversations: open one to continue it, or delete one (never the current
// one). Shown under the sidebar's conversation switcher.

import { useState, type CSSProperties } from 'react';
import { disabledOpacity, fontSize, radius, space, token } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useI18n, type Locale, type TranslateFn } from '../../i18n';
import { deleteConversation, openConversation } from '../../lib/workbenchStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import type { ConversationView } from '../../../shared/workbench';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

/**
 * A localized relative time ("2 hours ago", "刚刚") from `Intl.RelativeTimeFormat`, so the wording
 * needs no i18n entry (see SkillsHome). Null when the time is unknown.
 */
export function formatRelative(ms: number, locale: Locale): string | null {
  if (!ms) return null;
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < minute) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < hour) return rtf.format(Math.round(diff / minute), 'minute');
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
  return rtf.format(Math.round(diff / day), 'day');
}

/** Saved conversations: open one to continue it, or delete one (never the current one). */
export function HistoryPanel({
  conversations,
  canSwitch,
  t,
  run,
  onClose,
}: {
  conversations: readonly ConversationView[];
  canSwitch: boolean;
  t: TranslateFn;
  run: Runner;
  onClose: () => void;
}) {
  const { locale } = useI18n();
  const [confirmDelete, setConfirmDelete] = useState<ConversationView | null>(null);
  const [deleting, setDeleting] = useState(false);

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !confirmDelete) onClose();
      }}
      style={{
        borderBottom: `1px solid ${token('border')}`,
        background: token('surface'),
        flexShrink: 0,
        maxHeight: 260,
        overflowY: 'auto',
      }}
    >
      {conversations.length === 0 ? (
        <p style={{ margin: 0, padding: space.lg, fontSize: fontSize.sm, color: token('textMuted') }}>{t('workbench.chat.historyEmpty')}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: space.xs }}>
          {conversations.map((c) => {
            const when = formatRelative(c.updatedAt, locale);
            return (
              <li key={c.id} style={{ display: 'flex', alignItems: 'center', gap: space.xs }}>
                <button
                  type="button"
                  aria-current={c.current || undefined}
                  disabled={!canSwitch && !c.current}
                  onClick={() => {
                    if (c.current) {
                      onClose();
                      return;
                    }
                    void run(() => openConversation(c.id)).then((ok) => {
                      if (ok) onClose();
                    });
                  }}
                  {...hoverBackground('transparent', token('surfaceHover'))}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: space.md,
                    padding: '6px 8px',
                    borderRadius: radius.sm,
                    border: 'none',
                    background: 'transparent',
                    color: token('text'),
                    textAlign: 'left',
                    cursor: canSwitch || c.current ? 'pointer' : 'default',
                    opacity: canSwitch || c.current ? 1 : disabledOpacity,
                    fontSize: fontSize.base,
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: c.current ? 600 : 400 }}>
                    {c.title || t('workbench.chat.untitled')}
                  </span>
                  {c.current && (
                    <span style={{ flexShrink: 0, fontSize: fontSize.xs, color: token('accent') }}>{t('workbench.chat.current')}</span>
                  )}
                  {when && <span style={{ flexShrink: 0, fontSize: fontSize.xs, color: token('textMuted') }}>{when}</span>}
                </button>
                {!c.current && (
                  <button
                    type="button"
                    aria-label={`${t('workbench.chat.delete')}: ${c.title || t('workbench.chat.untitled')}`}
                    title={t('workbench.chat.delete')}
                    onClick={() => setConfirmDelete(c)}
                    {...hoverBackground('transparent', token('surfaceHover'))}
                    style={chipCloseStyle}
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t('workbench.chat.deleteConfirm')}
          message={confirmDelete.title || t('workbench.chat.untitled')}
          confirmLabel={t('workbench.chat.delete')}
          cancelLabel={t('workbench.cancel')}
          danger
          busy={deleting}
          onConfirm={() => {
            setDeleting(true);
            void run(() => deleteConversation(confirmDelete.id)).then(() => {
              setDeleting(false);
              setConfirmDelete(null);
            });
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

const chipCloseStyle: CSSProperties = {
  display: 'inline-grid',
  placeItems: 'center',
  width: 20,
  height: 20,
  padding: 0,
  borderRadius: radius.pill,
  border: 'none',
  background: 'transparent',
  color: token('textMuted'),
  cursor: 'pointer',
  fontSize: fontSize.md,
  lineHeight: 1,
};
