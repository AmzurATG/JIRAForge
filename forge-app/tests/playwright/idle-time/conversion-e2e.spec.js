const { test, expect } = require('./fixtures');

/**
 * Tests for the full conversion flow: fill form → submit → verify update.
 */

test.describe('Conversion end-to-end', () => {
  test('successful conversion updates idle block to converted state', async ({ timelinePage, seedIdleBlock }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedIdleBlock({ userId, orgId, date: today, startHour: 11, durationMinutes: 40 });
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    // Open popover
    const idleBlock = timelinePage.locator('.timeline-block.idle').first();
    await idleBlock.hover();
    await idleBlock.locator('.idle-convert-btn').click();

    const popover = timelinePage.locator('.idle-convert-popover');

    // Fill form
    await popover.locator('.popover-input').first().fill('PROJ-42');
    await popover.locator('.popover-input').nth(1).fill('Working on feature design');

    // Submit
    await popover.locator('.popover-btn.confirm').click();

    // Wait for popover to close and block to update
    await expect(popover).toBeHidden({ timeout: 10_000 });

    // The converted block should have the .converted class
    const convertedBlock = timelinePage.locator('.timeline-block.idle.converted');
    await expect(convertedBlock.first()).toBeVisible({ timeout: 10_000 });
  });

  test('converted block no longer shows ➕ button', async ({ timelinePage, seedIdleBlock }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    // Seed an already-converted block
    const record = await seedIdleBlock({ userId, orgId, date: today, startHour: 14, durationMinutes: 15 });

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
        converted_issue_key: 'TEST-99',
      }),
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const convertedBlock = timelinePage.locator('.timeline-block.idle.converted').first();
    await convertedBlock.hover();
    // The + button should not be present for converted blocks
    await expect(convertedBlock.locator('.idle-convert-btn')).toHaveCount(0);
  });
});
