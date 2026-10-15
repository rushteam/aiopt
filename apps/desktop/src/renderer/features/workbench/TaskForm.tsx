// The task form (title, prompt, where it runs, and — for a plan node — what it waits on) and
// the folder picker it uses. Shared by the task board and the plan's node detail.

import { useRef, useState, type CSSProperties } from 'react';
import { disabledOpacity, token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import type { TranslateFn } from '../../i18n';
import { CheckboxField } from '../../components/ui/Checkbox';
import { Select } from '../../components/ui/Select';
import { WORKBENCH_LIMITS, type FolderView } from '../../../shared/workbench';
import { useMentionPicker, useMentionSource } from './mentionPicker';

export interface Draft {
  title: string;
  prompt: string;
  folderId: string | null;
  isolated: boolean;
  /** Edited only when the form is given `dependencyChoices`. */
  dependsOn?: string[];
}

export function TaskForm({
  t,
  folders,
  initial,
  submitLabel,
  lockPlace = false,
  dependencyChoices,
  onSubmit,
  onCancel,
}: {
  t: TranslateFn;
  folders: readonly FolderView[];
  initial: Draft;
  submitLabel: string;
  /** The task already has a worktree, so where it runs can't change. */
  lockPlace?: boolean;
  /** Other tasks of the same plan this one may wait on (main rejects a cycle). */
  dependencyChoices?: readonly { id: string; title: string }[];
  onSubmit: (draft: Draft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // `@` in the prompt picks a session; its excerpt is attached when the worker starts.
  const picker = useMentionPicker({
    mentions: useMentionSource(t),
    draft: draft.prompt,
    setDraft: (prompt) => setDraft((d) => ({ ...d, prompt })),
    maxLength: WORKBENCH_LIMITS.taskPrompt,
    textRef: promptRef,
    placement: 'inline',
  });
  const valid = draft.title.trim() !== '' && draft.prompt.trim() !== '';
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || saving) return;
        setSaving(true);
        void onSubmit({ ...draft, title: draft.title.trim(), prompt: draft.prompt.trim() }).finally(() => setSaving(false));
      }}
      style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: space.md }}
    >
      <label style={fieldStyle}>
        <span style={labelStyle}>{t('workbench.tasks.titleLabel')}</span>
        <input
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          maxLength={WORKBENCH_LIMITS.taskTitle}
          style={inputStyle}
        />
      </label>
      <label style={fieldStyle}>
        <span style={labelStyle}>{t('workbench.tasks.promptLabel')}</span>
        <textarea
          ref={promptRef}
          value={draft.prompt}
          onChange={(e) => {
            setDraft({ ...draft, prompt: e.target.value });
            picker.sync(e.target);
          }}
          onKeyDown={(e) => {
            picker.onKeyDown(e);
          }}
          {...picker.textareaProps}
          maxLength={WORKBENCH_LIMITS.taskPrompt}
          rows={5}
          placeholder={t('workbench.tasks.promptPlaceholder')}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
        />
        {picker.menu}
        <span style={{ fontSize: fontSize.xs, color: token('textMuted') }}>{t('workbench.tasks.promptHint')}</span>
      </label>
      {!lockPlace && (
        <PlacePicker
          t={t}
          folders={folders}
          folderId={draft.folderId}
          isolated={draft.isolated}
          onChange={(folderId, isolated) => setDraft({ ...draft, folderId, isolated })}
        />
      )}
      {dependencyChoices && dependencyChoices.length > 0 && (
        <fieldset style={{ ...fieldStyle, margin: 0, padding: 0, border: 'none', minWidth: 0 }}>
          <legend style={{ ...labelStyle, padding: 0, marginBottom: space.xs }}>{t('workbench.plan.dependsOn')}</legend>
          {dependencyChoices.map((choice) => {
            const checked = (draft.dependsOn ?? []).includes(choice.id);
            return (
              <CheckboxField
                key={choice.id}
                label={choice.title}
                checked={checked}
                onChange={(next) => {
                  const current = draft.dependsOn ?? [];
                  setDraft({
                    ...draft,
                    dependsOn: next ? [...current, choice.id] : current.filter((id) => id !== choice.id),
                  });
                }}
                style={{ fontSize: fontSize.sm }}
              />
            );
          })}
        </fieldset>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: space.md }}>
        <button type="button" onClick={onCancel} {...hoverBackground('transparent', token('surfaceHover'))} style={smallGhostStyle}>
          {t('workbench.cancel')}
        </button>
        <button
          type="submit"
          disabled={!valid || saving}
          {...hoverBackground(token('accent'), token('accentHover'))}
          style={{ ...smallAccentStyle, opacity: !valid || saving ? disabledOpacity : 1 }}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** The folder select + the "own worktree" switch (only offered for a git folder). */
export function PlacePicker({
  t,
  folders,
  folderId,
  isolated,
  disabled = false,
  onChange,
}: {
  t: TranslateFn;
  folders: readonly FolderView[];
  folderId: string | null;
  isolated: boolean;
  disabled?: boolean;
  onChange: (folderId: string | null, isolated: boolean) => void;
}) {
  const folder = folders.find((f) => f.id === folderId) ?? null;
  const canIsolate = folder?.isGitRepo === true;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: space.lg, flexWrap: 'wrap' }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: space.sm, minWidth: 0 }}>
        <span style={labelStyle}>{t('workbench.tasks.folderLabel')}</span>
        <Select
          value={folder?.id ?? ''}
          disabled={disabled}
          size="sm"
          style={{ maxWidth: 220 }}
          onChange={(value) => {
            const next = folders.find((f) => f.id === value) ?? null;
            onChange(next?.id ?? null, next?.isGitRepo ? isolated : false);
          }}
          options={[
            { value: '', label: t('workbench.tasks.noFolder') },
            ...folders.map((f) => ({ value: f.id, label: f.name })),
          ]}
        />
      </label>
      <CheckboxField
        title={canIsolate ? undefined : t('workbench.tasks.isolatedUnavailable')}
        label={t('workbench.tasks.isolated')}
        checked={isolated && canIsolate}
        disabled={disabled || !canIsolate}
        onChange={(next) => onChange(folderId, next)}
        style={{ fontSize: fontSize.sm }}
      />
    </div>
  );
}

const cardStyle: CSSProperties = {
  border: `1px solid ${token('border')}`,
  borderRadius: radius.md,
  background: token('surface'),
  padding: space.lg,
};
const fieldStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: space.xs };
const labelStyle: CSSProperties = { fontSize: fontSize.sm, fontWeight: 600, color: token('textMuted') };
const inputStyle: CSSProperties = {
  padding: '8px 10px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: token('bg'),
  color: token('text'),
  fontSize: fontSize.md,
};
const smallAccentStyle: CSSProperties = {
  padding: '4px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('accent')}`,
  background: token('accent'),
  color: token('accentText'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
};
const smallGhostStyle: CSSProperties = {
  padding: '4px 12px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.sm,
};
