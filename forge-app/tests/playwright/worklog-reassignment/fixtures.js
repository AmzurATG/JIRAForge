const { test: base, expect } = require('@playwright/test');

/**
 * Custom fixtures for worklog-reassignment Playwright tests.
 *
 * Provides:
 *  - `timelinePage`: navigates to the time-analytics DayView tab
 *  - `seedSyncedWorklog`: inserts an activity_record + worklog_sync entry
 *  - `seedTargetIssue`: inserts an activity_record for a target issue (no worklog_sync)
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

exports.test = base.extend({
  /**
   * Navigate to the Time Analytics DayView tab.
   */
  timelinePage: async ({ page }, use) => {
    await page.goto('/');
    await page.waitForSelector('.timesheet-day-view', { timeout: 15_000 });
    await use(page);
  },

  /**
   * Seed an activity record with a synced worklog for testing reassignment.
   * Creates both an activity_record and a worklog_sync entry.
   */
  seedSyncedWorklog: async ({}, use) => {
    const seededActivityIds = [];
    const seededSyncIds = [];

    const seed = async ({ userId, orgId, issueKey, projectKey, date, timeSeconds = 3600 }) => {
      const startTime = new Date(`${date}T09:00:00Z`);
      const endTime = new Date(startTime.getTime() + timeSeconds * 1000);

      // Create activity_record
      const activityRecord = {
        user_id: userId,
        organization_id: orgId,
        user_assigned_issue_key: issueKey,
        project_key: projectKey,
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        duration_seconds: timeSeconds,
        total_time_seconds: timeSeconds,
        work_date: date,
        window_title: `Working on ${issueKey}`,
        application_name: 'VS Code',
        status: 'analyzed',
        classification: 'productive',
      };

      const activityRes = await fetch(`${SUPABASE_URL}/rest/v1/activity_records`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify(activityRecord),
      });

      if (!activityRes.ok) throw new Error(`Activity seed failed: ${activityRes.status} ${await activityRes.text()}`);
      const [insertedActivity] = await activityRes.json();
      seededActivityIds.push(insertedActivity.id);

      // Create worklog_sync entry
      const syncRecord = {
        user_id: userId,
        organization_id: orgId,
        issue_key: issueKey,
        project_key: projectKey,
        jira_worklog_id: `mock-worklog-${Date.now()}`,
        last_synced_seconds: timeSeconds,
        started_at: startTime.toISOString(),
        sync_date: date,
      };

      const syncRes = await fetch(`${SUPABASE_URL}/rest/v1/worklog_sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify(syncRecord),
      });

      if (!syncRes.ok) throw new Error(`Sync seed failed: ${syncRes.status} ${await syncRes.text()}`);
      const [insertedSync] = await syncRes.json();
      seededSyncIds.push(insertedSync.id);

      return { activity: insertedActivity, sync: insertedSync };
    };

    await use(seed);

    // Cleanup
    for (const id of seededActivityIds) {
      await fetch(`${SUPABASE_URL}/rest/v1/activity_records?id=eq.${id}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
      }).catch(() => {});
    }
    for (const id of seededSyncIds) {
      await fetch(`${SUPABASE_URL}/rest/v1/worklog_sync?id=eq.${id}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
      }).catch(() => {});
    }
  },

  /**
   * Seed a target issue with activity but no worklog_sync.
   */
  seedTargetIssue: async ({}, use) => {
    const seededIds = [];

    const seed = async ({ userId, orgId, issueKey, projectKey, date }) => {
      const startTime = new Date(`${date}T10:00:00Z`);
      const record = {
        user_id: userId,
        organization_id: orgId,
        user_assigned_issue_key: issueKey,
        project_key: projectKey,
        start_time: startTime.toISOString(),
        end_time: new Date(startTime.getTime() + 1800000).toISOString(),
        duration_seconds: 1800,
        total_time_seconds: 1800,
        work_date: date,
        window_title: `Working on ${issueKey}`,
        application_name: 'VS Code',
        status: 'analyzed',
        classification: 'productive',
      };

      const res = await fetch(`${SUPABASE_URL}/rest/v1/activity_records`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify(record),
      });

      if (!res.ok) throw new Error(`Target seed failed: ${res.status} ${await res.text()}`);
      const [inserted] = await res.json();
      seededIds.push(inserted.id);
      return inserted;
    };

    await use(seed);

    for (const id of seededIds) {
      await fetch(`${SUPABASE_URL}/rest/v1/activity_records?id=eq.${id}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
      }).catch(() => {});
    }
  },
});

exports.expect = expect;
