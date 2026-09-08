// Account settings — sign in / sign out.
//
// Signed out: a minimal credential form. Signed in: the identity plus a sign-out
// button. All state comes from AuthContext (mirrored from main); the token never
// touches the renderer. The local stub accepts any non-empty credentials.

import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';

export function AccountSection() {
  const t = useT();
  const { state, login, logout } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFailed(false);
    try {
      await login(username, password);
      setPassword('');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (state.status === 'signed-in') {
    return (
      <section>
        <h2 style={{ margin: '0 0 16px', fontSize: fontSize['2xl'] }}>{t('account.title')}</h2>
        <p style={{ margin: '0 0 16px', fontSize: fontSize.md }}>
          {t('account.signedInAs')}{' '}
          <strong>{state.user?.displayName}</strong>
        </p>
        <button
          type="button"
          onClick={() => void logout()}
          {...hoverBackground('transparent', token('surfaceHover'))}
          style={buttonStyle('danger')}
        >
          {t('account.logOut')}
        </button>
      </section>
    );
  }

  return (
    <section>
      <h2 style={{ margin: '0 0 4px', fontSize: fontSize['2xl'] }}>{t('account.title')}</h2>
      <p style={{ margin: '0 0 16px', color: token('textMuted'), fontSize: fontSize.base }}>
        {t('account.signedOutHelp')}
      </p>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: space.lg, maxWidth: 320 }}>
        <label style={fieldStyle}>
          {t('account.username')}
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            style={inputStyle}
          />
        </label>
        <label style={fieldStyle}>
          {t('account.password')}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            style={inputStyle}
          />
        </label>
        {failed && (
          <p role="alert" style={{ margin: 0, color: token('danger'), fontSize: fontSize.base }}>
            {t('account.error')}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || username.trim() === '' || password.trim() === ''}
          {...hoverBackground(token('accent'), token('accentHover'))}
          style={{
            ...buttonStyle('accent'),
            opacity: busy || username.trim() === '' || password.trim() === '' ? 0.5 : 1,
          }}
        >
          {busy ? t('account.loggingIn') : t('account.logIn')}
        </button>
      </form>
    </section>
  );
}

const fieldStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.xs,
  fontSize: fontSize.base,
  color: token('textMuted'),
} as const;

const inputStyle = {
  padding: '8px 10px',
  borderRadius: radius.sm,
  border: `1px solid ${token('border')}`,
  background: token('surface'),
  color: token('text'),
  fontSize: fontSize.md,
} as const;

function buttonStyle(kind: 'accent' | 'danger') {
  return {
    padding: '8px 16px',
    borderRadius: radius.md,
    border: `1px solid ${token(kind)}`,
    background: kind === 'accent' ? token('accent') : 'transparent',
    color: kind === 'accent' ? token('accentText') : token('danger'),
    cursor: 'pointer',
    fontSize: fontSize.md,
    alignSelf: 'flex-start',
  } as const;
}
