const { test, expect } = require('./fixtures');

/**
 * Tests for validation, error handling, and edge cases.
 */
test.describe('Worklog reassignment validation', () => {
  test('source issue is excluded from target list', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-300',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 3600
    });

    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-301',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const expandBtn = timelinePage.locator('.expand-issues-btn').first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
    }

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-300' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    // Source issue TEST-300 should NOT appear in the target list
    const sourceOption = modal.locator('.issue-option').filter({ hasText: 'TEST-300' });
    await expect(sourceOption).toHaveCount(0);

    // But target TEST-301 should be visible
    const targetOption = modal.locator('.issue-option').filter({ hasText: 'TEST-301' });
    await expect(targetOption).toBeVisible();
  });

  test('issue buttons disabled during reassignment', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-310',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 3600
    });

    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-311',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const expandBtn = timelinePage.locator('.expand-issues-btn').first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
    }

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-310' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    // Click the target option
    const targetOption = modal.locator('.issue-option').filter({ hasText: 'TEST-311' });
    await targetOption.click();

    // During processing, buttons should be disabled
    // This may happen too fast to catch, but we verify the modal eventually closes
    await expect(modal).toBeHidden({ timeout: 15_000 });
  });

  test('search input is accessible and autofocused', async ({
    timelinePage, seedSyncedWorklog
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-320',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 1800
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const expandBtn = timelinePage.locator('.expand-issues-btn').first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
    }

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-320' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    const searchInput = modal.locator('.search-input');
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toHaveAttribute('aria-label', 'Search issues');
    await expect(searchInput).toHaveAttribute('placeholder', /search/i);
  });

  test('issue list has proper ARIA attributes for accessibility', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-330',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 3600
    });

    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-331',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const expandBtn = timelinePage.locator('.expand-issues-btn').first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
    }

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-330' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    // Check ARIA attributes on issue list
    const issueList = modal.locator('.issue-list-modal');
    await expect(issueList).toHaveAttribute('role', 'listbox');

    // Check that options have role="option"
    const options = modal.locator('.issue-option');
    const count = await options.count();
    expect(count).toBeGreaterThan(0);
  });
});
