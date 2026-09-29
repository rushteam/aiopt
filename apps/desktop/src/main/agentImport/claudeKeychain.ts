import { execFileSync } from 'node:child_process';
import os from 'node:os';

const SERVICE = 'Claude Code-credentials';

/** macOS only — read Claude Code credentials JSON from the login keychain. */
export function readClaudeCredentialsFromKeychain(): string | null {
  if (os.platform() !== 'darwin') return null;
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-w'], {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const text = out.toString('utf8').trim();
    if (text === '') return null;
    // `security -w` may hex-encode JSON when it contains awkward bytes.
    if (!text.startsWith('{') && text.length % 2 === 0) {
      try {
        const decoded = Buffer.from(text, 'hex').toString('utf8');
        if (decoded.startsWith('{')) return decoded;
      } catch {
        // fall through
      }
    }
    return text.startsWith('{') ? text : null;
  } catch {
    return null;
  }
}
