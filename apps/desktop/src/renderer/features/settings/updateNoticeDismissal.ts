/** The release version whose update bar the user closed. */
export const UPDATE_NOTICE_DISMISSED_KEY = 'updates.dismissedVersion';

/**
 * Whether to show the bar for `nextVersion`. Closing it hides that version only: a newer
 * release shows the bar again, so skipping one update never silences the next.
 */
export function shouldShowUpdateNotice(nextVersion: string, dismissedVersion: string | null): boolean {
  return nextVersion !== dismissedVersion;
}

export function readDismissedUpdateVersion(): string | null {
  try {
    return localStorage.getItem(UPDATE_NOTICE_DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function writeDismissedUpdateVersion(version: string): void {
  try {
    localStorage.setItem(UPDATE_NOTICE_DISMISSED_KEY, version);
  } catch {
    // Preference only; ignore quota or private mode.
  }
}
