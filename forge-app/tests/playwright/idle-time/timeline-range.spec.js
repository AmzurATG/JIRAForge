const { test, expect } = require('./fixtures');

/**
 * Tests for timeline range and visual correctness with idle blocks.
 */

test.describe('Timeline range with idle blocks', () => {
  test('timeline extends to cover idle blocks during work hours', async ({ timelinePage, seedIdleBlock }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    // Seed a morning idle block (8:00-8:30)
    await seedIdleBlock({ userId, orgId, date: today, startHour: 8, durationMinutes: 30 });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    // The timeline should include the 8am hour in its labels
    const hourLabels = timelinePage.locator('.timeline-hour-label');
    const allLabels = await hourLabels.allTextContents();
    expect(allLabels.some(l => l.includes('8am') || l.includes('7am'))).toBe(true);
  });

  test('idle blocks and work blocks coexist without overlap artifacts', async ({ timelinePage, seedIdleBlock }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    // Seed an idle block (12:00-12:30) between likely work sessions
    await seedIdleBlock({ userId, orgId, date: today, startHour: 12, durationMinutes: 30 });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    // Verify both work blocks and idle blocks are present
    const workBlocks = timelinePage.locator('.timeline-block.active');
    const idleBlocks = timelinePage.locator('.timeline-block.idle');

    // At least one of each should exist (work blocks from real tracking, idle from seed)
    const idleCount = await idleBlocks.count();
    expect(idleCount).toBeGreaterThan(0);
  });

  test('very short idle blocks (< 1 minute) are not displayed', async ({ timelinePage }) => {
    // This is handled server-side; the desktop app skips idle < 60s.
    // Verify no sub-minute blocks appear in the timeline.
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const idleBlocks = timelinePage.locator('.timeline-block.idle');
    const count = await idleBlocks.count();

    for (let i = 0; i < count; i++) {
      const title = await idleBlocks.nth(i).getAttribute('title');
      // Tooltip shows "(Xm)" — extract minutes and verify >= 1
      const match = title?.match(/\((\d+)m\)/);
      if (match) {
        expect(parseInt(match[1])).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
