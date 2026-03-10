/**
 * Session Service
 * Handles work session reassignment and screenshot retrieval
 */

import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization, supabaseRequest, generateSignedUrl } from '../../utils/supabase.js';
import { isValidUUID, isValidIssueKey, sanitizeUUIDArray } from '../../utils/validators.js';

/**
 * Reassign a work session from one issue to another
 * Updates the analysis_results records in Supabase
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for organization filtering
 * @param {Array<string>} analysisResultIds - IDs of analysis_results to reassign
 * @param {string} fromIssueKey - Original issue key
 * @param {string} toIssueKey - Target issue key to reassign to
 * @param {number} totalSeconds - Total time being reassigned (for logging)
 * @returns {Promise<Object>} Reassignment result
 */
export async function reassignSession(accountId, cloudId, analysisResultIds, fromIssueKey, toIssueKey, totalSeconds) {
  // Validate inputs
  const validResultIds = sanitizeUUIDArray(analysisResultIds);
  if (validResultIds.length === 0) {
    throw new Error('No valid analysis result IDs to reassign');
  }

  if (!isValidIssueKey(fromIssueKey)) {
    throw new Error('Invalid fromIssueKey format');
  }

  if (!isValidIssueKey(toIssueKey)) {
    throw new Error('Invalid toIssueKey format');
  }

  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    throw new Error('Supabase not configured. Please configure in Settings.');
  }

  // Get organization
  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) {
    throw new Error('Unable to get organization information');
  }

  // Get user record
  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  if (!userId) {
    throw new Error('Unable to get user information');
  }

  console.log(`[Reassign] Reassigning ${validResultIds.length} records (${totalSeconds}s) from ${fromIssueKey} to ${toIssueKey}`);

  // Extract project key from toIssueKey (e.g., SCRUM-5 -> SCRUM)
  const toProjectKey = toIssueKey.split('-')[0];

  // Update each analysis result to the new issue (legacy data)
  let successCount = 0;
  let errorCount = 0;

  for (const resultId of validResultIds) {
    try {
      await supabaseRequest(
        supabaseConfig,
        `analysis_results?id=eq.${resultId}&user_id=eq.${userId}&organization_id=eq.${organization.id}`,
        {
          method: 'PATCH',
          body: {
            active_task_key: toIssueKey,
            active_project_key: toProjectKey,
            reassigned_from: fromIssueKey,
            reassigned_at: new Date().toISOString()
          }
        }
      );
      successCount++;
    } catch (error) {
      console.error(`[Reassign] Error updating analysis_result ${resultId}:`, error);
      errorCount++;
    }
  }

  // Also update activity_records if they have the old issue key assigned
  // This handles the new hybrid OCR approach data
  try {
    await supabaseRequest(
      supabaseConfig,
      `activity_records?user_id=eq.${userId}&organization_id=eq.${organization.id}&user_assigned_issue_key=eq.${fromIssueKey}`,
      {
        method: 'PATCH',
        body: {
          user_assigned_issue_key: toIssueKey,
          project_key: toProjectKey
        }
      }
    );
    console.log(`[Reassign] Updated activity_records from ${fromIssueKey} to ${toIssueKey}`);
  } catch (error) {
    console.error(`[Reassign] Error updating activity_records:`, error);
  }

  console.log(`[Reassign] Completed: ${successCount} success, ${errorCount} errors`);

  if (successCount === 0) {
    throw new Error('Failed to reassign any records');
  }

  return {
    success: true,
    reassigned: successCount,
    errors: errorCount,
    fromIssueKey,
    toIssueKey,
    totalSeconds,
    message: `Successfully reassigned ${successCount} records from ${fromIssueKey} to ${toIssueKey}`
  };
}

/**
 * Get screenshots for a work session with signed URLs
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for organization filtering
 * @param {Array<string>} analysisResultIds - IDs of analysis_results to fetch screenshots for
 * @returns {Promise<Object>} Screenshots with signed URLs
 */
export async function getSessionScreenshots(accountId, cloudId, analysisResultIds) {
  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    throw new Error('Supabase not configured. Please configure in Settings.');
  }

  // Get organization
  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) {
    throw new Error('Unable to get organization information');
  }

  // Get user record
  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  if (!userId) {
    throw new Error('Unable to get user information');
  }

  // Validate analysisResultIds as UUIDs
  const validIds = sanitizeUUIDArray(analysisResultIds);
  if (validIds.length === 0) {
    throw new Error('No valid analysis result IDs provided');
  }

  console.log(`[getSessionScreenshots] Fetching screenshots for ${validIds.length} analysis results`);

  // Fetch analysis_results with screenshot data
  const analysisIdsParam = validIds.join(',');
  const analysisResults = await supabaseRequest(
    supabaseConfig,
    `analysis_results?id=in.(${analysisIdsParam})&user_id=eq.${userId}&organization_id=eq.${organization.id}&select=id,screenshot_id,screenshots(id,timestamp,storage_path,thumbnail_url,window_title,application_name)`
  );

  const resultsArray = Array.isArray(analysisResults) ? analysisResults : (analysisResults ? [analysisResults] : []);
  console.log(`[getSessionScreenshots] Found ${resultsArray.length} analysis_results with screenshots`);

  if (resultsArray.length === 0) {
    return { screenshots: [] };
  }

  // Generate signed URLs for screenshots in batches
  const BATCH_SIZE = 10;
  const screenshotsWithUrls = [];

  for (let i = 0; i < resultsArray.length; i += BATCH_SIZE) {
    const batch = resultsArray.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (result) => {
        const screenshot = result.screenshots;
        if (!screenshot) return null;

        // Generate signed URL for full-size screenshot (not thumbnail)
        let signed_url = null;
        if (screenshot.storage_path) {
          try {
            signed_url = await generateSignedUrl(supabaseConfig, 'screenshots', screenshot.storage_path, 3600);
          } catch (err) {
            console.error('[getSessionScreenshots] Error generating signed URL:', err);
          }
        }

        return {
          id: screenshot.id,
          timestamp: screenshot.timestamp,
          window_title: screenshot.window_title,
          application_name: screenshot.application_name,
          signed_url
        };
      })
    );
    screenshotsWithUrls.push(...batchResults);

    // Small delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < resultsArray.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  const validScreenshots = screenshotsWithUrls.filter(Boolean);
  console.log(`[getSessionScreenshots] Returning ${validScreenshots.length} screenshots with signed URLs`);

  return { screenshots: validScreenshots };
}
