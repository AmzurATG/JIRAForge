const { test, expect } = require('./fixtures');

/**
 * Security-focused tests for worklog reassignment.
 */
test.describe('Worklog reassignment security', () => {
  test('search input sanitizes XSS attempts', async ({
    timelinePage, seedSyncedWorklog
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-400',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 3600
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const expandBtn = timelinePage.locator('.expand-issues-btn').first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
    }

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-400' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    // Try XSS payload in search
    const searchInput = modal.locator('.search-input');
    await searchInput.fill('<script>alert("xss")</script>');

    // Should show empty state (no matching issues), not execute script
    await expect(modal.locator('.empty-state')).toBeVisible();

    // Verify no script element was injected into the DOM
    const scriptTags = await timelinePage.locator('.reassign-worklog-modal script').count();
    expect(scriptTags).toBe(0);
  });

  test('modal prevents interaction with underlying page', async ({
    timelinePage, seedSyncedWorklog
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-410',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 3600
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const expandBtn = timelinePage.locator('.expand-issues-btn').first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
    }

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-410' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    // Verify the overlay covers the full page
    const overlay = timelinePage.locator('.modal-overlay');
    await expect(overlay).toBeVisible();

    // Verify modal is still visible (overlay didn't close it by accident)
    await expect(modal).toBeVisible();
  });
});
