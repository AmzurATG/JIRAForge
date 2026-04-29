/**
 * Issue Cache Service
 * Handles caching of Jira issues in Supabase
 */

import { getUserAssignedIssues } from '../../utils/jira.js';
import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization, supabaseRequest } from '../../utils/supabase.js';
import { JQL_ACTIVE_STATUSES, ISSUE_BATCH_SIZE } from '../../config/constants.js';
import { extractDescriptionText } from '../../utils/adfToText.js';

/**
 * Update user's assigned Jira issues cache in Supabase
 * This should be called periodically or on-demand to keep cache fresh
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for organization filtering
 * @returns {Promise<Object>} Cache update result
 */
export async function updateAssignedIssuesCache(accountId, cloudId) {
  // Get Supabase config
  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    throw new Error('Supabase not configured. Please configure in Settings.');
  }

  // Get or create organization first (multi-tenancy)
  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) {
    throw new Error('Unable to get organization information');
  }

  // Get or create user record
  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  if (!userId) {
    throw new Error('Unable to get user information');
  }

  // Fetch user's assigned issues from Jira
  const jiraData = await getUserAssignedIssues(JQL_ACTIVE_STATUSES);
  const issues = jiraData.issues || [];

  // Delete old cache entries for this user in this organization
  await supabaseRequest(
    supabaseConfig,
    `user_jira_issues_cache?user_id=eq.${userId}&organization_id=eq.${organization.id}`,
    {
      method: 'DELETE'
    }
  );

  // Insert new cache entries - include organization_id for multi-tenancy
  if (issues.length > 0) {
    const cacheEntries = issues.map(issue => ({
      user_id: userId,
      organization_id: organization.id,
      issue_key: issue.key,
      summary: issue.fields.summary || '',
      status: issue.fields.status?.name || 'Unknown',
      project_key: issue.fields.project?.key || '',
      issue_type: issue.fields.issuetype?.name || 'Task',
      updated_at: issue.fields.updated || issue.fields.created || new Date().toISOString(),
      description: extractDescriptionText(issue.fields.description) || null,
      labels: issue.fields.labels || [],
      priority: issue.fields.priority?.name || null
    }));

    // Insert in batches (Supabase has limits on batch size)
    for (let i = 0; i < cacheEntries.length; i += ISSUE_BATCH_SIZE) {
      const batch = cacheEntries.slice(i, i + ISSUE_BATCH_SIZE);
      await supabaseRequest(
        supabaseConfig,
        'user_jira_issues_cache',
        {
          method: 'POST',
          body: batch
        }
      );
    }
  }

  return {
    cached: issues.length,
    message: `Successfully cached ${issues.length} assigned issues`
  };
}
