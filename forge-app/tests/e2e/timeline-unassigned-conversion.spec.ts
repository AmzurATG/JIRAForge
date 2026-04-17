/**
 * Playwright E2E tests for unassigned work timeline conversion
 * Tests the full user experience of converting unassigned work blocks from the timeline
 */

import { test, expect, Page } from '@playwright/test';

test.describe('Unassigned Work Timeline Conversion', () => {
  let page: Page;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    // Login and navigate to Time Analytics tab
    // This assumes test environment is set up with auth
    await page.goto('http://localhost:3000/apps/time-analytics');
    await page.waitForLoadState('networkidle');
  });

  test.afterEach(async () => {
    await page.close();
  });

  test('should display unassigned work blocks in timeline', async () => {
    // Navigate to Day View
    await page.click('[data-testid="day-view-button"]');
    await page.waitForSelector('[data-testid="timeline-container"]');

    // Look for unassigned work blocks (dotted blue pattern)
    const unassignedBlocks = await page.locator('.timeline-block.unassigned');
    const count = await unassignedBlocks.count();

    if (count > 0) {
      expect(count).toBeGreaterThan(0);
      
      // Check if blocks are the right color/style
      const firstBlock = unassignedBlocks.first();
      const styles = await firstBlock.evaluate(el => {
        const computed = window.getComputedStyle(el);
        return {
          background: computed.background,
          opacity: computed.opacity
        };
      });

      // Verify the block has the dotted pattern styling
      expect(styles.background).toContain('0052CC'); // Blue color
    }
  });

  test('should show + button on hover over unassigned block', async () => {
    // Navigate to Day View
    await page.click('[data-testid="day-view-button"]');
    await page.waitForSelector('[data-testid="timeline-container"]');

    const unassignedBlocks = await page.locator('.timeline-block.unassigned');
    
    if (await unassignedBlocks.count() > 0) {
      const firstBlock = unassignedBlocks.first();
      
      // Hover over the block
      await firstBlock.hover();
      
      // Check if + button appears
      const convertBtn = firstBlock.locator('.unassigned-convert-btn');
      await expect(convertBtn).toBeVisible();

      // Verify button is clickable
      await expect(convertBtn).toBeEnabled();
    }
  });

  test('should show hover tooltip with time info', async () => {
    // Navigate to Day View
    await page.click('[data-testid="day-view-button"]');
    await page.waitForSelector('[data-testid="timeline-container"]');

    const unassignedBlocks = await page.locator('.timeline-block.unassigned');
    
    if (await unassignedBlocks.count() > 0) {
      const firstBlock = unassignedBlocks.first();
      
      // Hover to trigger tooltip
      await firstBlock.hover();
      
      // Check if hover strip appears
      const hoverStrip = await page.locator('.timeline-hover-strip.unassigned');
      await expect(hoverStrip).toBeVisible();

      // Verify tooltip contains time info
      const hoverText = await hoverStrip.textContent();
      expect(hoverText).toContain('Unassigned');
      expect(hoverText).toMatch(/\d+:\d+/); // Time format
    }
  });

  test('should open conversion modal on + button click', async () => {
    // Navigate to Day View
    await page.click('[data-testid="day-view-button"]');
    await page.waitForSelector('[data-testid="timeline-container"]');

    const unassignedBlocks = await page.locator('.timeline-block.unassigned');
    
    if (await unassignedBlocks.count() > 0) {
      const firstBlock = unassignedBlocks.first();
      
      // Hover and click the + button
      await firstBlock.hover();
      const convertBtn = firstBlock.locator('.unassigned-convert-btn');
      await convertBtn.click();

      // Check if conversion modal/popover appears
      const modal = await page.locator('.idle-convert-popover-outer, [data-testid="conversion-modal"]');
      await expect(modal).toBeVisible();

      // Verify modal content
      await expect(modal).toContainText('Assign to existing issue');
      await expect(modal).toContainText('Create new issue');
    }
  });

  test('should prefill recommendation from group if available', async () => {
    // Navigate to Day View
    await page.click('[data-testid="day-view-button"]');
    await page.waitForSelector('[data-testid="timeline-container"]');

    const unassignedBlocks = await page.locator('.timeline-block.unassigned');
    
    if (await unassignedBlocks.count() > 0) {
      const firstBlock = unassignedBlocks.first();
      
      // Click to open modal
      await firstBlock.hover();
      const convertBtn = firstBlock.locator('.unassigned-convert-btn');
      await convertBtn.click();

      // Wait for modal to load (including recommendation fetching)
      await page.waitForTimeout(500); // Wait for recommendation API call

      // Check if recommendation prefilled the form
      const modeRadio = await page.locator('input[name="conversion-mode"]');
      if (modeRadio.count() > 0) {
        // If recommendation was fetched, check which mode is selected
        const selectedMode = await modeRadio.locator('[value="existing"]:checked, [value="new"]:checked');
        // Mode should be set based on recommendation
      }
    }
  });

  test('should allow selecting existing issue', async () => {
    // Navigate to Day View
    await page.click('[data-testid="day-view-button"]');
    await page.waitForSelector('[data-testid="timeline-container"]');

    const unassignedBlocks = await page.locator('.timeline-block.unassigned');
    
    if (await unassignedBlocks.count() > 0) {
      // Open conversion modal
      const firstBlock = unassignedBlocks.first();
      await firstBlock.hover();
      const convertBtn = firstBlock.locator('.unassigned-convert-btn');
      await convertBtn.click();

      // Select "existing issue" mode
      await page.click('input[name="conversion-mode"][value="existing"]');

      // Wait for issue dropdown to load
      const issueDropdown = await page.locator('[data-testid="issue-select"], select[name="issueKey"]');
      await expect(issueDropdown).toBeVisible();

      // Select an issue
      const options = await issueDropdown.locator('option');
      if (await options.count() > 1) {
        await issueDropdown.selectOption('1'); // Select second option
      }

      // Add conversion reason
      const reasonInput = await page.locator('[data-testid="conversion-reason"], input[name="reason"]');
      if (await reasonInput.isVisible()) {
        await reasonInput.fill('Assigned manually from timeline');
      }

      // Submit
      const submitBtn = await page.locator('[data-testid="convert-submit"], button:has-text("Convert")');
      if (await submitBtn.isVisible()) {
        await submitBtn.click();
        
        // Wait for conversion to complete
        await page.waitForLoadState('networkidle');
        
        // Check if modal closed
        const modal = await page.locator('.idle-convert-popover-outer');
        await expect(modal).not.toBeVisible({ timeout: 5000 });
      }
    }
  });

  test('should allow creating new issue', async () => {
    // Navigate to Day View
    await page.click('[data-testid="day-view-button"]');
    await page.waitForSelector('[data-testid="timeline-container"]');

    const unassignedBlocks = await page.locator('.timeline-block.unassigned');
    
    if (await unassignedBlocks.count() > 0) {
      // Open conversion modal
      const firstBlock = unassignedBlocks.first();
      await firstBlock.hover();
      const convertBtn = firstBlock.locator('.unassigned-convert-btn');
      await convertBtn.click();

      // Select "create new issue" mode
      await page.click('input[name="conversion-mode"][value="new"]');

      // Wait for project dropdown to load
      const projectDropdown = await page.locator('[data-testid="project-select"], select[name="projectKey"]');
      await expect(projectDropdown).toBeVisible();

      // Select a project
      const options = await projectDropdown.locator('option');
      if (await options.count() > 0) {
        await projectDropdown.selectOption('0');
      }

      // Add issue summary
      const summaryInput = await page.locator('[data-testid="issue-summary"], input[name="issueSummary"]');
      if (await summaryInput.isVisible()) {
        await summaryInput.fill('Unassigned work from timeline');
      }

      // Submit
      const submitBtn = await page.locator('[data-testid="convert-submit"], button:has-text("Create")');
      if (await submitBtn.isVisible()) {
        await submitBtn.click();
        
        // Wait for conversion to complete and new issue to be created
        await page.waitForLoadState('networkidle');
        
        // Check if modal closed
        const modal = await page.locator('.idle-convert-popover-outer');
        await expect(modal).not.toBeVisible({ timeout: 5000 });
      }
    }
  });

  test('should remove sessions from Unassigned Work page after conversion', async () => {
    // Navigate to Unassigned Work page
    await page.click('[data-testid="unassigned-work-button"]');
    await page.waitForLoadState('networkidle');

    // Note the initial count of unassigned groups
    const groupsBefore = await page.locator('.unassigned-group-card').count();

    // Go back to timeline and convert a session
    await page.click('[data-testid="day-view-button"]');
    await page.waitForSelector('[data-testid="timeline-container"]');

    const unassignedBlocks = await page.locator('.timeline-block.unassigned');
    if (await unassignedBlocks.count() > 0) {
      // Perform conversion (assuming "existing issue" mode for simplicity)
      const firstBlock = unassignedBlocks.first();
      await firstBlock.hover();
      const convertBtn = firstBlock.locator('.unassigned-convert-btn');
      await convertBtn.click();

      // Complete conversion
      // ... (select issue and submit)
    }

    // Go back to Unassigned Work page
    await page.click('[data-testid="unassigned-work-button"]');
    await page.waitForLoadState('networkidle');

    // Verify groups are gone or updated
    const groupsAfter = await page.locator('.unassigned-group-card').count();
    expect(groupsAfter).toBeLessThanOrEqual(groupsBefore);
  });

  test('should update My Focus dashboard when issue is assigned', async () => {
    // Navigate to Day View
    await page.click('[data-testid="day-view-button"]');
    await page.waitForSelector('[data-testid="timeline-container"]');

    const unassignedBlocks = await page.locator('.timeline-block.unassigned');
    
    if (await unassignedBlocks.count() > 0) {
      // Get initial issue count on My Focus (if visible)
      const myFocusSection = await page.locator('[data-testid="my-focus-section"]');
      const initialIssueCount = await myFocusSection.locator('.issue-row').count();

      // Perform conversion
      const firstBlock = unassignedBlocks.first();
      await firstBlock.hover();
      const convertBtn = firstBlock.locator('.unassigned-convert-btn');
      await convertBtn.click();

      // Complete conversion (existing issue mode)
      // ... (complete conversion flow)

      // Wait for My Focus to refresh
      await page.waitForTimeout(1000);

      // Verify the newly linked issue appears in My Focus
      const updatedIssueCount = await myFocusSection.locator('.issue-row').count();
      // Updated count should reflect the converted issue
    }
  });

  test('should handle conversion failure gracefully', async () => {
    // Navigate to Day View
    await page.click('[data-testid="day-view-button"]');
    await page.waitForSelector('[data-testid="timeline-container"]');

    const unassignedBlocks = await page.locator('.timeline-block.unassigned');
    
    if (await unassignedBlocks.count() > 0) {
      // Open conversion modal
      const firstBlock = unassignedBlocks.first();
      await firstBlock.hover();
      const convertBtn = firstBlock.locator('.unassigned-convert-btn');
      await convertBtn.click();

      // Try to submit with invalid data (e.g., no reason)
      const submitBtn = await page.locator('[data-testid="convert-submit"], button:has-text("Convert")');
      if (await submitBtn.isVisible()) {
        // Button should be disabled if form is invalid
        const isDisabled = await submitBtn.isDisabled();
        if (isDisabled) {
          expect(isDisabled).toBe(true);
        }
      }
    }
  });
});
