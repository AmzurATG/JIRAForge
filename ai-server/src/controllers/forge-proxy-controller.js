/**
 * Forge Proxy Controller
 * Handles Supabase operations proxied from the Forge app
 * All requests are authenticated via Forge Invocation Token (FIT)
 */

const logger = require('../utils/logger');
const { getClient } = require('../services/db/supabase-client');
const { getUTCISOString } = require('../utils/datetime');
const sessionStore = require('../services/feedback-session-store');

// SECURITY: Tables that require organization_id filtering for multi-tenancy
const SENSITIVE_TABLES = new Set([
  'screenshots', 'analysis_results', 'users', 'documents', 'worklogs',
  'activity_log', 'unassigned_activity', 'unassigned_work_groups',
  'user_jira_issues_cache', 'created_issues_log', 'daily_time_summary',
  'weekly_time_summary', 'project_time_summary', 'tracking_settings',
  'organization_settings', 'organization_members'
]);

// Reserved PostgREST query parameters that should not be used as column names
const RESERVED_PARAMS = new Set(['order', 'limit', 'offset', 'select', 'on_conflict']);

/**
 * Log security warnings for sensitive table access without org filter
 */
function logSecurityWarnings(table, method, query, body, cloudId, accountId) {
  const hasOrgFilter = query?.eq?.organization_id ||
                       query?.eq?.jira_cloud_id ||
                       body?.organization_id ||
                       body?.jira_cloud_id;

  if (!SENSITIVE_TABLES.has(table) || hasOrgFilter) return;

  const upperMethod = (method || 'GET').toUpperCase();
  if (upperMethod === 'GET' || upperMethod === 'SELECT') {
    logger.warn('[ForgeProxy] SECURITY: Query to sensitive table without organization filter', {
      table, cloudId, accountId, queryFilters: Object.keys(query?.eq || {})
    });
  } else if (upperMethod === 'POST' || upperMethod === 'INSERT') {
    logger.warn('[ForgeProxy] SECURITY: INSERT to sensitive table without organization_id', { table, cloudId });
  }
}

/**
 * Apply a single filter type (eq, neq, gt, etc.) to the query builder
 */
function applyColumnFilter(queryBuilder, filterType, filters) {
  for (const [col, val] of Object.entries(filters)) {
    queryBuilder = queryBuilder[filterType](col, val);
  }
  return queryBuilder;
}

/**
 * Handle 'eq' filters with reserved parameter checks
 */
function applyEqFilters(queryBuilder, eqFilters) {
  for (const [col, val] of Object.entries(eqFilters)) {
    if (RESERVED_PARAMS.has(col)) {
      logger.warn('[ForgeProxy] Skipping reserved parameter as filter', { col, val });
      if (col === 'order' && typeof val === 'string') {
        queryBuilder = handleOrderParam(queryBuilder, val);
      }
      continue;
    }
    queryBuilder = queryBuilder.eq(col, val);
  }
  return queryBuilder;
}

/**
 * Handle 'neq' filters with reserved parameter checks
 */
function applyNeqFilters(queryBuilder, neqFilters) {
  for (const [col, val] of Object.entries(neqFilters)) {
    if (RESERVED_PARAMS.has(col)) {
      logger.warn('[ForgeProxy] Skipping reserved parameter as neq filter', { col, val });
      continue;
    }
    queryBuilder = queryBuilder.neq(col, val);
  }
  return queryBuilder;
}

/**
 * Handle 'not' filters (negated conditions)
 */
function applyNotFilters(queryBuilder, notFilters) {
  for (const [col, filterDef] of Object.entries(notFilters)) {
    queryBuilder = queryBuilder.not(col, filterDef.operator, filterDef.value);
  }
  return queryBuilder;
}

/**
 * Parse and apply order parameter from string format "column.direction"
 */
function handleOrderParam(queryBuilder, orderVal) {
  const dotIndex = orderVal.lastIndexOf('.');
  if (dotIndex > 0) {
    const column = orderVal.substring(0, dotIndex);
    const direction = orderVal.substring(dotIndex + 1);
    queryBuilder = queryBuilder.order(column, { ascending: direction !== 'desc' });
  }
  return queryBuilder;
}

