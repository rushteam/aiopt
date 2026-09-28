import { useEffect, useState } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { WORKBENCH_LIMITS, type FolderView, type WorkbenchSnapshot } from '../../../shared/workbench';
import { addFolder, installHerdr, removeFolder } from '../../lib/workbenchStore';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

const panelStyle = {
  border: `1px solid ${token('border')}`,
  borderRadius: radius.lg,
  background: token('surface'),
};

export function WorkbenchTopBar({
  wb,
  t,
  busy,
  run,
  onToggle,
}: {
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  busy: boolean;
  run: Runner;
  onToggle: () => void;
}) {
  const probe = wb.herdrProbe;
  const showInstall = !probe.remote && !probe.installed && wb.status !== 'error';
  const tasksBlocked =
    (wb.status === 'ready' && !wb.herdrAvailable) || (!probe.installed && wb.status === 'stopped');
  const on = wb.status === 'ready' || wb.status === 'starting';
  const dot =
    wb.status === 'ready' ? token('success') : wb.status === 'error' ? token('danger') : token('borderStrong');

  const needsEnvAttention =
    Boolean(wb.issue) || showInstall || (tasksBlocked && wb.status !== 'starting') || wb.status === 'error';

  const [envOpen, setEnvOpen] = useState(needsEnvAttention);
  useEffect(() => {
    if (needsEnvAttention) setEnvOpen(true);
  }, [needsEnvAttention]);

  const attachCmd =
    wb.status === 'ready' && wb.herdrAvailable
      ? probe.remote
        ? `ssh ${wb.settings.herdrSshTarget} herdr --session ${wb.herdrSession}`
        : `herdr --session ${wb.herdrSession}`
      : null;

  return (
    <section style={{ ...panelStyle, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: space.sm }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'nowrap', minHeight: 32 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: space.sm,
            fontSize: fontSize.sm,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0 }} />
          {t(`workbench.status.${wb.status}`)}
        </span>
        {wb.model && (
          <span
            title={`${wb.model.providerName} / ${wb.model.modelId}`}
            style={{
              fontSize: fontSize.xs,
              color: token('textMuted'),
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 200,
              flexShrink: 1,
              minWidth: 0,
            }}
          >
            {wb.model.modelId}
            {' · '}
            {wb.model.proxied ? t('workbench.proxied') : t('workbench.direct')}
          </span>
        )}
        <FolderChips folders={wb.folders} t={t} run={run} />
        <span style={{ flex: 1, minWidth: 8 }} />
        <button
          type="button"
          aria-expanded={envOpen}
          onClick={() => setEnvOpen((v) => !v)}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={{
            all: 'unset',
            cursor: 'pointer',
            fontSize: fontSize.sm,
            color: needsEnvAttention ? token('accent') : token('textMuted'),
            padding: '4px 8px',
            borderRadius: radius.sm,
            border: `1px solid ${token('borderStrong')}`,
            flexShrink: 0,
          }}
        >
          {t('workbench.environment.title')}
        </button>
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          {...(on
            ? hoverBackground('transparent', token('surfaceHover'))
            : hoverBackground(token('accent'), token('accentHover')))}
          style={{
            all: 'unset',
            cursor: busy ? 'default' : 'pointer',
            fontSize: fontSize.sm,
            fontWeight: 600,
            padding: '6px 14px',
            borderRadius: radius.sm,
            border: on ? `1px solid ${token('borderStrong')}` : 'none',
            background: on ? 'transparent' : token('accent'),
            color: on ? token('text') : token('accentText'),
            opacity: busy ? 0.5 : 1,
            flexShrink: 0,
          }}
        >
          {on ? t('workbench.stop') : t('workbench.start')}
        </button>
      </div>
      {envOpen && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: space.sm,
            paddingTop: space.xs,
            borderTop: `1px solid ${token('border')}`,
            fontSize: fontSize.sm,
            color: token('textMuted'),
          }}
        >
          {wb.status === 'stopped' && <p style={{ margin: 0 }}>{t('workbench.subtitle')}</p>}
          {wb.issue && <p style={{ margin: 0, color: token('danger') }}>{t(`workbench.issue.${wb.issue}`)}</p>}
          {(probe.installed || probe.installing || showInstall) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.md }}>
              <span>
                {probe.remote
                  ? t('workbench.herdr.remote').replace('{{target}}', probe.displayPath ?? '')
                  : probe.installed
                    ? t('workbench.herdr.local')
                        .replace('{{version}}', probe.version ?? '—')
                        .replace('{{path}}', probe.displayPath ?? '')
                    : t('workbench.herdr.notFound')}
              </span>
              {showInstall && (
                <button
                  type="button"
                  disabled={probe.installing || busy}
                  onClick={() => void run(installHerdr)}
                  {...hoverBackground(token('accent'), token('accentHover'))}
                  style={{
                    all: 'unset',
                    cursor: probe.installing ? 'default' : 'pointer',
                    fontSize: fontSize.sm,
                    fontWeight: 600,
                    padding: '4px 10px',
                    borderRadius: radius.sm,
                    background: token('accent'),
                    color: token('accentText'),
                    opacity: probe.installing ? 0.6 : 1,
                  }}
                >
                  {probe.installing ? t('workbench.herdr.installing') : t('workbench.herdr.install')}
                </button>
              )}
            </div>
          )}
          {tasksBlocked && wb.status !== 'starting' && <p style={{ margin: 0 }}>{t('workbench.herdrMissing')}</p>}
          {attachCmd && (
            <p style={{ margin: 0 }}>
              {t('workbench.attachHint')}{' '}
              <code
                style={{
                  fontSize: fontSize.xs,
                  padding: '1px 4px',
                  borderRadius: radius.sm,
                  background: token('bg'),
                  border: `1px solid ${token('border')}`,
                }}
              >
                {attachCmd}
              </code>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function FolderChips({ folders, t, run }: { folders: readonly FolderView[]; t: TranslateFn; run: Runner }) {
  const folderHint = t('workbench.folders.hint');
  return (
    <div
      aria-label={t('workbench.folders.label')}
      title={folderHint}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: space.xs,
        overflowX: 'auto',
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '42%',
        scrollbarGutter: 'stable',
      }}
    >
      {folders.length === 0 && (
        <span style={{ fontSize: fontSize.xs, color: token('textMuted'), whiteSpace: 'nowrap' }}>{t('workbench.folders.empty')}</span>
      )}
      {folders.map((f) => (
        <span
          key={f.id}
          title={f.displayPath}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            maxWidth: 140,
            padding: '1px 2px 1px 8px',
            borderRadius: radius.pill,
            border: `1px solid ${token('border')}`,
            background: token('bg'),
            fontSize: fontSize.xs,
            flexShrink: 0,
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
          <button
            type="button"
            aria-label={`${t('workbench.folders.remove')}: ${f.name}`}
            onClick={() => void run(() => removeFolder(f.id))}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={{
              all: 'unset',
              cursor: 'pointer',
              width: 20,
              height: 20,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.sm,
              color: token('textMuted'),
            }}
          >
            ×
          </button>
        </span>
      ))}
      <button
        type="button"
        title={folderHint}
        onClick={() => void run(addFolder)}
        disabled={folders.length >= WORKBENCH_LIMITS.folders}
        {...hoverBackground('transparent', token('surfaceHover'))}
        style={{
          all: 'unset',
          cursor: folders.length >= WORKBENCH_LIMITS.folders ? 'default' : 'pointer',
          fontSize: fontSize.xs,
          color: token('textMuted'),
          padding: '2px 8px',
          borderRadius: radius.pill,
          border: `1px dashed ${token('borderStrong')}`,
          whiteSpace: 'nowrap',
          flexShrink: 0,
          opacity: folders.length >= WORKBENCH_LIMITS.folders ? 0.5 : 1,
        }}
      >
        +
      </button>
    </div>
  );
}
