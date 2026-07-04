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
  // Case-insensitive match to align with the migration's UNIQUE(lower(domain)):
  // rows inserted outside the Forge UI may be mixed-case, and `eq` would miss them.
  // Domains contain no LIKE wildcards (% / _), so ilike is an exact case-insensitive match.
  const { data, error } = await supabase
    .from('org_email_domains')
    .select('organization_id')
    .ilike('domain', normalized)
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
    // Only a duplicate from a concurrent signup is safe to ignore (we select
    // first, so a unique_violation here means another request just inserted it).
    // Any other failure leaves the user without an organization_members row,
    // which breaks org-scoped reads (settings/classification) — fail the login.
    if (error.code === '23505') {
      logger.info('[UserDB] ensureGoogleUserMembership: membership already exists (race) — ignoring');
      return;
    }
    logger.error('[UserDB] ensureGoogleUserMembership insert failed', { userId, organizationId, error: error.message });
    throw error;
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

  // Look up by stable google_sub — deliberately NOT filtered on auth_provider:
  // an Atlassian-provisioned user whose Google identity was linked (below, or by
  // the duplicate-merge repair) keeps auth_provider='atlassian' (google provider
  // = "non-Jira user" semantics in clustering/AI) but must still be found here.
  const { data: existing, error: findErr } = await supabase
    .from('users')
    .select('*')
    .eq('google_sub', googleSub)
    .maybeSingle();

  if (findErr) {
    logger.error('[UserDB] findOrCreateGoogleUser lookup failed', { error: findErr.message });
    throw findErr;
  }

  if (existing) {
    // Tenant-isolation guard: the resolved org (from the verified email domain)
    // must match the org this Google account was provisioned into. If they
    // differ (e.g. the account's domain now maps to a different org), refuse
    // rather than silently keep the old org — a controlled migration must be
    // done by an admin. Prevents stale cross-tenant access.
    if (existing.organization_id !== organizationId) {
      logger.warn('[UserDB] Google user org mismatch — refusing login', {
        userId: existing.id, existingOrg: existing.organization_id, resolvedOrg: organizationId
      });
      const err = new Error('Your account is linked to a different organization. Please contact your administrator.');
      err.statusCode = 403;
      throw err;
    }

    // Keep profile fresh; ensure supabase_user_id is set for RLS.
    const updates = {};
    if (existing.supabase_user_id !== existing.id) updates.supabase_user_id = existing.id;
    if (email && existing.email !== email) updates.email = email;
    if (displayName && existing.display_name !== displayName) updates.display_name = displayName;
    if (Object.keys(updates).length > 0) {
      const { error: updErr } = await supabase.from('users').update(updates).eq('id', existing.id);
      if (updErr) {
        logger.error('[UserDB] Failed to update existing google user', { userId: existing.id, error: updErr.message });
        throw updErr;
      }
      Object.assign(existing, updates);
    }
    await ensureGoogleUserMembership(supabase, existing.id, existing.organization_id);
    return existing;
  }

  // Cross-provider link (spec 2026-07-03 google-login-duplicate-users, AC1/AC2):
  // the same human may already exist in this org from the Atlassian flow
  // (google_sub NULL). Creating a second row would split their tracking history
  // across two identities (observed in prod). Exactly one same-email row in the
  // resolved org → attach the Google identity to it; ambiguous (2+) or none →
  // fall through to create. auth_provider is intentionally left untouched.
  if (email) {
    // Escape ilike wildcards so a literal email can't widen the match.
    const emailPattern = email.replace(/([%_\\])/g, '\\$1');
    const { data: sameEmail, error: emailErr } = await supabase
      .from('users')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .ilike('email', emailPattern)
      .limit(2);

    if (emailErr) {
      logger.error('[UserDB] findOrCreateGoogleUser email-link lookup failed', { error: emailErr.message });
      throw emailErr;
    }

    if (sameEmail && sameEmail.length === 1) {
      const match = sameEmail[0];
      const updates = { google_sub: googleSub };
      if (match.supabase_user_id !== match.id) updates.supabase_user_id = match.id;
      if (displayName && match.display_name !== displayName) updates.display_name = displayName;

      const { error: linkUpdErr } = await supabase.from('users').update(updates).eq('id', match.id);
      if (linkUpdErr) {
        logger.error('[UserDB] Failed to link google identity to existing user', { userId: match.id, error: linkUpdErr.message });
        throw linkUpdErr;
      }
      Object.assign(match, updates);
      await ensureGoogleUserMembership(supabase, match.id, match.organization_id);
      logger.info('[UserDB] Linked google identity to existing same-email user', { userId: match.id, organizationId });
      return match;
    }
    if (sameEmail && sameEmail.length > 1) {
      logger.warn('[UserDB] Multiple same-email users in org — cannot auto-link google identity, creating new user', {
        organizationId, matches: sameEmail.map((u) => u.id)
      });
    }
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
    // Concurrent first-login race: another request inserted the same google_sub
    // between our lookup and insert (Postgres unique_violation = 23505).
    // Re-fetch the now-existing row instead of failing.
    if (createErr.code === '23505') {
      logger.info('[UserDB] findOrCreateGoogleUser race — re-fetching existing google user');
      const { data: raced } = await supabase
        .from('users')
        .select('*')
        .eq('google_sub', googleSub)
        .maybeSingle();
      if (raced) {
        await ensureGoogleUserMembership(supabase, raced.id, raced.organization_id);
        return raced;
      }
    }
    logger.error('[UserDB] findOrCreateGoogleUser insert failed', { error: createErr.message });
    throw createErr;
  }

  // Set supabase_user_id = id so RLS (WHERE supabase_user_id = auth.uid()) resolves.
  // supabase update() returns { error } rather than throwing — must check it, or a
  // silent failure leaves RLS unable to resolve this user (all desktop calls 401/empty).
  const { error: linkErr } = await supabase
    .from('users')
    .update({ supabase_user_id: created.id })
    .eq('id', created.id);
  if (linkErr) {
    logger.error('[UserDB] Failed to set supabase_user_id (RLS would not resolve user)', { userId: created.id, error: linkErr.message });
    throw linkErr;
  }
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
