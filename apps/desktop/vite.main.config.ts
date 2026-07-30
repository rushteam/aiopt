import { defineConfig } from 'vite';

// Main process bundle. Node/Electron built-ins stay external; the main process
// runs in a full Node context.
export default defineConfig({
  build: {
    lib: {
      entry: 'src/main/index.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['electron'],
    },
  },
});
