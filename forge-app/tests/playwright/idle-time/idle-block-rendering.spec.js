const { test, expect } = require('./fixtures');

/**
 * Tests that idle blocks render correctly on the timeline.
 */

test.describe('Idle blocks on timeline', () => {
  test('idle block appears with amber striped styling', async ({ timelinePage, seedIdleBlock }) => {
    // This test requires known userId / orgId — set via env or use test defaults
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];

    if (!userId || !orgId) {
      test.skip();
      return;
    }

    await seedIdleBlock({ userId, orgId, date: today, startHour: 10, durationMinutes: 45 });

    // Reload to pick up seeded data
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    // Verify idle block is rendered
    const idleBlock = timelinePage.locator('.timeline-block.idle');
    await expect(idleBlock.first()).toBeVisible();
  });

  test('converted idle block has green styling', async ({ timelinePage, seedIdleBlock }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];

    if (!userId || !orgId) {
      test.skip();
      return;
    }

    // Seed an already-converted idle block
    const record = await seedIdleBlock({ userId, orgId, date: today, startHour: 14, durationMinutes: 20 });

    // Mark it as converted directly in DB
    const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    await fetch(`${SUPABASE_URL}/rest/v1/activity_records?id=eq.${record.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({
        classification: 'productive',
        reclassified_from: 'idle',
        converted_issue_key: 'TEST-1',
      }),
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const convertedBlock = timelinePage.locator('.timeline-block.idle.converted');
    await expect(convertedBlock.first()).toBeVisible();
  });

  test('idle block tooltip shows time range and duration', async ({ timelinePage, seedIdleBlock }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];

    if (!userId || !orgId) {
      test.skip();
      return;
    }

    await seedIdleBlock({ userId, orgId, date: today, startHour: 11, durationMinutes: 15 });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const idleBlock = timelinePage.locator('.timeline-block.idle').first();
    const tooltip = await idleBlock.getAttribute('title');
    expect(tooltip).toContain('Idle');
    expect(tooltip).toContain('15m');
  });
});
