// Keyboard-shortcuts settings — view AND rebind the app shortcuts.
//
// This is the renderer half of the customization chain: it records a keystroke,
// pre-validates it with the SAME shared/appShortcuts + keyboardReserved code main
// uses (bindable / system-reserved / cross-shortcut conflict), and persists the
// rebind through the bridge — main re-validates before it touches disk, so the
// renderer's checks are a UX convenience, never the authority. The list re-renders
// from the shared store, so a change here (or in another window, via the push)
// updates the displayed combos and the native menu together.
//
// While recording, `body.dataset.appShortcutRecording` is set and main is told to
// unregister menu accelerators, so capturing e.g. ⌘, doesn't also open Settings.

import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import {
  APP_SHORTCUT_DEFINITIONS,
  createAppShortcutComboFromEvent,
  findAppShortcutConflict,
  formatAppShortcutCombo,
  getAppShortcutDefinition,
  isAppShortcutAvailableOnPlatform,
  isAppShortcutComboBindable,
  type AppShortcutId,
} from '../../../shared/appShortcuts';
import { isSystemReservedShortcut } from '../../../shared/keyboardReserved';
import {
  clearAppShortcutOverride,
  getAppShortcutOverrides,
  getAppShortcutPlatform,
  getAppShortcutStoreVersion,
  getEffectiveCombosFor,
  resetAllAppShortcuts,
  setAppShortcutOverride,
  subscribeAppShortcutStore,
} from '../../lib/appShortcutStore';
import { token } from '../../themes/tokens';
import { useT, type TranslateFn } from '../../i18n';

function platformFamily(platform: string): 'mac' | 'windows' | 'other' {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'windows';
  return 'other';
}

export function ShortcutsSection() {
  const t = useT();
  // Re-render whenever the shared store's effective table changes.
  useSyncExternalStore(subscribeAppShortcutStore, getAppShortcutStoreVersion);
  const platform = getAppShortcutPlatform();
  const overrides = getAppShortcutOverrides();

  const [recordingId, setRecordingId] = useState<AppShortcutId | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The recording session: install a capture listener, flag the gate, and tell
  // main to pause menu accelerators. Everything unwinds when recordingId clears.
  useEffect(() => {
    if (!recordingId) return;
    const id = recordingId;
    document.body.dataset.appShortcutRecording = '1';
    window.hearth.appShortcuts.setRecording(true);

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      // Escape (no modifiers) cancels the capture.
      if (
        event.code === 'Escape' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        setRecordingId(null);
        return;
      }
      const combo = createAppShortcutComboFromEvent(event);
      if (!combo) return; // pure modifier — wait for the main key
      if (!isAppShortcutComboBindable(combo)) {
        setError('shortcuts.errors.notBindable');
        return;
      }
      if (isSystemReservedShortcut(combo, platformFamily(platform))) {
        setError('shortcuts.errors.systemReserved');
        return;
      }
      const conflictId = findAppShortcutConflict(id, combo, overrides, platform);
      if (conflictId) {
        setError('shortcuts.errors.conflict');
        return;
      }
      void setAppShortcutOverride(id, combo).catch(() => setError('shortcuts.errors.saveFailed'));
      setRecordingId(null);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      delete document.body.dataset.appShortcutRecording;
      window.hearth.appShortcuts.setRecording(false);
    };
  }, [recordingId, platform, overrides]);

  const startRecording = (id: AppShortcutId) => {
    setError(null);
    setRecordingId(id);
  };

  const disable = (id: AppShortcutId) => {
    setError(null);
    void setAppShortcutOverride(id, null).catch(() => setError('shortcuts.errors.saveFailed'));
  };

  const reset = (id: AppShortcutId) => {
    setError(null);
    void clearAppShortcutOverride(id).catch(() => setError('shortcuts.errors.saveFailed'));
  };

  const definitions = APP_SHORTCUT_DEFINITIONS.filter(
    (def) => !def.hiddenInSettings && isAppShortcutAvailableOnPlatform(def.id, platform),
  );
  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <section>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          margin: '0 0 16px',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>{t('shortcuts.title')}</h2>
        {hasOverrides && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              void resetAllAppShortcuts().catch(() => setError('shortcuts.errors.saveFailed'));
            }}
            style={ghostButtonStyle()}
          >
            {t('shortcuts.resetAll')}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {definitions.map((def) => (
          <ShortcutRow
            key={def.id}
            id={def.id}
            t={t}
            platform={platform}
            recording={recordingId === def.id}
            overridden={def.id in overrides}
            error={recordingId === def.id ? error : null}
            onRecord={() => startRecording(def.id)}
            onDisable={() => disable(def.id)}
            onReset={() => reset(def.id)}
          />
        ))}
      </div>
    </section>
  );
}

interface ShortcutRowProps {
  id: AppShortcutId;
  t: TranslateFn;
  platform: string;
  recording: boolean;
  overridden: boolean;
  error: string | null;
  onRecord: () => void;
  onDisable: () => void;
  onReset: () => void;
}

function ShortcutRow({
  id,
  t,
  platform,
  recording,
  overridden,
  error,
  onRecord,
  onDisable,
  onReset,
}: ShortcutRowProps) {
  const def = getAppShortcutDefinition(id);
  const combos = getEffectiveCombosFor(id);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '10px 12px',
        borderRadius: 8,
        border: `1px solid ${token('border')}`,
        background: token('surface'),
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14 }}>{t(def.labelKey)}</div>
        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>{t(def.descriptionKey)}</div>
        {recording && (
          <div style={{ fontSize: 12, marginTop: 4, color: token('accent') }}>
            {error ? t(error) : t('shortcuts.recording')}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {recording ? (
          <kbd style={comboStyle()}>{t('shortcuts.recordingHint')}</kbd>
        ) : combos.length > 0 ? (
          combos.map((combo, i) => (
            <kbd key={i} style={comboStyle()}>
              {formatAppShortcutCombo(combo, platform)}
            </kbd>
          ))
        ) : (
          <span style={{ fontSize: 13, opacity: 0.5 }}>{t('shortcuts.none')}</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" onClick={onRecord} style={ghostButtonStyle()}>
          {t('shortcuts.edit')}
        </button>
        {combos.length > 0 && (
          <button type="button" onClick={onDisable} style={ghostButtonStyle()}>
            {t('shortcuts.disable')}
          </button>
        )}
        {overridden && (
          <button type="button" onClick={onReset} style={ghostButtonStyle()}>
            {t('shortcuts.reset')}
          </button>
        )}
      </div>
    </div>
  );
}

function comboStyle(): CSSProperties {
  return {
    fontFamily: 'ui-monospace, monospace',
    fontSize: 13,
    padding: '2px 8px',
    borderRadius: 6,
    border: `1px solid ${token('border')}`,
    background: token('bg'),
    color: token('text'),
    whiteSpace: 'nowrap',
  };
}

function ghostButtonStyle(): CSSProperties {
  return {
    padding: '4px 10px',
    borderRadius: 6,
    border: `1px solid ${token('border')}`,
    background: 'transparent',
    color: token('text'),
    cursor: 'pointer',
    fontSize: 13,
    whiteSpace: 'nowrap',
  };
}
