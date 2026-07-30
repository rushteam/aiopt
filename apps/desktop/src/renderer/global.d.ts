import type { HearthBridge } from '../preload/preload';

// The bridge the preload exposes on the renderer's window. Compile-time only —
// this is an `import type`, erased in the build; the renderer never imports
// preload/main code at runtime.
declare global {
  interface Window {
    hearth: HearthBridge;
  }
}

export {};
