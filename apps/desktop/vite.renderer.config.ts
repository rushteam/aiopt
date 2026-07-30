import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer bundle — an ordinary web build. No Node/Electron access here by
// design (see the security rule §2).
export default defineConfig({
  plugins: [react()],
  // Pre-bundle React up front so a cold start doesn't discover these mid-load and
  // trigger a full-page reload (which briefly breaks React's hook dispatcher).
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-dev-runtime'],
  },
});
