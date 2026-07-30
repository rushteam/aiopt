import { defineConfig } from 'vite';

// Preload bundle. Electron requires the preload to be a single CommonJS file;
// the plugin-vite `preload` target handles the format, we only mark electron
// external.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['electron'],
    },
  },
});
