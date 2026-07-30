// IPC channel allowlist + payload/result types.
//
// Every channel is declared here, once, as the single source of truth shared by
// the preload bridge, the main handlers, and the tests. The preload never lets
// the renderer choose an arbitrary channel (see the security rule §4); it may
// only call the named bridge methods that map to these channels.

/** The exhaustive set of invoke channels the app exposes (renderer → main). */
export const IPC_CHANNELS = {
  /** Diagnostics round-trip that exercises the full authorization path. */
  ping: 'app:ping',

  // Preferences (layered config store). Reads return the *effective* snapshot
  // (defaults merged with the user's overrides); writes persist only overrides.
  configGetAll: 'config:get-all',
  configSet: 'config:set',
  configReset: 'config:reset',

  // Secret store (OS-encrypted). The renderer may store / check / clear a
  // secret, but there is NO channel that returns a secret's plaintext to the
  // renderer — decryption is main-only. See credentials-and-local-storage.md.
  secretSet: 'secret:set',
  secretHas: 'secret:has',
  secretDelete: 'secret:delete',

  // App info. Version strings for the About page / diagnostics footer.
  appGetVersions: 'app:get-versions',

  // Auth. The renderer drives login/logout and reads the SAFE session state
  // (status + non-secret user identity). The session TOKEN is minted and stored
  // in main only — no channel ever returns it to the renderer. See
  // credentials-and-local-storage.md.
  authGetState: 'auth:get-state',
  authLogin: 'auth:login',
  authLogout: 'auth:logout',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * Synchronous channels (renderer → main, blocking `sendSync`). Used ONLY for the
 * tiny, must-happen-before-first-paint theme read — a blocking round-trip is the
 * price of preventing a wrong-theme flash. Everything else is async `invoke`.
 */
export const IPC_SYNC_CHANNELS = {
  /** Read the stored theme preference synchronously for the first paint. */
  themeGet: 'config:get-theme-sync',
} as const;

/**
 * Push channels (main → renderer). These are one-way notifications; the renderer
 * subscribes via a named preload method and never invokes them. Payloads must
 * carry NO secret material — they may reach any window.
 */
export const IPC_EVENTS = {
  /** The effective preferences changed; payload is the new snapshot. */
  configChanged: 'config:changed',
  /**
   * A native application-menu item was activated; payload is a `MenuCommand`
   * string (see shared/menuCommands.ts). One-way main → renderer so the UI
   * (e.g. open Settings) reacts to the OS menu. The renderer re-validates the
   * command against the allowlist before acting.
   */
  menuCommand: 'app:menu-command',
  /**
   * The auth session changed; payload is the SAFE `AuthState` (status + user
   * identity, never a token). Pushed after login / logout / startup restore so
   * every window mirrors the current session.
   */
  authStateChanged: 'auth:state-changed',
} as const;

export type IpcEvent = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS];

// ---------------------------------------------------------------------------
// Shared wire-contract types (used by both preload and main).
// ---------------------------------------------------------------------------

/** The theme the user prefers; `system` follows the OS. */
export type ThemePreference = 'system' | 'light' | 'dark';

/**
 * The typed set of user preferences. This is the wire contract; the runtime
 * defaults + validators live in main/config/configStore.ts (validation is the
 * privileged process's job — TS types are not runtime validation).
 */
export interface PreferencesShape {
  theme: ThemePreference;
}

// Per-channel request/result contracts. Adding a channel means adding its entry
// to IPC_CHANNELS and its request/result types here, then wiring the handler and
// the preload method together.

export interface PingRequest {
  message: string;
}

export interface PingResult {
  reply: string;
  at: number;
}

export interface ConfigSetRequest {
  key: keyof PreferencesShape;
  value: unknown;
}

export interface ConfigResetRequest {
  key: keyof PreferencesShape;
}

export interface SecretSetRequest {
  key: string;
  value: string;
}

export interface SecretKeyRequest {
  key: string;
}

export interface SecretHasResult {
  present: boolean;
}

/** Version strings surfaced on the About page. `app` is the framework app version. */
export interface AppVersionsResult {
  app: string;
  electron: string;
  chrome: string;
  node: string;
}

// --- Auth wire contract ---------------------------------------------------
//
// The renderer only ever sees these SAFE shapes. The session token is a secret
// that lives in the main-side secret store and never crosses IPC.

export type AuthStatus = 'signed-out' | 'signed-in';

/** Non-secret identity safe to show in the UI and broadcast to every window. */
export interface AuthUser {
  id: string;
  displayName: string;
}

/** The renderer-visible session state. Deliberately carries NO token. */
export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
}

/** Login credentials collected by the renderer and handed to main to exchange. */
export interface AuthLoginRequest {
  username: string;
  password: string;
}

export interface IpcContract {
  [IPC_CHANNELS.ping]: { request: PingRequest; result: PingResult };
  [IPC_CHANNELS.configGetAll]: { request: void; result: PreferencesShape };
  [IPC_CHANNELS.configSet]: { request: ConfigSetRequest; result: PreferencesShape };
  [IPC_CHANNELS.configReset]: { request: ConfigResetRequest; result: PreferencesShape };
  [IPC_CHANNELS.secretSet]: { request: SecretSetRequest; result: Record<string, never> };
  [IPC_CHANNELS.secretHas]: { request: SecretKeyRequest; result: SecretHasResult };
  [IPC_CHANNELS.secretDelete]: { request: SecretKeyRequest; result: Record<string, never> };
  [IPC_CHANNELS.appGetVersions]: { request: void; result: AppVersionsResult };
  [IPC_CHANNELS.authGetState]: { request: void; result: AuthState };
  [IPC_CHANNELS.authLogin]: { request: AuthLoginRequest; result: AuthState };
  [IPC_CHANNELS.authLogout]: { request: void; result: AuthState };
}
