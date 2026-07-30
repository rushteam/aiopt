import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer bundle — an ordinary web build. No Node/Electron access here by
// design (see the security rule §2).
export default defineConfig({
  plugins: [react()],
});