/**
 * Apply all query filters to the query builder for GET/SELECT operations
 */
function applyQueryFilters(queryBuilder, query) {
  if (!query) return queryBuilder;

  for (const [key, value] of Object.entries(query)) {
    queryBuilder = applySingleFilter(queryBuilder, key, value, query);
  }
  return queryBuilder;
}

/**
 * Apply a single filter based on key type
 */
function applySingleFilter(queryBuilder, key, value, query) {
  switch (key) {
    case 'eq':
      return applyEqFilters(queryBuilder, value);
    case 'neq':
      return applyNeqFilters(queryBuilder, value);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'in':
    case 'is':
      return applyColumnFilter(queryBuilder, key, value);
    case 'not':
      return applyNotFilters(queryBuilder, value);
    case 'order':
      return queryBuilder.order(value.column, { ascending: value.ascending ?? true });
    case 'limit':
      return queryBuilder.limit(value);
    case 'offset':
      return queryBuilder.range(value, value + (query.limit || 1000) - 1);
    case 'or':
      return queryBuilder.or(value);
    case 'single':
      return queryBuilder.single();
    case 'maybeSingle':
      return queryBuilder.maybeSingle();
    case '_select':
      return queryBuilder; // Handled separately
    default:
      return queryBuilder;
  }
}

/**
 * Apply common filters (eq, in, is) to update/delete builders
 */
function applyMutationFilters(builder, query) {
  if (query?.eq) {
    builder = applyColumnFilter(builder, 'eq', query.eq);
  }
  if (query?.in) {
    builder = applyColumnFilter(builder, 'in', query.in);
  }
  if (query?.is) {
    builder = applyColumnFilter(builder, 'is', query.is);
  }
  return builder;
}

/**
 * Prepare update payload, handling screenshot soft-delete specially
 */
function prepareUpdatePayload(table, body, query) {
  const payload = body && typeof body === 'object' ? body : {};
  
  if (table !== 'screenshots') return payload;
  
  const isSoftDelete = payload.deleted_at != null || payload.status === 'deleted';
  if (!isSoftDelete) return payload;

  logger.info('[ForgeProxy] Screenshot soft-delete', {
    screenshotId: query?.eq?.id,
    deleted_at: payload.deleted_at,
    status: payload.status
  });

  if (payload.deleted_at != null && payload.updated_at == null) {
    payload.updated_at = getUTCISOString();
  }
  return payload;
}

/**
 * Execute GET/SELECT query
 */
async function executeSelect(queryBuilder) {
  return queryBuilder;
}

/**
 * Execute INSERT query
 */
async function executeInsert(supabase, table, body) {
  return supabase.from(table).insert(body).select();
}

/**
 * Execute UPDATE/PATCH query
 */
async function executeUpdate(supabase, table, body, query) {
  const payload = prepareUpdatePayload(table, body, query);
  let builder = supabase.from(table).update(payload);
  builder = applyMutationFilters(builder, query);
  return builder.select();
}

/**
 * Execute DELETE query
 */
async function executeDelete(supabase, table, query) {
  let builder = supabase.from(table).delete();
  builder = applyMutationFilters(builder, query);
  return builder;
}

/**
 * Execute the appropriate database operation based on method
 */
async function executeMethod(supabase, method, table, queryBuilder, body, query) {
  switch (method) {
    case 'GET':
    case 'SELECT':
      return executeSelect(queryBuilder);
    case 'POST':
    case 'INSERT':
      return executeInsert(supabase, table, body);
    case 'PATCH':
    case 'UPDATE':
      return executeUpdate(supabase, table, body, query);
    case 'DELETE':
      return executeDelete(supabase, table, query);
    default:
      return { error: { message: `Unsupported method: ${method}` }, unsupported: true };
  }
}

/**
 * Initialize query builder with select columns
 */
