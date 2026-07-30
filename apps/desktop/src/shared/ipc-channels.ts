// IPC channel allowlist + payload/result types.
//
// Every channel is declared here, once, as the single source of truth shared by
// the preload bridge, the main handlers, and the tests. The preload never lets
// the renderer choose an arbitrary channel (see the security rule §4); it may
// only call the named bridge methods that map to these channels.

import type {
  AppShortcutCombo,
  AppShortcutId,
  AppShortcutOverrides,
} from './appShortcuts';

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

  // Updates. The renderer can read the current status and request a check; the
  // framework ships a local stub that always reports up-to-date. A REAL update
  // feed is a high-risk change gated by docs/dev-rules/updater.md.
  updateGetStatus: 'update:get-status',
  updateCheck: 'update:check',

  // App shortcuts. Write path for user rebinds. The renderer pre-validates, but
  // main re-validates every write (bindable / system-reserved / conflict) before
  // it touches disk — the effective binding is resolved on BOTH sides by the same
  // shared/appShortcuts code (see shortcuts get below), so they never drift.
  appShortcutsSetOverride: 'app-shortcuts:set-override',
  appShortcutsClearOverride: 'app-shortcuts:clear-override',
  appShortcutsResetAll: 'app-shortcuts:reset-all',
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
  /**
   * Read the app-shortcut overrides + platform synchronously, so the renderer's
   * shortcut store is populated on its first render (no flash of default combos
   * before an async round-trip resolves). Returns overrides + platform only —
   * never anything secret.
   */
  appShortcutsGet: 'app-shortcuts:get',
} as const;

/**
 * One-way renderer → main sends (no reply). Distinct from `invoke` (which returns
 * a value) and from push events (main → renderer). Used for the shortcut-recording
 * gate: while the settings page is capturing a keystroke, main must NOT let a
 * menu accelerator fire for that same keystroke.
 */
export const IPC_SEND_CHANNELS = {
  /**
   * Tell main the settings page started / stopped recording a new binding.
   * While active, main rebuilds the native menu with accelerators unregistered so
   * a captured keystroke never triggers a menu command. Reset automatically if the
   * sending window is destroyed mid-record.
   */
  appShortcutsSetRecording: 'app-shortcuts:set-recording',
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
  /** The update status changed (idle → checking → result); payload is `UpdateStatus`. */
  updateStatusChanged: 'update:status-changed',
  /**
   * The app-shortcut overrides changed (a rebind / reset in this or another
   * window); payload is `AppShortcutsChangedEvent`. Every window re-resolves its
   * effective combos from the same shared/appShortcuts code so they stay in step
   * with the native menu.
   */
  appShortcutsChanged: 'app-shortcuts:changed',
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

// --- Update wire contract -------------------------------------------------

export type UpdateState =
  | 'idle' // no check has run yet
  | 'checking' // a check is in flight
  | 'up-to-date'
  | 'update-available'
  | 'error';

/** The renderer-visible update status. `nextVersion` is set only when available. */
export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  nextVersion?: string;
}

// --- App-shortcut wire contract -------------------------------------------
//
// The renderer only ever sends/receives the OVERRIDE diff (see appShortcuts.ts):
// defaults live in the shared registry, resolved identically on both sides, so
// the wire never carries the effective table — only the user's changes.

/** Initial sync read: the persisted overrides + this platform (for combo resolution). */
export interface AppShortcutsGetResult {
  overrides: AppShortcutOverrides;
  platform: string;
}

/** Every write returns the new override set so the renderer store can replace its copy. */
export interface AppShortcutsMutationResult {
  overrides: AppShortcutOverrides;
}

/** Rebind (or `combo: null` to disable) one shortcut. Main re-validates before persisting. */
export interface AppShortcutsSetOverrideRequest {
  id: AppShortcutId;
  combo: AppShortcutCombo | null;
}

/** Reset one shortcut to its registry default (delete its override). */
export interface AppShortcutsClearOverrideRequest {
  id: AppShortcutId;
}

/** One-way send: settings page toggling the recording gate. */
export interface AppShortcutsSetRecordingRequest {
  recording: boolean;
}

/** Push payload when overrides change in any window. */
export interface AppShortcutsChangedEvent {
  overrides: AppShortcutOverrides;
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
  [IPC_CHANNELS.updateGetStatus]: { request: void; result: UpdateStatus };
  [IPC_CHANNELS.updateCheck]: { request: void; result: UpdateStatus };
  [IPC_CHANNELS.appShortcutsSetOverride]: {
    request: AppShortcutsSetOverrideRequest;
    result: AppShortcutsMutationResult;
  };
  [IPC_CHANNELS.appShortcutsClearOverride]: {
    request: AppShortcutsClearOverrideRequest;
    result: AppShortcutsMutationResult;
  };
  [IPC_CHANNELS.appShortcutsResetAll]: {
    request: void;
    result: AppShortcutsMutationResult;
  };
}
