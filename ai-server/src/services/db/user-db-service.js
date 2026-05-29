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

/**
 * Get Atlassian account IDs of users who have had activity in the last N minutes.
 * Used by the scheduled Forge cache refresh to know which users need their
 * Jira issues cache updated.
 *
 * @param {number} withinMinutes - Look-back window (default 60)
 * @returns {Promise<string[]>} Array of distinct atlassian_account_id values
 */
async function getRecentlyActiveAccountIds(withinMinutes = 60) {
  try {
    const supabase = getClient();
    const since = new Date(Date.now() - withinMinutes * 60000).toISOString();

    const { data, error } = await supabase
      .from('activity_records')
      .select('user_id')
      .gte('created_at', since)
      .limit(500);

    if (error) throw error;
    if (!data || data.length === 0) return [];

    // Deduplicate user IDs
    const userIds = [...new Set(data.map(r => r.user_id))];

    // Resolve to Atlassian account IDs
    const { data: users, error: userErr } = await supabase
      .from('users')
      .select('atlassian_account_id')
      .in('id', userIds)
      .not('atlassian_account_id', 'is', null);

    if (userErr) throw userErr;
    return (users || []).map(u => u.atlassian_account_id);
  } catch (error) {
    logger.error('Error fetching recently active account IDs:', error);
    return [];
  }
}

/**
 * Resolve a company email domain to an organization id (non-Jira Google SSO).
 * Case-insensitive match against org_email_domains.domain. Uses the service-role
 * client, so RLS is bypassed (the desktop-google endpoint has no user JWT yet).
 *
 * @param {string} domain - Email domain (e.g. 'amzur.com')
 * @returns {Promise<string|null>} organization_id or null if the domain is not registered
 */
async function getOrgIdByEmailDomain(domain) {
  if (!domain) return null;
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const normalized = String(domain).trim().toLowerCase();
  const { data, error } = await supabase
    .from('org_email_domains')
    .select('organization_id')
    .eq('domain', normalized)
    .maybeSingle();

  if (error) {
    logger.error('[UserDB] getOrgIdByEmailDomain failed', { domain: normalized, error: error.message });
    throw error;
  }
  return data?.organization_id || null;
}

/**
 * Ensure an organization_members row exists for a non-Jira user.
 * Role is locked to 'member' with no elevated permissions (matches the
 * org_members_self_insert RLS policy and the default member permission set).
 *
 * @param {Object} supabase - Service-role Supabase client
 * @param {string} userId
 * @param {string} organizationId
 */
async function ensureGoogleUserMembership(supabase, userId, organizationId) {
  const { data: existing } = await supabase
    .from('organization_members')
    .select('id')
    .eq('user_id', userId)
    .eq('organization_id', organizationId)
    .limit(1);

  if (existing && existing.length > 0) return;

  const { error } = await supabase
    .from('organization_members')
    .insert({
      user_id: userId,
      organization_id: organizationId,
      role: 'member',
      can_manage_settings: false,
      can_view_team_analytics: false,
      can_manage_members: false,
      can_delete_screenshots: false,
      can_manage_billing: false
    });

  if (error) {
    // Non-fatal: a concurrent signup may have created it. Log and continue.
    logger.warn('[UserDB] ensureGoogleUserMembership insert failed', { userId, organizationId, error: error.message });
  }
}

/**
 * Find-or-create a non-Jira Google user, idempotent on google_sub.
 * Sets supabase_user_id = id so RLS (get_current_user_id) resolves the user,
 * mirroring the Atlassian exchange-token flow. Also ensures org membership.
 *
 * @param {Object} params
 * @param {string} params.googleSub - Google id_token 'sub' (stable account id)
 * @param {string} params.email
 * @param {string} params.displayName
 * @param {string} params.organizationId - Resolved from the email domain
 * @returns {Promise<Object>} The users row ({ id, organization_id, email, display_name, ... })
 */
async function findOrCreateGoogleUser({ googleSub, email, displayName, organizationId }) {
  if (!googleSub) throw new Error('googleSub is required');
  if (!organizationId) throw new Error('organizationId is required');

  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  // Look up by stable google_sub (NOT email — email has no unique constraint).
  const { data: existing, error: findErr } = await supabase
    .from('users')
    .select('*')
    .eq('auth_provider', 'google')
    .eq('google_sub', googleSub)
    .maybeSingle();

  if (findErr) {
    logger.error('[UserDB] findOrCreateGoogleUser lookup failed', { error: findErr.message });
    throw findErr;
  }

  if (existing) {
    // Keep profile fresh; ensure supabase_user_id is set for RLS.
    const updates = {};
    if (existing.supabase_user_id !== existing.id) updates.supabase_user_id = existing.id;
    if (email && existing.email !== email) updates.email = email;
    if (displayName && existing.display_name !== displayName) updates.display_name = displayName;
    if (Object.keys(updates).length > 0) {
      await supabase.from('users').update(updates).eq('id', existing.id);
      Object.assign(existing, updates);
    }
    await ensureGoogleUserMembership(supabase, existing.id, existing.organization_id);
    return existing;
  }

  const { data: created, error: createErr } = await supabase
    .from('users')
    .insert({
      auth_provider: 'google',
      google_sub: googleSub,
      email: email || null,
      display_name: displayName || null,
      organization_id: organizationId,
      atlassian_account_id: null
    })
    .select()
    .single();

  if (createErr) {
    logger.error('[UserDB] findOrCreateGoogleUser insert failed', { error: createErr.message });
    throw createErr;
  }

  // Set supabase_user_id = id so RLS (WHERE supabase_user_id = auth.uid()) resolves.
  await supabase.from('users').update({ supabase_user_id: created.id }).eq('id', created.id);
  created.supabase_user_id = created.id;

  await ensureGoogleUserMembership(supabase, created.id, organizationId);
  logger.info('[UserDB] Created google user', { userId: created.id, organizationId });
  return created;
}

module.exports = {
  getUserAtlassianAccountId,
  getUserJiraIssues,
  getUserCachedIssues,
  getUserActiveIssues,
  getUserById,
  getOrganizationById,
  getLatestDownloadUrl,
  getRecentlyActiveAccountIds,
  getOrgIdByEmailDomain,
  findOrCreateGoogleUser
};
