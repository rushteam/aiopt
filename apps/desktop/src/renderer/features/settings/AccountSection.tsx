// Account settings — sign in / sign out.
//
// Signed out: a minimal credential form. Signed in: the identity plus a sign-out
// button. All state comes from AuthContext (mirrored from main); the token never
// touches the renderer. The local stub accepts any non-empty credentials.

import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { token } from '../../themes/tokens';
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
        <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>{t('account.title')}</h2>
        <p style={{ margin: '0 0 16px', fontSize: 14 }}>
          {t('account.signedInAs')}{' '}
          <strong>{state.user?.displayName}</strong>
        </p>
        <button type="button" onClick={() => void logout()} style={buttonStyle('danger')}>
          {t('account.logOut')}
        </button>
      </section>
    );
  }

  return (
    <section>
      <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>{t('account.title')}</h2>
      <p style={{ margin: '0 0 16px', color: token('textMuted'), fontSize: 13 }}>
        {t('account.signedOutHelp')}
      </p>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 320 }}>
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
          <p role="alert" style={{ margin: 0, color: token('danger'), fontSize: 13 }}>
            {t('account.error')}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || username.trim() === '' || password.trim() === ''}
          style={buttonStyle('accent')}
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
  gap: 4,
  fontSize: 13,
  color: token('textMuted'),
} as const;

const inputStyle = {
  padding: '8px 10px',
  borderRadius: 6,
  border: `1px solid ${token('border')}`,
  background: token('bg'),
  color: token('text'),
  fontSize: 14,
} as const;

function buttonStyle(kind: 'accent' | 'danger') {
  return {
    padding: '8px 16px',
    borderRadius: 8,
    border: `1px solid ${token(kind)}`,
    background: kind === 'accent' ? token('accent') : 'transparent',
    color: kind === 'accent' ? token('accentText') : token('danger'),
    cursor: 'pointer',
    fontSize: 14,
    alignSelf: 'flex-start',
  } as const;
}
