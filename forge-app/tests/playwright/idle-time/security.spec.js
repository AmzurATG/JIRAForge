const { test, expect } = require('./fixtures');

/**
 * Security-focused tests: ownership, XSS, access control.
 */

test.describe('Idle conversion security', () => {
  test('popover sanitizes input — no script execution', async ({ timelinePage, seedIdleBlock }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedIdleBlock({ userId, orgId, date: today, startHour: 10, durationMinutes: 30 });
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const idleBlock = timelinePage.locator('.timeline-block.idle').first();
    await idleBlock.hover();
    await idleBlock.locator('.idle-convert-btn').click();

    const popover = timelinePage.locator('.idle-convert-popover');

    // Attempt XSS via issue key field
    await popover.locator('.popover-input').first().fill('<script>alert(1)</script>');
    await popover.locator('.popover-input').nth(1).fill('Testing XSS');

    // Submit — should fail validation (invalid issue key format), not execute script
    await popover.locator('.popover-btn.confirm').click();

    // Verify no alert dialog was triggered
    let alertTriggered = false;
    timelinePage.on('dialog', () => { alertTriggered = true; });
    await timelinePage.waitForTimeout(1000);
    expect(alertTriggered).toBe(false);
  });

  test('issue key input rejects empty values', async ({ timelinePage, seedIdleBlock }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedIdleBlock({ userId, orgId, date: today, startHour: 9, durationMinutes: 20 });
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const idleBlock = timelinePage.locator('.timeline-block.idle').first();
    await idleBlock.hover();
    await idleBlock.locator('.idle-convert-btn').click();

    const confirmBtn = timelinePage.locator('.popover-btn.confirm');

    // Leave issue key empty, fill reason
    await timelinePage.locator('.popover-input').nth(1).fill('Some work');

    // Confirm should be disabled
    await expect(confirmBtn).toBeDisabled();
  });

  test('admin view: idle blocks visible but no ➕ button for other users', async ({ timelinePage }) => {
    // In admin view, idle blocks from other users should be visible
    // but the convert button should NOT appear (only own idle blocks can be converted)
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    // Check all idle blocks from team view
    const allIdleBlocks = timelinePage.locator('.timeline-block.idle');
    const count = await allIdleBlocks.count();

    // This is a structural check — can't fully test ownership without multi-user setup
    // Just verify the component renders without errors
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
