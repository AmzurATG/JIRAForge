const { test, expect } = require('./fixtures');

/**
 * Tests for the ➕ button and convert-to-worklog popover flow.
 */

test.describe('Convert idle to worklog', () => {
  const getTestIds = () => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    return { userId, orgId, today };
  };

  test('➕ button appears on hover over idle block', async ({ timelinePage, seedIdleBlock }) => {
    const { userId, orgId, today } = getTestIds();
    if (!userId || !orgId) { test.skip(); return; }

    await seedIdleBlock({ userId, orgId, date: today, startHour: 10, durationMinutes: 60 });
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const idleBlock = timelinePage.locator('.timeline-block.idle').first();
    const convertBtn = idleBlock.locator('.idle-convert-btn');

    // Button hidden by default
    await expect(convertBtn).toBeHidden();

    // Hover reveals button
    await idleBlock.hover();
    await expect(convertBtn).toBeVisible();
  });

  test('clicking ➕ opens the convert popover', async ({ timelinePage, seedIdleBlock }) => {
    const { userId, orgId, today } = getTestIds();
    if (!userId || !orgId) { test.skip(); return; }

    await seedIdleBlock({ userId, orgId, date: today, startHour: 13, durationMinutes: 30 });
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const idleBlock = timelinePage.locator('.timeline-block.idle').first();
    await idleBlock.hover();
    await idleBlock.locator('.idle-convert-btn').click();

    const popover = timelinePage.locator('.idle-convert-popover');
    await expect(popover).toBeVisible();

    // Should have two inputs and two buttons
    await expect(popover.locator('.popover-input')).toHaveCount(2);
    await expect(popover.locator('.popover-btn')).toHaveCount(2);
  });

  test('convert button is disabled until both fields filled', async ({ timelinePage, seedIdleBlock }) => {
    const { userId, orgId, today } = getTestIds();
    if (!userId || !orgId) { test.skip(); return; }

    await seedIdleBlock({ userId, orgId, date: today, startHour: 15, durationMinutes: 20 });
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const idleBlock = timelinePage.locator('.timeline-block.idle').first();
    await idleBlock.hover();
    await idleBlock.locator('.idle-convert-btn').click();

    const popover = timelinePage.locator('.idle-convert-popover');
    const confirmBtn = popover.locator('.popover-btn.confirm');

    // Initially disabled
    await expect(confirmBtn).toBeDisabled();

    // Fill issue key only
    await popover.locator('.popover-input').first().fill('PROJ-123');
    await expect(confirmBtn).toBeDisabled();

    // Fill reason
    await popover.locator('.popover-input').nth(1).fill('Code review');
    await expect(confirmBtn).toBeEnabled();
  });

  test('cancel button closes the popover', async ({ timelinePage, seedIdleBlock }) => {
    const { userId, orgId, today } = getTestIds();
    if (!userId || !orgId) { test.skip(); return; }

    await seedIdleBlock({ userId, orgId, date: today, startHour: 16, durationMinutes: 10 });
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const idleBlock = timelinePage.locator('.timeline-block.idle').first();
    await idleBlock.hover();
    await idleBlock.locator('.idle-convert-btn').click();

    const popover = timelinePage.locator('.idle-convert-popover');
    await expect(popover).toBeVisible();

    await popover.locator('.popover-btn.cancel').click();
    await expect(popover).toBeHidden();
  });

  test('clicking outside popover closes it', async ({ timelinePage, seedIdleBlock }) => {
    const { userId, orgId, today } = getTestIds();
    if (!userId || !orgId) { test.skip(); return; }

    await seedIdleBlock({ userId, orgId, date: today, startHour: 9, durationMinutes: 25 });
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const idleBlock = timelinePage.locator('.timeline-block.idle').first();
    await idleBlock.hover();
    await idleBlock.locator('.idle-convert-btn').click();

    await expect(timelinePage.locator('.idle-convert-popover')).toBeVisible();

    // Click on the timeline header (outside popover)
    await timelinePage.locator('.timesheet-header').click();
    await expect(timelinePage.locator('.idle-convert-popover')).toBeHidden();
  });
});