function initQueryBuilder(supabase, table, select, querySelect, method) {
  let queryBuilder = supabase.from(table);
  const selectColumns = select || querySelect;
  
  if (selectColumns) {
    return queryBuilder.select(selectColumns);
  }
  if (!method || method === 'GET') {
    return queryBuilder.select('*');
  }
  return queryBuilder;
}

/**
 * Generic Supabase REST API proxy
 * Handles any table operation from the Forge app
 */
exports.supabaseQuery = async (req, res) => {
  try {
    const { table, method, query, body, select } = req.body;
    const { cloudId, accountId } = req.forgeContext;

    if (!table) {
      return res.status(400).json({ success: false, error: 'Table name is required' });
    }

    const supabase = getClient();
    if (!supabase) {
      return res.status(500).json({ success: false, error: 'Database not configured' });
    }

    logger.info('[ForgeProxy] Supabase query', { table, method: method || 'GET', cloudId });

    logSecurityWarnings(table, method, query, body, cloudId, accountId);

    const upperMethod = (method || 'GET').toUpperCase();
    let queryBuilder = initQueryBuilder(supabase, table, select, query?._select, method);

    // Apply query filters for GET/SELECT only
    if (upperMethod === 'GET' || upperMethod === 'SELECT') {
      queryBuilder = applyQueryFilters(queryBuilder, query);
    }

    const result = await executeMethod(supabase, upperMethod, table, queryBuilder, body, query);

    if (result.unsupported) {
      return res.status(400).json({ success: false, error: result.error.message });
    }

    if (result.error) {
      logger.error('[ForgeProxy] Supabase error', { table, error: result.error.message });
      return res.status(400).json({ success: false, error: result.error.message });
    }

    res.json({ success: true, data: result.data });
  } catch (error) {
    logger.error('[ForgeProxy] Query error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Get or create organization by Jira Cloud ID
 */
exports.getOrCreateOrganization = async (req, res) => {
  try {
    const { cloudId } = req.forgeContext;
    const { orgName, jiraUrl } = req.body;

    // Validate cloudId - required for organization lookup/creation
    if (!cloudId) {
      logger.error('[ForgeProxy] Missing cloudId in forgeContext');
      return res.status(400).json({
        success: false,
        error: 'Missing cloudId in authentication context. Please re-authenticate.'
      });
    }

    const supabase = getClient();
    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Database not configured'
      });
    }

    logger.info('[ForgeProxy] Get/Create organization', { cloudId });

    // Try to find existing organization
    const { data: existingOrgs, error: findError } = await supabase
      .from('organizations')
      .select('*')
      .eq('jira_cloud_id', cloudId);

    if (findError) {
      throw findError;
    }

    if (existingOrgs && existingOrgs.length > 0) {
      const existingOrg = existingOrgs[0];
      
      // Update organization if we have better info now (fix "Unknown Organization" issue)
      if (orgName && orgName !== 'Unknown Organization' && 
          (existingOrg.org_name === 'Unknown Organization' || 
           existingOrg.jira_instance_url?.includes(cloudId))) {
        logger.info('[ForgeProxy] Updating organization with better info', { 
          id: existingOrg.id, 
          oldName: existingOrg.org_name, 
          newName: orgName 
        });
        
        const { data: updatedOrg, error: updateError } = await supabase
          .from('organizations')
          .update({
            org_name: orgName,
            jira_instance_url: jiraUrl || existingOrg.jira_instance_url,
            updated_at: getUTCISOString()
          })
          .eq('id', existingOrg.id)
          .select()
          .single();
        
        if (!updateError && updatedOrg) {
          return res.json({
            success: true,
            data: updatedOrg
          });
        }
      }
      
      logger.info('[ForgeProxy] Found existing organization', { id: existingOrg.id });
      return res.json({
        success: true,
        data: existingOrg
      });
    }

    // Create new organization
    const { data: newOrg, error: createError } = await supabase
      .from('organizations')
      .insert({
        jira_cloud_id: cloudId,
        org_name: orgName || 'Unknown Organization',
        jira_instance_url: jiraUrl || `https://${cloudId}.atlassian.net`,
        subscription_status: 'active',
        subscription_tier: 'free'
      })
      .select()
      .single();

    if (createError) {
      throw createError;
    }

    // Create default organization settings
    await supabase
      .from('organization_settings')
      .insert({
        organization_id: newOrg.id,
        screenshot_interval: 300,
        auto_worklog_enabled: true
      });

    logger.info('[ForgeProxy] Created new organization', { id: newOrg.id });

    res.json({
      success: true,
      data: newOrg
    });
  } catch (error) {
    logger.error('[ForgeProxy] Organization error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Get or create user by Atlassian account ID
 */
exports.getOrCreateUser = async (req, res) => {
  try {
    const { accountId, cloudId } = req.forgeContext;
    const { organizationId, email, displayName } = req.body;

    // Validate accountId - required for user creation
    if (!accountId) {
      logger.error('[ForgeProxy] Missing accountId in forgeContext', { cloudId });
      return res.status(400).json({
        success: false,
        error: 'Missing accountId in authentication context. Please re-authenticate.'
      });
    }

    const supabase = getClient();
    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Database not configured'
      });
    }

    logger.info('[ForgeProxy] Get/Create user', { accountId, cloudId });

    // Try to find existing user
    const { data: existingUsers, error: findError } = await supabase
      .from('users')
      .select('id, organization_id, email, display_name')
      .eq('atlassian_account_id', accountId);

    if (findError) {
      throw findError;
    }

    if (existingUsers && existingUsers.length > 0) {
      const user = existingUsers[0];
      let updated = false;

      // Update organization_id if provided and different
      if (organizationId && user.organization_id !== organizationId) {
        await supabase
          .from('users')
          .update({ organization_id: organizationId })
          .eq('id', user.id);
        updated = true;

        // Ensure organization membership
        await ensureOrganizationMembership(supabase, user.id, organizationId);
      }

      // Update user details if missing
      if ((!user.email || !user.display_name) && (email || displayName)) {
        await supabase
          .from('users')
          .update({
            email: email || user.email,
            display_name: displayName || user.display_name,
            updated_at: getUTCISOString()
          })
          .eq('id', user.id);
        updated = true;
      }

      logger.info('[ForgeProxy] Found existing user', { id: user.id, updated });

      return res.json({
        success: true,
        data: { userId: user.id }
      });
    }

    // Create new user
    const { data: newUser, error: createError } = await supabase
      .from('users')
      .insert({
        atlassian_account_id: accountId,
        organization_id: organizationId,
        email: email || null,
        display_name: displayName || null
      })
      .select()
      .single();

    if (createError) {
      throw createError;
    }

    // Create organization membership
    if (organizationId) {
      await ensureOrganizationMembership(supabase, newUser.id, organizationId);
    }

    logger.info('[ForgeProxy] Created new user', { id: newUser.id });

    res.json({
      success: true,
      data: { userId: newUser.id }
    });
  } catch (error) {
    logger.error('[ForgeProxy] User error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Get user's organization membership
 */
exports.getOrganizationMembership = async (req, res) => {
  try {
    const { userId, organizationId } = req.body;

    const supabase = getClient();
    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Database not configured'
      });
    }

    const { data, error } = await supabase
      .from('organization_members')
      .select('*')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.error('[ForgeProxy] Membership error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Storage operations - Upload file
 */
exports.storageUpload = async (req, res) => {
  try {
    const { bucket, path, data, contentType } = req.body;
    const { cloudId } = req.forgeContext;

    const supabase = getClient();
    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Database not configured'
      });
    }

    logger.info('[ForgeProxy] Storage upload', { bucket, path, cloudId });

    // Convert base64 data to buffer
    const buffer = Buffer.from(data, 'base64');

    const { data: uploadData, error } = await supabase.storage
      .from(bucket)
      .upload(path, buffer, {
        contentType: contentType || 'application/octet-stream',
        upsert: true
      });

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      data: uploadData
    });
  } catch (error) {
    logger.error('[ForgeProxy] Storage upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Storage operations - Generate signed URL
 */
exports.storageSignedUrl = async (req, res) => {
  try {
    const { bucket, path, expiresIn } = req.body;

    const supabase = getClient();
    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Database not configured'
      });
    }

    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(path, expiresIn || 3600);

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      data: { signedUrl: data.signedUrl }
    });
  } catch (error) {
    logger.error('[ForgeProxy] Signed URL error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Storage operations - Delete file
 */
exports.storageDelete = async (req, res) => {
  try {
    const { bucket, path } = req.body;

    const supabase = getClient();
    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Database not configured'
      });
    }

    const { error } = await supabase.storage
      .from(bucket)
      .remove([path]);

    if (error) {
      throw error;
    }

    res.json({
      success: true
    });
  } catch (error) {
    logger.error('[ForgeProxy] Storage delete error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Ensure organization membership exists
 * @param {Object} supabase - Supabase client
 * @param {string} userId - User UUID
 * @param {string} organizationId - Organization UUID
 */
async function ensureOrganizationMembership(supabase, userId, organizationId) {
  try {
    // Check if membership exists
    const { data: existing } = await supabase
      .from('organization_members')
      .select('id')
      .eq('user_id', userId)
      .eq('organization_id', organizationId);

    if (existing && existing.length > 0) {
      return;
    }

    // Check if this is the first member
    const { data: allMembers } = await supabase
      .from('organization_members')
      .select('id')
      .eq('organization_id', organizationId);

    const isFirstUser = !allMembers || allMembers.length === 0;
    const role = isFirstUser ? 'owner' : 'member';

    // Create membership
    const ADMIN_ROLES = new Set(['owner', 'admin']);
    const ANALYTICS_ROLES = new Set(['owner', 'admin', 'manager']);
    await supabase
      .from('organization_members')
      .insert({
        user_id: userId,
        organization_id: organizationId,
        role: role,
        can_manage_settings: ADMIN_ROLES.has(role),
        can_view_team_analytics: ANALYTICS_ROLES.has(role),
        can_manage_members: ADMIN_ROLES.has(role),
        can_delete_screenshots: ADMIN_ROLES.has(role),
        can_manage_billing: role === 'owner'
      });

    logger.info('[ForgeProxy] Created organization membership', { userId, organizationId, role });
  } catch (error) {
    logger.error('[ForgeProxy] Membership creation error:', error);
  }
}

/**
 * Applies user visibility filter to a Supabase query.
 * - Regular users: scoped to their own data
 * - Project admins: own data + team data from their administered projects
 * - Jira/org admins: no additional filter (see everything)
 */
function applyVisibilityFilter(query, userIdCol, projectKeyCol, { canViewTeamData, shouldFilterByProjects, userId, projectKeys }) {
  if (!canViewTeamData) {
    query.eq(userIdCol, userId);
  } else if (shouldFilterByProjects) {
    query.or(`${userIdCol}.eq.${userId},${projectKeyCol}.in.(${projectKeys.join(',')})`);
  }
  return query;
}

/**
 * Builds the users query based on the caller's permission level.
 * - Regular user: returns only themselves (no DB query needed)
 * - Project admin: two-step — find user IDs from their projects, then fetch user details
 * - Jira/org admin: all active users in the organization
 */
async function buildUsersQuery(supabase, { canViewTeamData, shouldFilterByProjects, userId, user, organization, projectKeys, maxDailySummaryDays }) {
  if (!canViewTeamData) {
    return { data: [{ id: userId, display_name: user.display_name, email: user.email }] };
  }

  if (!shouldFilterByProjects) {
    return supabase
      .from('users')
      .select('id, display_name, email')
      .eq('organization_id', organization.id)
      .eq('is_active', true);
  }

  // Project admin: find users who tracked time on their projects within the same date window
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxDailySummaryDays);
  const cutoffDateStr = cutoffDate.toISOString().split('T')[0];

  const result = await supabase
    .from('daily_time_summary')
    .select('user_id')
    .eq('organization_id', organization.id)
    .or(`project_key.in.(${projectKeys.join(',')}),user_id.eq.${userId}`)
    .gte('work_date', cutoffDateStr);

  if (result.error) throw result.error;

  const userIds = [...new Set((result.data || []).map(r => r.user_id))];
  if (!userIds.includes(userId)) {
    userIds.push(userId);
  }
  if (userIds.length === 0) {
    return { data: [{ id: userId, display_name: user.display_name, email: user.email }] };
  }

  return supabase
    .from('users')
    .select('id, display_name, email')
    .in('id', userIds)
    .eq('organization_id', organization.id)
    .eq('is_active', true);
}

/**
 * Batch Dashboard Endpoint
 * Fetches all data needed for the dashboard in a single request
 * Reduces 8+ API calls to 1, significantly improving performance
 */
exports.getDashboardData = async (req, res) => {
  try {
    const { cloudId, accountId } = req.forgeContext;
    const {
      canViewAllUsers = false,  // Whether user has admin privileges
      isJiraAdmin = false,      // Whether user is Jira admin (sees all data)
      projectKeys = null,       // For project admins: array of project keys to filter by; for Jira admins: null (no project restriction)
      maxDailySummaryDays = 60, // Date range in days (not row limit) - covers current + previous month
      maxWeeklySummaryWeeks = 12,
      maxIssuesInAnalytics = 50
    } = req.body;

    // Calculate date cutoffs for time-based filtering (industry standard: filter by date, not row count)
    const dailyCutoffDate = new Date();
    dailyCutoffDate.setDate(dailyCutoffDate.getDate() - maxDailySummaryDays);
    const dailyCutoffStr = dailyCutoffDate.toISOString().split('T')[0];

    const weeklyCutoffDate = new Date();
    weeklyCutoffDate.setDate(weeklyCutoffDate.getDate() - (maxWeeklySummaryWeeks * 7));
    const weeklyCutoffStr = weeklyCutoffDate.toISOString().split('T')[0];

    const supabase = getClient();
    if (!supabase) {
      return res.status(500).json({ success: false, error: 'Database not configured' });
    }

    // Determine if we should filter by specific projects
    // Project admins (not Jira admins) should only see their projects' data
    const isProjectAdmin = canViewAllUsers && !isJiraAdmin;
    const hasValidProjectKeys = Array.isArray(projectKeys) && projectKeys.length > 0;
    const shouldFilterByProjects = isProjectAdmin && hasValidProjectKeys;

    // Security: If user is project admin but has empty/missing projectKeys, reject the request
    // This prevents accidental exposure of org-wide data when project discovery fails
    if (isProjectAdmin && !hasValidProjectKeys) {
      logger.warn('[ForgeProxy] Project admin with no valid projectKeys - rejecting', { cloudId, accountId });
      return res.status(403).json({
        success: false,
        error: 'Project admin access requires valid project keys. No projects found for your admin permissions.'
      });
    }

    logger.info('[ForgeProxy] Dashboard batch request', {
      cloudId,
      accountId,
      isJiraAdmin,
      shouldFilterByProjects,
      projectKeysCount: shouldFilterByProjects ? projectKeys.length : 'all'
    });

    // 1. Get or verify organization
    const { data: orgs, error: orgError } = await supabase
      .from('organizations')
      .select('*')
      .eq('jira_cloud_id', cloudId);

    if (orgError) throw orgError;
    if (!orgs || orgs.length === 0) {
      return res.status(404).json({ success: false, error: 'Organization not found. Please reload the page.' });
    }
    const organization = orgs[0];

    // 2. Get or verify user
    const { data: users, error: userError } = await supabase
      .from('users')
      .select('id, organization_id, email, display_name')
      .eq('atlassian_account_id', accountId);

    if (userError) throw userError;
    if (!users || users.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found. Please reload the page.' });
    }
    const user = users[0];
    const userId = user.id;

    // 3. Get membership in a single query
    const { data: membership } = await supabase
      .from('organization_members')
      .select('*')
      .eq('user_id', userId)
      .eq('organization_id', organization.id)
      .single();

    // Determine if user can view all data
    const canViewTeamData = canViewAllUsers || membership?.can_view_team_analytics || false;
    const filterCtx = { canViewTeamData, shouldFilterByProjects, userId, projectKeys };

    // 4. Build all queries — visibility filters applied via helper to avoid repetition
    // Industry standard: filter by DATE RANGE, not row count
    const dailyQuery = applyVisibilityFilter(
      supabase.from('daily_time_summary').select('*')
        .eq('organization_id', organization.id)
        .gte('work_date', dailyCutoffStr)
        .order('work_date', { ascending: false }),
      'user_id', 'project_key', filterCtx
    );

    const weeklyQuery = applyVisibilityFilter(
      supabase.from('weekly_time_summary').select('*')
        .eq('organization_id', organization.id)
        .gte('week_start', weeklyCutoffStr)
        .order('week_start', { ascending: false }),
      'user_id', 'project_key', filterCtx
    );

    // Project summary — aggregated by project, filtered differently from row-level queries
    const projectQuery = supabase
      .from('project_time_summary')
      .select('*')
      .eq('organization_id', organization.id)
      .order('total_seconds', { ascending: false });
    if (shouldFilterByProjects) {
      projectQuery.in('project_key', projectKeys);
    }

    const analysisQuery = applyVisibilityFilter(
      supabase.from('analysis_results')
        .select('active_task_key, active_project_key, work_type, screenshots(duration_seconds)')
        .eq('organization_id', organization.id)
        .not('active_task_key', 'is', null)
        .order('created_at', { ascending: false }),
      'user_id', 'active_project_key', filterCtx
    );

    // 5. Execute all queries in parallel
    const [dailyResult, weeklyResult, projectResult, analysisResult, allUsersResult] = await Promise.all([
      dailyQuery,
      weeklyQuery,
      projectQuery,
      analysisQuery,
      buildUsersQuery(supabase, { canViewTeamData, shouldFilterByProjects, userId, user, organization, projectKeys, maxDailySummaryDays })
    ]);

    // Process analysis results to aggregate time by issue
    const timeByIssue = aggregateTimeByIssue(analysisResult.data || [], maxIssuesInAnalytics);

    logger.info('[ForgeProxy] Dashboard batch complete', {
      cloudId,
      dailyCount: dailyResult.data?.length || 0,
      weeklyCount: weeklyResult.data?.length || 0,
      projectCount: projectResult.data?.length || 0
    });

    res.json({
      success: true,
      data: {
        // Organization info - matching legacy format
        organizationId: organization.id,
        organizationName: organization.org_name,
        // User info
        userId: userId,
        userDisplayName: user.display_name,
        userEmail: user.email,
        // Membership info
        membership: membership || null,
        canViewAllUsers: canViewTeamData,
        // Analytics data - matching legacy format exactly
        dailySummary: dailyResult.data || [],
        weeklySummary: weeklyResult.data || [],
        timeByProject: projectResult.data || [],
        timeByIssue: timeByIssue,
        allUsers: allUsersResult.data || []
      }
    });
  } catch (error) {
    logger.error('[ForgeProxy] Dashboard batch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Get latest app version for Forge app
 * Returns the latest desktop app version info for update notifications
 */
exports.getLatestAppVersion = async (req, res) => {
  try {
    const { platform = 'windows', currentVersion } = req.body;
    const { cloudId } = req.forgeContext;

    const supabase = getClient();
    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Database not configured'
      });
    }

    logger.info('[ForgeProxy] Getting latest app version', { platform, currentVersion, cloudId });

    // Get the latest release for the platform
    const { data: release, error } = await supabase
      .from('app_releases')
      .select('version, download_url, release_notes, is_mandatory, min_supported_version, file_size_bytes, published_at')
      .eq('platform', platform.toLowerCase())
      .eq('is_latest', true)
      .eq('is_active', true)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    // If no release found, return default
    if (!release) {
      return res.json({
        success: true,
        data: {
          latestVersion: '1.0.0',
          downloadUrl: null,
          releaseNotes: null,
          updateAvailable: false,
          isMandatory: false
        }
      });
    }

    // Compare versions if current version provided
    let updateAvailable = false;
    if (currentVersion) {
      updateAvailable = isNewerVersion(release.version, currentVersion);
    }

    res.json({
      success: true,
      data: {
        latestVersion: release.version,
        downloadUrl: release.download_url,
        releaseNotes: release.release_notes,
        isMandatory: release.is_mandatory,
        minSupportedVersion: release.min_supported_version,
        fileSizeBytes: release.file_size_bytes,
        publishedAt: release.published_at,
        updateAvailable,
        currentVersion: currentVersion || null
      }
    });

  } catch (error) {
    logger.error('[ForgeProxy] Get latest app version error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Compare two semantic versions
 * @param {string} v1 - Version to compare
 * @param {string} v2 - Version to compare against
 * @returns {boolean} True if v1 is newer than v2
 */
function isNewerVersion(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    
    if (p1 > p2) return true;
    if (p1 < p2) return false;
  }
  
  return false; // Versions are equal
}

/**
 * Helper function to aggregate time by issue
 * @param {Array} results - Analysis results with screenshots
 * @param {number} limit - Maximum issues to return
 * @returns {Array} Aggregated time by issue
 */
function aggregateTimeByIssue(results, limit) {
  const issueAggregation = {};
  
  results.forEach(result => {
    const key = result.active_task_key;
    if (!key) return;
    
    if (!issueAggregation[key]) {
      issueAggregation[key] = {
        issueKey: key,
        projectKey: result.active_project_key,
        totalSeconds: 0
      };
    }
    issueAggregation[key].totalSeconds += result.screenshots?.duration_seconds || 0;
  });

  return Object.values(issueAggregation)
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .slice(0, limit);
}

/**
 * Create feedback session for Forge app
 * Uses FIT-authenticated context to get user info from Jira API
 * Returns a feedback URL that can be opened in a new browser tab
 *
 * POST /api/forge/feedback/session
 */
exports.createFeedbackSession = async (req, res) => {
  try {
    const { cloudId, accountId } = req.forgeContext;

    if (!cloudId || !accountId) {
      return res.status(400).json({
        success: false,
        error: 'Missing cloudId or accountId in authentication context'
      });
    }

    // Get user info from our database (already synced from Jira)
    const supabase = getClient();
    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Database not configured'
      });
    }

    // Find user by Atlassian account ID
    const { data: users, error: userError } = await supabase
      .from('users')
      .select('email, display_name')
      .eq('atlassian_account_id', accountId)
      .limit(1);

    if (userError) {
      logger.error('[ForgeProxy] Error fetching user for feedback:', userError);
    }

    const user = users?.[0];
    const userEmail = user?.email || `${accountId}@atlassian.user`;
    const userName = user?.display_name || 'Forge App User';

    // Create session using the existing feedback session store
    const sessionId = sessionStore.createSession({
      atlassianToken: null, // Not needed - we use FIT auth
      cloudId: cloudId,
      userInfo: {
        account_id: accountId,
        email: userEmail,
        name: userName
      }
    });

    // Build feedback form URL (using /api prefix so nginx forwards to AI server)
    const protocol = req.protocol;
    const host = req.get('host');
    const feedbackUrl = `${protocol}://${host}/api/feedback/form?session=${sessionId}`;

    logger.info('[ForgeProxy] Feedback session created for Forge user %s', accountId);

    res.json({
      success: true,
      data: {
        feedbackUrl,
        sessionId
      }
    });

  } catch (error) {
    logger.error('[ForgeProxy] Feedback session creation error:', error);
    res.status(500).json({
      success: false,
      error: `Failed to create feedback session: ${error.message}`
    });
  }
};

