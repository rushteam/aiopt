// Update settings — shows the current version + update status and a check button.
//
// Status is owned by main, which compares against the newest published GitHub Release.
// We read it once, subscribe to pushes, and reflect the in-flight `checking` state.
// Nothing here downloads or installs.

import { useEffect, useRef, useState } from 'react';
import type { UpdateStatus } from '../../../shared/ipc-channels';
import { disabledOpacity, token, fontSize, radius } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';

/** Main aborts the GitHub request at 15s. This is only a backstop so the button cannot stay busy. */
const CHECK_UI_TIMEOUT_MS = 20_000;

export function UpdateSection() {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  useEffect(() => {
    let sawPush = false;
    const unsubscribe = window.aiopt.update.onStatusChanged((next) => {
      sawPush = true;
      setStatus(next);
    });
    void window.aiopt.update.getStatus().then((next) => {
      // A click, or a push that arrived first, is newer than this snapshot.
      if (!sawPush && !pendingRef.current) setStatus(next);
    });
    return unsubscribe;
  }, []);

  async function runCheck(): Promise<void> {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setStatus((current) =>
      current ? { state: 'checking', currentVersion: current.currentVersion } : current,
    );
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      pendingRef.current = false;
      setPending(false);
      setStatus((current) =>
        current && current.state === 'checking'
          ? { state: 'error', currentVersion: current.currentVersion }
          : current,
      );
    }, CHECK_UI_TIMEOUT_MS);
    try {
      await window.aiopt.update.check();
    } catch {
      if (!settled) {
        setStatus((current) =>
          current ? { state: 'error', currentVersion: current.currentVersion } : current,
        );
      }
    } finally {
      if (!settled) {
        settled = true;
        window.clearTimeout(timer);
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  const checking = pending || status?.state === 'checking';

  return (
    <section>
      <h2 style={{ margin: '0 0 16px', fontSize: fontSize['2xl'] }}>{t('updates.title')}</h2>
      <p style={{ margin: '0 0 8px', fontSize: fontSize.md }}>
        {t('updates.currentVersion')}{' '}
        <strong style={{ fontFamily: 'ui-monospace, monospace' }}>
          {status?.currentVersion ?? '…'}
        </strong>
      </p>
      <p
        style={{
          margin: '0 0 16px',
          color: checking ? token('text') : token('textMuted'),
          fontSize: fontSize.base,
        }}
      >
        {t(`updates.state.${status?.state ?? 'idle'}`)}
        {status?.state === 'update-available' && status.nextVersion
          ? ` (${status.nextVersion})`
          : ''}
      </p>
      <button
        type="button"
        onClick={() => void runCheck()}
        disabled={checking}
        aria-busy={checking}
        {...hoverBackground(token('surface'), token('surfaceHover'))}
        style={{
          padding: '8px 16px',
          borderRadius: radius.md,
          border: `1px solid ${token('borderStrong')}`,
          background: token('surface'),
          color: token('text'),
          cursor: checking ? 'default' : 'pointer',
          opacity: checking ? disabledOpacity : 1,
          fontSize: fontSize.md,
        }}
      >
        {checking ? t('updates.checking') : t('updates.check')}
      </button>
    </section>
  );
}
