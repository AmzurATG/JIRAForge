const { test, expect } = require('./fixtures');

/**
 * Tests for WorklogReassignModal rendering and structure.
 */
test.describe('Worklog reassignment modal rendering', () => {
  test('reassign button appears on synced issue rows in expanded view', async ({ timelinePage, seedSyncedWorklog }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-100',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 3600
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    // Expand the user card to see the issue breakdown
    const expandBtn = timelinePage.locator('.expand-issues-btn').first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
    }

    // Locate the issue row for TEST-100
    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-100' });
    await expect(issueRow).toBeVisible({ timeout: 10_000 });

    // The reassign button should exist on the synced issue row
    const reassignBtn = issueRow.locator('.reassign-worklog-btn');
    await expect(reassignBtn).toBeVisible();
  });

  test('clicking reassign opens modal with correct info', async ({ timelinePage, seedSyncedWorklog }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-101',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 7200
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    // Expand user card
    const expandBtn = timelinePage.locator('.expand-issues-btn').first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
    }

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-101' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Check modal header
    await expect(modal.locator('.modal-header h3')).toHaveText('Reassign Worklog');

    // Check info shows the source issue
    await expect(modal.locator('.reassign-info')).toContainText('TEST-101');

    // Check warning message is present
    await expect(modal.locator('.reassign-warning')).toBeVisible();
    await expect(modal.locator('.reassign-warning')).toContainText('delete');
  });

  test('modal closes on overlay click', async ({ timelinePage, seedSyncedWorklog }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-102',
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

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-102' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    // Click overlay (outside the modal)
    await timelinePage.locator('.modal-overlay').click({ position: { x: 10, y: 10 } });
    await expect(modal).toBeHidden({ timeout: 5_000 });
  });

  test('modal closes on X button click', async ({ timelinePage, seedSyncedWorklog }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-103',
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

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-103' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    await modal.locator('.modal-close').click();
    await expect(modal).toBeHidden({ timeout: 5_000 });
  });

  test('empty state shown when no other issues available', async ({ timelinePage, seedSyncedWorklog }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-104',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 900
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const expandBtn = timelinePage.locator('.expand-issues-btn').first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
    }

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-104' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    await expect(modal.locator('.empty-state')).toBeVisible();
    await expect(modal.locator('.empty-state')).toContainText('No other issues available');
  });
});
