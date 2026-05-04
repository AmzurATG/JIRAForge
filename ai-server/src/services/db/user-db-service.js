/**
 * User Database Service Module
 * Handles user-related database operations
 */

const { getClient } = require('./supabase-client');
const logger = require('../../utils/logger');

/**
 * Get user's Atlassian account ID from Supabase
 * @param {string} userId - User ID
 * @returns {Promise<string|null>} Atlassian account ID or null
 */
async function getUserAtlassianAccountId(userId) {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from('users')
      .select('atlassian_account_id')
      .eq('id', userId)
      .single();

    if (error || !data) {
      logger.warn('User not found or no Atlassian account ID', { userId, error });
      return null;
    }

    return data.atlassian_account_id;
  } catch (error) {
    logger.error('Error fetching user Atlassian account ID:', error);
    return null;
  }
}

/**
 * Get user's Jira issues for correlation
 * Note: This function returns empty array - the controller handles fetching via Forge
 * @param {string} userId - User ID
 * @param {string} atlassianAccountId - Atlassian account ID (optional)
 * @returns {Promise<Array>} Array of Jira issues (empty - controller handles this)
 */
async function getUserJiraIssues(userId, atlassianAccountId = null) {
  try {
    // If we have a Forge app URL configured, we could call it here
    // But since Forge apps use resolvers, we handle this in the controller
    // which can call the Forge app's resolver via the webhook payload
    logger.debug('getUserJiraIssues called - will be fetched by controller', { userId });
    return [];
  } catch (error) {
    logger.error('Error fetching user Jira issues:', error);
    return [];
  }
}

/**
 * Fetch user's cached Jira issues
 * @param {string} userId - User ID
 * @param {string} organizationId - Organization ID for multi-tenancy filtering (optional)
 * @returns {Promise<Array>} Array of cached Jira issues
 */
async function getUserCachedIssues(userId, organizationId = null) {
  try {
    const supabase = getClient();
    let query = supabase
      .from('user_jira_issues_cache')
      .select('*')
      .eq('user_id', userId);

    // Filter by organization if provided
    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return data || [];
  } catch (error) {
    logger.error('Error fetching user cached issues:', error);
    return [];
  }
}

/**
 * Get user's active Jira issues for better AI recommendations
 * @param {string} userId - User ID
 * @param {string} organizationId - Organization ID for multi-tenancy filtering
 * @returns {Promise<Array>} Array of user's active issues with summaries
 */
async function getUserActiveIssues(userId, organizationId) {
  try {
    const supabase = getClient();

    // First try to get from cache (has summaries) - filter by organization
    let cacheQuery = supabase
      .from('user_jira_issues_cache')
      .select('issue_key, issue_summary, summary, project_key, status, description, labels, priority, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (organizationId) {
      cacheQuery = cacheQuery.eq('organization_id', organizationId);
    }

    const { data: cachedIssues, error: cacheError } = await cacheQuery;

    if (!cacheError && cachedIssues && cachedIssues.length > 0) {
      return cachedIssues.map(issue => ({
        issue_key: issue.issue_key,
        summary: issue.issue_summary || issue.summary,
        project: issue.project_key,
        status: issue.status,
        description: issue.description || null,
        labels: issue.labels || [],
        priority: issue.priority || null,
        updated_at: issue.updated_at || null
      }));
    }

    // Fallback: get from analysis_results (no summaries, but at least we have keys)
    const { data, error } = await supabase
      .from('analysis_results')
      .select('active_task_key, active_project_key')
      .eq('user_id', userId)
      .not('active_task_key', 'is', null)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      throw error;
    }

    // Get unique issues
    const uniqueIssues = [...new Set(data.map(item => item.active_task_key))];

    return uniqueIssues.map(key => ({
      issue_key: key,
      summary: '', // No summary available from analysis_results
      project: data.find(d => d.active_task_key === key)?.active_project_key
    }));
  } catch (error) {
    logger.error('Error fetching user active issues:', error);
    return [];
  }
}

/**
 * Get user by ID
 * @param {string} userId - User ID
 * @returns {Promise<Object|null>} User data or null
 */
async function getUserById(userId) {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      throw error;
    }

    return data;
  } catch (error) {
    logger.error('Error fetching user by ID:', error);
    return null;
  }
}

/**
 * Get organization by ID
 * @param {string} organizationId - Organization ID
 * @returns {Promise<Object|null>} Organization data or null
 */
async function getOrganizationById(organizationId) {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from('organizations')
      .select('id, org_name, jira_cloud_id, jira_instance_url, is_active')
      .eq('id', organizationId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      throw error;
    }

    return data;
  } catch (error) {
    logger.error('Error fetching organization by ID:', error);
    return null;
  }
}

/**
 * Get the latest download URL for the desktop app
 * @param {string} [platform='windows'] - Platform (windows, macos, linux)
 * @returns {Promise<string|null>} Download URL or null
 */
async function getLatestDownloadUrl(platform = 'windows') {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from('app_releases')
      .select('download_url')
      .eq('platform', platform.toLowerCase())
      .eq('is_latest', true)
      .eq('is_active', true)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        logger.warn(`No latest release found for platform: ${platform}`);
        return null;
      }
      throw error;
    }

    return data?.download_url || null;
  } catch (error) {
    logger.error('Error fetching latest download URL:', error);
    return null;
  }
}

module.exports = {
  getUserAtlassianAccountId,
  getUserJiraIssues,
  getUserCachedIssues,
  getUserActiveIssues,
  getUserById,
  getOrganizationById,
  getLatestDownloadUrl
};
