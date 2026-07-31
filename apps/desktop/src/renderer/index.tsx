import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './global.css';
import { App } from './App';
import { ThemeProvider } from './themes/ThemeProvider';
import { AuthProvider } from './features/auth/AuthContext';
import { I18nProvider } from './i18n';

// Token values are applied to <html> via the CSSOM: the preload bootstrap sets
// them before first paint (anti-flash), and ThemeProvider keeps them in sync.
const container = document.getElementById('root');
if (!container) {
  throw new Error('root container missing');
}

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>,
);
