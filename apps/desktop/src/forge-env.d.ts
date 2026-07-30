/// <reference types="vite/client" />

// Globals injected by @electron-forge/plugin-vite for the `main_window` renderer
// entry. Present at runtime in the main process; typed here so main code can use
// them without `any`.
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
