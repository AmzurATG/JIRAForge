const { test: base, expect } = require('@playwright/test');

/**
 * Custom fixtures for idle-time Playwright tests.
 *
 * Provides:
 *  - `timelinePage`: navigates to the time-analytics DayView tab
 *  - `seedIdleBlock`: inserts an idle activity_record via Supabase REST
 */

// Supabase connection details (set via env or fallback to local dev)
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

exports.test = base.extend({
  /**
   * Navigate to the Time Analytics DayView tab.
   * Assumes the Forge tunnel is running and the Jira project page is loaded.
   */
  timelinePage: async ({ page }, use) => {
    // Navigate to the Forge app page (assumes tunnel serves the Custom UI)
    await page.goto('/');
    // Wait for the app to load
    await page.waitForSelector('.timesheet-day-view', { timeout: 15_000 });
    await use(page);
  },

  /**
   * Seed an idle block directly in Supabase for testing.
   * Returns the inserted record for cleanup / assertions.
   */
  seedIdleBlock: async ({}, use) => {
    const seeded = [];

    const seed = async ({ userId, orgId, date, startHour = 12, durationMinutes = 30 }) => {
      const startTime = new Date(`${date}T${String(startHour).padStart(2, '0')}:00:00Z`);
      const endTime = new Date(startTime.getTime() + durationMinutes * 60_000);

      const record = {
        user_id: userId,
        organization_id: orgId,
        classification: 'idle',
        is_idle: true,
        idle_start_time: startTime.toISOString(),
        idle_end_time: endTime.toISOString(),
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        duration_seconds: durationMinutes * 60,
        total_time_seconds: durationMinutes * 60,
        work_date: date,
        window_title: '[Idle: test]',
        application_name: 'System',
        status: 'analyzed',
        metadata: JSON.stringify({ tracking_mode: 'idle_detection', idle_reason: 'test' }),
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

      if (!res.ok) throw new Error(`Seed failed: ${res.status} ${await res.text()}`);
      const [inserted] = await res.json();
      seeded.push(inserted.id);
      return inserted;
    };

    await use(seed);

    // Cleanup: remove seeded records
    for (const id of seeded) {
      await fetch(`${SUPABASE_URL}/rest/v1/activity_records?id=eq.${id}`, {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }).catch(() => {});
    }
  },
});

exports.expect = expect;
