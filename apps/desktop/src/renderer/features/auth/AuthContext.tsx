// AuthContext — mirrors the main-owned session state in the renderer.
//
// The renderer never holds the token; it only reflects the SAFE state pushed
// from main. On mount it reads the current state once, then subscribes to the
// `auth:state-changed` broadcast so login/logout in any window (or a startup
// restore) keeps every window in sync.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthState } from '../../../shared/ipc-channels';

const SIGNED_OUT: AuthState = { status: 'signed-out', user: null };

interface AuthContextValue {
  state: AuthState;
  /** Resolves once the session state has been applied; rejects on bad credentials. */
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(SIGNED_OUT);

  useEffect(() => {
    let active = true;
    void window.hearth.auth.getState().then((s) => {
      if (active) setState(s);
    });
    const unsubscribe = window.hearth.auth.onStateChanged((s) => setState(s));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setState(await window.hearth.auth.login(username, password));
  }, []);

  const logout = useCallback(async () => {
    setState(await window.hearth.auth.logout());
  }, []);

  const value = useMemo<AuthContextValue>(() => ({ state, login, logout }), [state, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
