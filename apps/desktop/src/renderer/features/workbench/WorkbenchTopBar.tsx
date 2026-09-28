import { useEffect, useState } from 'react';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { WORKBENCH_LIMITS, type FolderView, type TaskView, type WorkbenchSnapshot } from '../../../shared/workbench';
import { addFolder, installHerdr, removeFolder, updateWorkbenchSettings } from '../../lib/workbenchStore';

type Runner = (action: () => Promise<void>) => Promise<boolean>;

export function WorkbenchTopBar({
  wb,
  t,
  run,
  selectedTask,
}: {
  wb: WorkbenchSnapshot;
  t: TranslateFn;
  run: Runner;
  selectedTask: TaskView | null;
}) {
  const probe = wb.herdrProbe;
  const showInstall = !probe.remote && !probe.installed && wb.status !== 'error';
  const tasksBlocked =
    (wb.status === 'ready' && !wb.herdrAvailable) || (!probe.installed && wb.status === 'stopped');
  const on = wb.status === 'ready' || wb.status === 'starting';
  const dot =
    wb.status === 'ready' ? token('success') : wb.status === 'error' ? token('danger') : token('borderStrong');
  const statusLabel = t(`workbench.status.${wb.status}`);

  const needsEnvAttention =
    Boolean(wb.issue) ||
    showInstall ||
    (tasksBlocked && wb.status !== 'starting') ||
    wb.status === 'error' ||
    wb.folders.length === 0;

  const [envOpen, setEnvOpen] = useState(needsEnvAttention);
  const [savingSettings, setSavingSettings] = useState(false);
  const [sshDraft, setSshDraft] = useState(wb.settings.herdrSshTarget ?? '');
  useEffect(() => {
    if (needsEnvAttention) setEnvOpen(true);
  }, [needsEnvAttention]);
  useEffect(() => {
    setSshDraft(wb.settings.herdrSshTarget ?? '');
  }, [wb.settings.herdrSshTarget]);

  const attachCmd =
    wb.status === 'ready' && wb.herdrAvailable
      ? probe.remote
        ? `ssh ${wb.settings.herdrSshTarget} herdr --session ${wb.herdrSession}`
        : `herdr --session ${wb.herdrSession}`
      : null;

  const setSetting = (patch: {
    autoRun?: boolean;
    notifyCoordinator?: boolean;
    autoLaunchDependents?: boolean;
    herdrSshTarget?: string | null;
  }): void => {
    setSavingSettings(true);
    void run(() => updateWorkbenchSettings(patch)).finally(() => setSavingSettings(false));
  };

  const taskFolder = selectedTask ? (wb.folders.find((f) => f.id === selectedTask.folderId) ?? null) : null;
  const taskWorkspace = selectedTask
    ? selectedTask.worktreeDisplay ?? taskFolder?.name ?? t('workbench.tasks.noFolder')
    : null;
  const workspaceDisplay =
    taskWorkspace ??
    (wb.folders.length === 0
      ? t('workbench.tasks.noFolder')
      : wb.folders.length === 1
        ? wb.folders[0]!.name
        : wb.folders.map((f) => f.name).join(', '));

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: envOpen ? space.sm : 0,
        paddingBottom: envOpen ? space.sm : 0,
        borderBottom: `1px solid ${token('border')}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: space.sm,
          flexWrap: 'nowrap',
          minHeight: 28,
          fontSize: fontSize.xs,
          color: token('textMuted'),
          overflow: 'hidden',
        }}
      >
        <span title={statusLabel} aria-label={statusLabel} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: dot }} />
        </span>
        {wb.model && on && (
          <>
            <span
              title={`${wb.model.providerName} / ${wb.model.modelId}`}
              style={{
                flexShrink: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 140,
              }}
            >
              {t('workbench.model')} {wb.model.modelId}
            </span>
            <span aria-hidden style={{ color: token('borderStrong'), flexShrink: 0 }}>
              ·
            </span>
          </>
        )}
        <span
          title={taskFolder?.displayPath ?? selectedTask?.worktreeDisplay ?? t('workbench.folders.hint')}
          style={{
            flexShrink: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {t('workbench.tasks.activeWorkspace')}:{' '}
          <span style={{ color: token('text') }}>{workspaceDisplay}</span>
        </span>
        <FolderChips folders={wb.folders} t={t} run={run} />
        <span aria-hidden style={{ color: token('borderStrong'), flexShrink: 0 }}>
          ·
        </span>
        <AddFolderButton folders={wb.folders} t={t} run={run} />
        <span style={{ flex: 1, minWidth: 4 }} />
        <button
          type="button"
          aria-expanded={envOpen}
          onClick={() => setEnvOpen((v) => !v)}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={linkBtnStyle(needsEnvAttention)}
        >
          {t('workbench.environment.title')}
          <span aria-hidden style={{ opacity: 0.7 }}>{envOpen ? ' ▴' : ' ▾'}</span>
        </button>
      </div>
      {envOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space.sm, fontSize: fontSize.sm, color: token('textMuted'), paddingLeft: 2 }}>
          {wb.status === 'stopped' && <p style={{ margin: 0, fontSize: fontSize.sm }}>{t('workbench.subtitle')}</p>}
          {wb.issue && <p style={{ margin: 0, color: token('danger') }}>{t(`workbench.issue.${wb.issue}`)}</p>}
          {(probe.installed || probe.installing || showInstall) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.md }}>
              <span style={{ fontSize: fontSize.sm }}>
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
                  disabled={probe.installing || wb.status === 'starting'}
                  onClick={() => void run(installHerdr)}
                  {...hoverBackground(token('accent'), token('accentHover'))}
                  style={{
                    all: 'unset',
                    cursor: probe.installing ? 'default' : 'pointer',
                    fontSize: fontSize.xs,
                    fontWeight: 600,
                    padding: '3px 8px',
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
            <p style={{ margin: 0, fontSize: fontSize.xs }}>
              {t('workbench.attachHint')}{' '}
              <code style={{ fontSize: fontSize.xs, padding: '1px 4px', borderRadius: radius.sm, background: token('surface'), border: `1px solid ${token('border')}` }}>
                {attachCmd}
              </code>
            </p>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.lg, paddingTop: space.xs }}>
            <SettingToggle
              label={t('workbench.tasks.autoRun')}
              hint={t('workbench.tasks.autoRunHint')}
              checked={wb.settings.autoRun}
              disabled={savingSettings}
              onChange={(autoRun) => setSetting({ autoRun })}
            />
            <SettingToggle
              label={t('workbench.tasks.notify')}
              hint={t('workbench.tasks.notifyHint')}
              checked={wb.settings.notifyCoordinator}
              disabled={savingSettings}
              onChange={(notifyCoordinator) => setSetting({ notifyCoordinator })}
            />
            <SettingToggle
              label={t('workbench.tasks.autoLaunchDependents')}
              hint={t('workbench.tasks.autoLaunchDependentsHint')}
              checked={wb.settings.autoLaunchDependents}
              disabled={savingSettings}
              onChange={(autoLaunchDependents) => setSetting({ autoLaunchDependents })}
            />
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: fontSize.sm, color: token('textMuted'), maxWidth: 360 }}>
            {t('workbench.herdr.sshLabel')}
            <input
              type="text"
              value={sshDraft}
              disabled={savingSettings || wb.status === 'starting'}
              placeholder={t('workbench.herdr.sshPlaceholder')}
              onChange={(e) => setSshDraft(e.target.value)}
              onBlur={() => {
                const trimmed = sshDraft.trim();
                const next = trimmed === '' ? null : trimmed;
                if (next === wb.settings.herdrSshTarget) return;
                setSetting({ herdrSshTarget: next });
              }}
              style={{
                padding: '4px 8px',
                borderRadius: radius.sm,
                border: `1px solid ${token('borderStrong')}`,
                background: token('surface'),
                color: token('text'),
                fontSize: fontSize.sm,
              }}
            />
            <span style={{ fontSize: fontSize.xs }}>{t('workbench.herdr.sshHint')}</span>
          </label>
        </div>
      )}
    </section>
  );
}

function SettingToggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label title={hint} style={{ display: 'inline-flex', alignItems: 'center', gap: space.sm, fontSize: fontSize.sm, color: token('text') }}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-description={hint} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function linkBtnStyle(emphasize: boolean) {
  return {
    all: 'unset' as const,
    cursor: 'pointer',
    fontSize: fontSize.xs,
    color: emphasize ? token('accent') : token('textMuted'),
    padding: '2px 4px',
    borderRadius: radius.sm,
    flexShrink: 0,
  };
}

function FolderChips({ folders, t, run }: { folders: readonly FolderView[]; t: TranslateFn; run: Runner }) {
  if (folders.length === 0) return null;
  return (
    <div
      aria-label={t('workbench.folders.label')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        overflowX: 'auto',
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '28%',
        scrollbarGutter: 'stable',
      }}
    >
      {folders.map((f) => (
        <span
          key={f.id}
          title={f.displayPath}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 1,
            maxWidth: 88,
            padding: '0 2px 0 5px',
            borderRadius: radius.sm,
            background: token('surface'),
            fontSize: fontSize.xs,
            color: token('text'),
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
              width: 16,
              height: 16,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: token('textMuted'),
            }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

function AddFolderButton({
  folders,
  t,
  run,
}: {
  folders: readonly FolderView[];
  t: TranslateFn;
  run: Runner;
}) {
  const full = folders.length >= WORKBENCH_LIMITS.folders;
  const hint = full ? t('workbench.folders.label') : t('workbench.folders.add');
  return (
    <button
      type="button"
      aria-label={hint}
      title={t('workbench.folders.hint')}
      disabled={full}
      onClick={() => void run(addFolder)}
      {...hoverBackground(token('surface'), token('surfaceHover'))}
      style={{
        all: 'unset',
        boxSizing: 'border-box',
        cursor: full ? 'default' : 'pointer',
        width: 20,
        height: 20,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.sm,
        border: `1px solid ${token('borderStrong')}`,
        fontSize: fontSize.sm,
        lineHeight: 1,
        color: token('textMuted'),
        opacity: full ? 0.45 : 1,
      }}
    >
      +
    </button>
  );
}
