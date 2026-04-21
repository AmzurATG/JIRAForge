import { invoke } from '@forge/bridge';

const COOLDOWN_KEY = 'tt_worklog_sync_last_run';
const COOLDOWN_MS = 5 * 60 * 1000;

// Fire a user-attributed worklog sync if the shared 5-min cooldown has expired.
// The cooldown is kept in localStorage so every surface that mounts (project
// page, issue panel) cooperates through the same gate — opening the panel
// right after opening the project page won't double-fire the sync.
//
// History: cooldown was reduced from 15 → 5 min to fix the "Itracker"
// attribution issue where worklogs briefly showed the service account name
// before the user's own browser sync ran.
export function triggerWorklogSyncIfDue() {
  try {
    const lastRun = localStorage.getItem(COOLDOWN_KEY);
    const lastRunTs = parseInt(lastRun, 10);
    const cooldownExpired = !Number.isFinite(lastRunTs) || Date.now() - lastRunTs > COOLDOWN_MS;
    if (!cooldownExpired) return;

    localStorage.setItem(COOLDOWN_KEY, String(Date.now()));
    invoke('syncMyWorklogs')
      .then(result => {
        if (result?.synced > 0) {
          console.log(`[WorklogSync] Synced ${result.synced} worklog(s)`);
        } else if (result?.message) {
          console.log(`[WorklogSync] ${result.message}`);
        } else if (result?.error) {
          console.warn(`[WorklogSync] Error: ${result.error}`);
        }
      })
      .catch(err => console.warn('[WorklogSync] Background sync failed:', err));
  } catch (err) {
    console.warn('[WorklogSync] localStorage unavailable, skipping background sync:', err);
  }
}
