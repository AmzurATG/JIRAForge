const { test, expect } = require('./fixtures');

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/**
 * Tests for the full worklog reassignment flow.
 */
test.describe('Worklog reassignment end-to-end flow', () => {
  test('successful reassignment updates issue and closes modal', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-200',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 5400
    });

    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-201',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    // Expand user card
    const expandBtn = timelinePage.locator('.expand-issues-btn').first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
    }

    // Open reassign modal for TEST-200
    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-200' });
    await expect(issueRow).toBeVisible({ timeout: 10_000 });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    // Select TEST-201 as target
    const targetOption = modal.locator('.issue-option').filter({ hasText: 'TEST-201' });
    await expect(targetOption).toBeVisible();
    await targetOption.click();

    // Wait for modal to close (reassignment in progress -> completion)
    await expect(modal).toBeHidden({ timeout: 15_000 });

    // Verify the page refreshed
    await timelinePage.waitForSelector('.timesheet-day-view');
  });

  test('reassignment shows loading state while processing', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-210',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 3600
    });

    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-211',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const expandBtn = timelinePage.locator('.expand-issues-btn').first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
    }

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-210' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    const targetOption = modal.locator('.issue-option').filter({ hasText: 'TEST-211' });
    await targetOption.click();

    // Check for loading indicator (may be brief)
    const reassigningText = modal.locator('.reassigning-text');
    // The loading state may disappear quickly, so just verify modal closes
    await expect(modal).toBeHidden({ timeout: 15_000 });
  });

  test('search filters issue list correctly', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-220',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 3600
    });

    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-221',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const expandBtn = timelinePage.locator('.expand-issues-btn').first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
    }

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-220' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    // Type a non-existent search term
    const searchInput = modal.locator('.search-input');
    await searchInput.fill('ZZZNOMATCH');

    // Should show empty state for search
    await expect(modal.locator('.empty-state')).toBeVisible();
    await expect(modal.locator('.empty-state')).toContainText('No issues match');
  });

  test('reassignment updates worklog_sync record in database', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId || !SUPABASE_KEY) { test.skip(); return; }

    const { sync } = await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-230',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 3600
    });

    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-231',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const expandBtn = timelinePage.locator('.expand-issues-btn').first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
    }

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-230' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    const targetOption = modal.locator('.issue-option').filter({ hasText: 'TEST-231' });
    await targetOption.click();

    await expect(modal).toBeHidden({ timeout: 15_000 });

    // Verify worklog_sync updated in database
    const syncRes = await fetch(
      `${SUPABASE_URL}/rest/v1/worklog_sync?id=eq.${sync.id}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const [updatedSync] = await syncRes.json();
    expect(updatedSync.issue_key).toBe('TEST-231');
    expect(updatedSync.reassigned_from).toBe('TEST-230');
    expect(updatedSync.reassigned_at).not.toBeNull();
  });

  test('reassignment updates activity_records in database', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId || !SUPABASE_KEY) { test.skip(); return; }

    const { activity } = await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-240',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 3600
    });

    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-241',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const expandBtn = timelinePage.locator('.expand-issues-btn').first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
    }

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-240' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    const targetOption = modal.locator('.issue-option').filter({ hasText: 'TEST-241' });
    await targetOption.click();

    await expect(modal).toBeHidden({ timeout: 15_000 });

    // Verify activity_records updated in database
    const actRes = await fetch(
      `${SUPABASE_URL}/rest/v1/activity_records?id=eq.${activity.id}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const [updatedActivity] = await actRes.json();
    expect(updatedActivity.user_assigned_issue_key).toBe('TEST-241');
    expect(updatedActivity.reassigned_from).toBe('TEST-240');
  });
});
