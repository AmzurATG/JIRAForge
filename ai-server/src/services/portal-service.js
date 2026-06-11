/**
 * Portal Service
 * 
 * Business logic for portal analytics and aggregations.
 * Queries activity_records table directly for portal analytics.
 */

'use strict';

const logger = require('../utils/logger');
const { getClient } = require('./db/supabase-client');
const profileService = require('./portal-employee-profile-service');

function isNonProductiveClassification(classification) {
  return classification === 'non_productive' || classification === 'non-productive';
}

function normalizeClassificationFilter(classification) {
  if (!classification) return classification;
  if (classification === 'non-productive') return 'non_productive';
  return classification;
}

function toPortalClassification(classification) {
  if (classification === 'non_productive') return 'non-productive';
  return classification;
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Canonical category for one activity row (WS-C taxonomy):
 * idle (is_idle) | productive | non-productive (both spellings) | neutral.
 */
function categorizeActivity(row) {
  if (row.is_idle === true) return 'idle';
  if (row.classification === 'productive') return 'productive';
  if (isNonProductiveClassification(row.classification)) return 'non-productive';
  return 'neutral';
}

// Warn once (per process) when the 20260610 category-breakdown migration has
// not been applied — the portal then renders the pre-breakdown view (AC-C6).
let warnedMissingBreakdown = false;
function warnMissingBreakdownOnce(context) {
  if (warnedMissingBreakdown) return;
  warnedMissingBreakdown = true;
  logger.warn('[PortalService] RPC result has no neutral/idle fields — is migration 20260610_portal_analytics_category_breakdown.sql applied?', context);
}

/**
 * Portal Service Class
 */
class PortalService {
  
  /**
   * Get dashboard data (KPIs + daily trend).
   * 
   * @param {string} orgId - Organization ID
   * @param {string} from - Start date (YYYY-MM-DD)
   * @param {string} to - End date (YYYY-MM-DD)
   * @returns {Promise<Object>} Dashboard data
   */
  async getDashboardData(orgId, from, to, visibleUserIds) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    // Empty scope (e.g. a head with no members) → zeroed dashboard, never .in('user_id', []).
    if (Array.isArray(visibleUserIds) && visibleUserIds.length === 0) {
      return {
        summary: { totalProductiveHours: 0, totalNonProductiveHours: 0, totalNeutralHours: 0, productivityPercentage: 0, employeeCount: 0 },
        dailyTrend: []
      };
    }

    // Aggregate server-side via RPC. Summing raw rows in Node hit the PostgREST
    // 1000-row response cap and silently undercounted any range with >1000 rows;
    // the function returns a handful of per-day rows and the exact totals.
    // p_user_ids: array → restrict to those employees (LOB scope); null → all.
    const { data, error } = await supabase.rpc('portal_dashboard_summary', {
      p_from: from,
      p_to: to,
      p_user_ids: Array.isArray(visibleUserIds) ? visibleUserIds : null
    });

    if (error) {
      logger.error('[PortalService] Dashboard summary RPC failed', { orgId, from, to, error });
      throw error;
    }

    const summary = data || {};
    const daily = Array.isArray(summary.daily) ? summary.daily : [];

    // Degraded mode (AC-C6): before the 20260610 migration the RPC rows have
    // no neutral/idle keys — render the pre-breakdown view and warn once.
    // The frontend hides the Neutral card when totalNeutralHours is absent.
    const hasBreakdown = daily.length === 0 || daily.some(day => 'neutral_seconds' in day);
    if (!hasBreakdown) warnMissingBreakdownOnce({ orgId, from, to });

    // The function already orders `daily` by work_date ascending.
    let productiveSeconds = 0;
    let nonProductiveSeconds = 0;
    let neutralSeconds = 0;
    const dailyTrend = daily.map(day => {
      const prod = Number(day.productive_seconds) || 0;
      const nonProd = Number(day.nonproductive_seconds) || 0;
      const neutral = Number(day.neutral_seconds) || 0;
      const idle = Number(day.idle_seconds) || 0;
      productiveSeconds += prod;
      nonProductiveSeconds += nonProd;
      neutralSeconds += neutral;
      const entry = {
        date: day.work_date,
        productiveHours: prod / 3600,
        nonProductiveHours: nonProd / 3600
      };
      if (hasBreakdown) {
        entry.neutralHours = neutral / 3600;
        entry.idleHours = idle / 3600;
      }
      return entry;
    });

    // Productivity % stays productive ÷ (productive + non-productive) —
    // neutral and idle are visible as time but excluded from the ratio.
    const totalSeconds = productiveSeconds + nonProductiveSeconds;
    const productivityPercentage = totalSeconds > 0
      ? (productiveSeconds / totalSeconds) * 100
      : 0;

    const summaryOut = {
      totalProductiveHours: productiveSeconds / 3600,
      totalNonProductiveHours: nonProductiveSeconds / 3600,
      productivityPercentage: Math.round(productivityPercentage * 10) / 10,
      employeeCount: Number(summary.employeeCount) || 0
    };
    if (hasBreakdown) summaryOut.totalNeutralHours = neutralSeconds / 3600;

    return { summary: summaryOut, dailyTrend };
  }
  
  /**
   * Get lightweight employees list for dropdowns (no metrics).
   * 
   * @param {string} orgId - Organization ID (not used, all orgs)
   * @param {string} search - Optional search term
   * @returns {Promise<Array>} Simple user list [{userId, name, email}]
   */
  async getEmployeesList(orgId, search, visibleUserIds) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    // visibleUserIds: array → restrict to those employees (LOB scope); null/undefined → all.
    if (Array.isArray(visibleUserIds) && visibleUserIds.length === 0) return [];

    let userQuery = supabase
      .from('users')
      .select('id, display_name, email')
      .order('display_name', { ascending: true });

    if (Array.isArray(visibleUserIds)) userQuery = userQuery.in('id', visibleUserIds);

    if (search) {
      userQuery = userQuery.or(`display_name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    // Limit to reasonable number for dropdown
    userQuery = userQuery.limit(500);
    
    const { data: users, error: userError } = await userQuery;
    
    if (userError) {
      logger.error('[PortalService] Users query failed', { orgId, error: userError });
      throw userError;
    }
    
    // Format response
    return (users || []).map(user => ({
      userId: user.id,
      name: user.display_name || user.email || 'Unknown User',
      email: user.email
    }));
  }

  /**
   * Get employees list with aggregated metrics.
   * 
   * @param {string} orgId - Organization ID
   * @param {Object} filters - Search, productivity range, date range
   * @param {Object} pagination - page, limit
   * @returns {Promise<Object>} Employees list and pagination
   */
  async getEmployees(orgId, filters, pagination, visibleUserIds) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    let { search, productivityRange, from, to, locationId } = filters;
    const { page = 1, limit = 20 } = pagination;

    // visibleUserIds: array → restrict to those employees (LOB scope); null/undefined → all.
    if (Array.isArray(visibleUserIds) && visibleUserIds.length === 0) {
      return { data: [], pagination: { page, limit, totalCount: 0 } };
    }
    
    // Default to last 30 days if no date range provided (prevent full table scan)
    if (!from || !to) {
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setDate(toDate.getDate() - 30);
      from = from || formatDate(fromDate);
      to = to || formatDate(toDate);
    }
    
    // Aggregate per-employee server-side via RPC. Summing raw rows in Node hit
    // the PostgREST 1000-row cap and undercounted; the function joins users so a
    // second (also cap-prone) lookup is not needed.
    // p_user_ids: array → LOB scope; null → all employees.
    const { data: rows, error } = await supabase.rpc('portal_employee_summary', {
      p_from: from,
      p_to: to,
      p_user_ids: Array.isArray(visibleUserIds) ? visibleUserIds : null
    });

    if (error) {
      logger.error('[PortalService] Employee summary RPC failed', { orgId, from, to, error });
      throw error;
    }

    let employees = (rows || []).map(row => {
      const prod = Number(row.productive_seconds) || 0;
      const nonProd = Number(row.nonproductive_seconds) || 0;
      const totalSeconds = prod + nonProd;
      const productivityPercentage = totalSeconds > 0
        ? (prod / totalSeconds) * 100
        : 0;

      return {
        userId: row.user_id,
        name: row.name || row.email || 'Unknown User',
        email: row.email,
        productiveHours: prod / 3600,
        nonProductiveHours: nonProd / 3600,
        // 0 until migration 20260610_portal_analytics_category_breakdown is applied.
        neutralHours: (Number(row.neutral_seconds) || 0) / 3600,
        idleHours: (Number(row.idle_seconds) || 0) / 3600,
        productivityPercentage: Math.round(productivityPercentage * 10) / 10,
        lastActivityAt: row.last_activity
      };
    });

    // Search by name/email — applied in Node since the function returns the full
    // (already LOB-scoped) employee set.
    if (search) {
      const needle = String(search).toLowerCase();
      employees = employees.filter(emp =>
        (emp.name && emp.name.toLowerCase().includes(needle)) ||
        (emp.email && emp.email.toLowerCase().includes(needle))
      );
    }

    // Filter by productivity range (aligned with frontend: high >=70%, medium 50-70%, low <50%)
    if (productivityRange && productivityRange !== 'all') {
      employees = employees.filter(emp => {
        const pct = emp.productivityPercentage;
        if (productivityRange === 'high') return pct >= 70;
        if (productivityRange === 'medium') return pct >= 50 && pct < 70;
        if (productivityRange === 'low') return pct < 50;
        return true;
      });
    }

    // Location filter (portal_employee_profiles merge) — applied BEFORE
    // pagination so counts stay correct. Without the filter, the (cheaper)
    // page-only merge below suffices.
    if (locationId) {
      const locMap = await profileService.getLocationMapForUsers(employees.map((e) => e.userId));
      employees = employees.filter((e) => locMap[e.userId] && locMap[e.userId].id === locationId);
      employees.forEach((e) => { e.location = locMap[e.userId] || null; });
    }

    // Sort by name
    employees.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Paginate
    const totalCount = employees.length;
    const offset = (page - 1) * limit;
    const paginatedEmployees = employees.slice(offset, offset + limit);

    // Attach each employee's portal location (only the page when unfiltered).
    if (!locationId && paginatedEmployees.length) {
      const locMap = await profileService.getLocationMapForUsers(paginatedEmployees.map((e) => e.userId));
      paginatedEmployees.forEach((e) => { e.location = locMap[e.userId] || null; });
    }

    return {
      data: paginatedEmployees,
      pagination: { page, limit, totalCount }
    };
  }
  
  /**
   * Get employee detail with daily trend.
   * 
   * @param {string} orgId - Organization ID
   * @param {string} userId - User ID
   * @param {string} from - Start date
   * @param {string} to - End date
   * @returns {Promise<Object>} Employee detail
   */
  async getEmployeeDetail(orgId, userId, from, to) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');
    
    // Get user info (no org filter)
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, display_name, email')
      .eq('id', userId)
      .single();
    
    if (userError) {
      logger.error('[PortalService] User query failed', { orgId, userId, error: userError });
      throw userError;
    }

    // Portal-owned location attribute (null when none assigned).
    const locationMap = await profileService.getLocationMapForUsers([userId]);

    // Get activity data (no org filter), fetched in pages. A single request is
    // capped at 1000 rows by PostgREST, which would undercount an active
    // employee over a longer range. Order by the primary key for stable paging.
    // Idle rows are INCLUDED here (WS-C) and bucketed separately below.
    const activities = [];
    const PAGE_SIZE = 1000;
    const MAX_ROWS = 100000; // bound memory on pathological ranges
    let pageStart = 0;
    for (;;) {
      const { data: batch, error: activityError } = await supabase
        .from('activity_records')
        .select('classification, duration_seconds, work_date, is_idle')
        .eq('user_id', userId)
        .gte('work_date', from)
        .lte('work_date', to)
        .order('id', { ascending: true })
        .range(pageStart, pageStart + PAGE_SIZE - 1);

      if (activityError) {
        logger.error('[PortalService] Activity query failed', { orgId, userId, error: activityError });
        throw activityError;
      }

      if (!batch || batch.length === 0) break;
      activities.push(...batch);
      if (activities.length >= MAX_ROWS) {
        // Surface the truncation rather than silently undercounting the totals.
        logger.warn('[PortalService] getEmployeeDetail hit the row ceiling; totals may be truncated', {
          orgId, userId, from, to, maxRows: MAX_ROWS
        });
        break;
      }
      if (batch.length < PAGE_SIZE) break;
      pageStart += PAGE_SIZE;
    }
    
    // Calculate summary — single pass, canonical WS-C taxonomy:
    // Productive / Non-Productive (both spellings) / Neutral (everything
    // else non-idle) / Idle. Active = P + NP + Neutral; Office = Active + Idle.
    const totals = { productive: 0, 'non-productive': 0, neutral: 0, idle: 0 };
    const dailyTrend = {};

    activities.forEach(activity => {
      // Parity with the pre-WS-C `.neq('is_idle', true)` filter and with the
      // SQL aggregates: rows where is_idle IS NULL fall in NO bucket (the old
      // query excluded them entirely; `is_idle <> true` drops NULL in SQL).
      if (activity.is_idle !== true && activity.is_idle !== false) return;
      const seconds = activity.duration_seconds || 0;
      const category = categorizeActivity(activity);
      totals[category] += seconds;

      const date = activity.work_date;
      if (!dailyTrend[date]) {
        dailyTrend[date] = { date, productive: 0, 'non-productive': 0, neutral: 0, idle: 0 };
      }
      dailyTrend[date][category] += seconds;
    });

    const productiveSeconds = totals.productive;
    const nonProductiveSeconds = totals['non-productive'];
    const activeSeconds = productiveSeconds + nonProductiveSeconds + totals.neutral;

    // Productivity % = productive ÷ (productive + non-productive); neutral and
    // idle are shown as time but excluded from the ratio (same denominator as
    // the daily trend below — AC-C4 consistency fix).
    const ratioDenominator = productiveSeconds + nonProductiveSeconds;
    const productivityPercentage = ratioDenominator > 0
      ? (productiveSeconds / ratioDenominator) * 100
      : 0;

    return {
      user: {
        userId: user.id,
        name: user.display_name,
        email: user.email,
        location: locationMap[userId] || null
      },
      summary: {
        productiveHours: productiveSeconds / 3600,
        nonProductiveHours: nonProductiveSeconds / 3600,
        neutralHours: totals.neutral / 3600,
        idleHours: totals.idle / 3600,
        activeHours: activeSeconds / 3600,
        officeHours: (activeSeconds + totals.idle) / 3600,
        productivityPercentage: Math.round(productivityPercentage * 10) / 10
      },
      dailyTrend: Object.values(dailyTrend).map(day => {
        const dayDenominator = day.productive + day['non-productive'];
        return {
          date: day.date,
          productivityPercentage: dayDenominator > 0
            ? Math.round((day.productive / dayDenominator) * 1000) / 10
            : 0,
          productiveHours: day.productive / 3600,
          nonProductiveHours: day['non-productive'] / 3600,
          neutralHours: day.neutral / 3600,
          idleHours: day.idle / 3600,
          // Active time (idle excluded) — same meaning the field had before.
          totalHours: (day.productive + day['non-productive'] + day.neutral) / 3600
        };
      }).sort((a, b) => a.date.localeCompare(b.date))
    };
  }
  
  /**
   * Get time logs with filters.
   * 
   * @param {string} orgId - Organization ID
   * @param {Object} filters - Classification, employee, app, duration, confidence, etc.
   * @param {Object} pagination - page, limit
   * @returns {Promise<Object>} Time logs and pagination
   */
  async getTimeLogs(orgId, filters, pagination, visibleUserIds) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    let { classification, employee, app, from, to, durationMin, durationMax, confidenceMin, confidenceMax, includeIdle } = filters;
    const { page = 1, limit = 20 } = pagination;
    const normalizedClassification = normalizeClassificationFilter(classification);

    // visibleUserIds: array → restrict to those employees (LOB scope); null/undefined → all.
    if (Array.isArray(visibleUserIds) && visibleUserIds.length === 0) {
      return { data: [], pagination: { page, limit, totalCount: 0 } };
    }
    
    // Default to last 7 days if no date range provided (prevent full table scan)
    if (!from || !to) {
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setDate(toDate.getDate() - 7);
      from = from || formatDate(fromDate);
      to = to || formatDate(toDate);
    }
    
    // Build query (no org filter)
    let query = supabase
      .from('activity_records')
      .select(`
        id,
        user_id,
        window_title,
        application_name,
        classification,
        is_idle,
        start_time,
        end_time,
        duration_seconds,
        ocr_confidence,
        users!activity_records_user_id_fkey!inner(display_name, email)
      `, { count: 'estimated' });  // Use estimated count instead of exact to avoid timeout

    // Idle rows stay excluded by default (today's behavior); callers may opt
    // in. Rows with is_idle NULL are excluded on BOTH paths — parity with the
    // SQL aggregates and the employee-detail bucketing, where NULL falls in
    // no bucket (`is_idle <> true` drops NULL in SQL).
    if (includeIdle) {
      query = query.not('is_idle', 'is', null);
    } else {
      query = query.neq('is_idle', true);
    }

    // Apply filters — canonical categories (WS-C):
    //   non_productive matches BOTH stored spellings; neutral = everything
    //   that is neither productive nor non-productive (private/unknown/NULL).
    if (normalizedClassification && normalizedClassification !== 'all') {
      if (normalizedClassification === 'non_productive') {
        query = query.in('classification', ['non_productive', 'non-productive']);
      } else if (normalizedClassification === 'neutral') {
        // Neutral = NOT productive and NOT non-productive (private/unknown/
        // NULL/anything else) — and never a true idle block, even when
        // includeIdle is set (parity with categorizeActivity, which maps
        // is_idle rows to 'idle', not 'neutral').
        query = query
          .eq('is_idle', false)
          .or('classification.is.null,classification.not.in.(productive,non_productive,non-productive)');
      } else {
        query = query.eq('classification', normalizedClassification);
      }
    }
    
    if (employee) {
      query = query.eq('user_id', employee);
    }

    if (Array.isArray(visibleUserIds)) {
      query = query.in('user_id', visibleUserIds);
    }

    if (app) {
      query = query.ilike('application_name', `%${app}%`);
    }
    
    if (from) {
      query = query.gte('start_time', `${from}T00:00:00Z`);
    }
    
    if (to) {
      query = query.lte('end_time', `${to}T23:59:59Z`);
    }
    
    // Duration filters (in seconds)
    if (durationMin !== undefined && durationMin !== null && !isNaN(durationMin)) {
      query = query.gte('duration_seconds', parseInt(durationMin, 10));
    }
    
    if (durationMax !== undefined && durationMax !== null && !isNaN(durationMax)) {
      query = query.lte('duration_seconds', parseInt(durationMax, 10));
    }
    
    // Confidence filters (decimal 0-1)
    if (confidenceMin !== undefined && confidenceMin !== null && !isNaN(confidenceMin)) {
      query = query.gte('ocr_confidence', parseFloat(confidenceMin));
    }
    
    if (confidenceMax !== undefined && confidenceMax !== null && !isNaN(confidenceMax)) {
      query = query.lte('ocr_confidence', parseFloat(confidenceMax));
    }
    
    // Sort and paginate
    // Apply a hard limit BEFORE sorting to prevent full table scan
    const offset = (page - 1) * limit;
    const maxRecords = 10000;  // Max records to consider (prevents timeout on large datasets)
    query = query
      .limit(maxRecords)
      .order('start_time', { ascending: false })
      .range(offset, offset + limit - 1);
    
    const { data, error, count } = await query;
    
    if (error) {
      logger.error('[PortalService] Time logs query failed', { orgId, error });
      throw error;
    }
    
    // Format response
    const formattedData = (data || []).map(record => {
      const userName = record.users?.display_name || record.users?.email || 'Unknown';
      const userEmail = record.users?.email || '';
      const application = record.application_name || 'Unknown';
      const windowTitle = record.window_title || 'No title';

      return {
        recordId: record.id,
        userName,
        userEmail,
        windowTitle,
        application,
        classification: toPortalClassification(record.classification),
        // Canonical category (productive | non-productive | neutral | idle) —
        // what badges/filters should use; `classification` stays raw-ish for
        // backward compatibility.
        category: categorizeActivity(record),
        startTime: record.start_time,
        endTime: record.end_time,
        durationSeconds: record.duration_seconds,
        confidenceScore: record.ocr_confidence || 0,
        employeeName: userName,
        activitySummary: windowTitle,
        applicationName: application
      };
    });
    
    return {
      data: formattedData,
      pagination: { page, limit, totalCount: count || 0 }
    };
  }

  /**
   * Fetch ALL matching time logs across pages (raw rows for CSV export).
   *
   * getTimeLogs returns a single page; a single PostgREST request is capped at
   * 1000 rows, so exports were silently truncated. This walks pages until the
   * result is exhausted, bounded by `maxRecords` to protect memory.
   *
   * @param {string} orgId
   * @param {Object} filters - same shape as getTimeLogs
   * @param {Array|null} visibleUserIds - LOB scope (null = all)
   * @param {number} maxRecords - hard ceiling (default 50000)
   * @returns {Promise<{data: Array, pagination: {totalCount: number}}>}
   */
  async getAllTimeLogs(orgId, filters, visibleUserIds, maxRecords = 50000) {
    const PAGE_SIZE = 1000;
    const all = [];
    let page = 1;

    for (;;) {
      const result = await this.getTimeLogs(orgId, filters, { page, limit: PAGE_SIZE }, visibleUserIds);
      const batch = result.data || [];
      all.push(...batch); // append in place; batch is <= PAGE_SIZE so spread is safe
      if (batch.length < PAGE_SIZE || all.length >= maxRecords) break;
      page += 1;
    }

    if (all.length > maxRecords) all.length = maxRecords; // truncate in place
    return { data: all, pagination: { totalCount: all.length } };
  }

  /**
   * Get application-usage totals (per-application time, sessions, distinct
   * employees), aggregated server-side via RPC to avoid the 1000-row cap.
   *
   * @param {string} orgId
   * @param {Object} filters - { from, to, classification, employee }
   * @param {Array|null} visibleUserIds - LOB scope (null = all)
   * @returns {Promise<{data: Array, pagination: {totalCount: number}}>}
   */
  async getApplicationUsage(orgId, filters, visibleUserIds) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    let { from, to, classification, employee } = filters || {};

    // Fold an explicit employee filter into the scoped user set. If the employee
    // is outside the caller's LOB scope, the result is empty.
    let userIds;
    if (employee) {
      userIds = Array.isArray(visibleUserIds)
        ? (visibleUserIds.includes(employee) ? [employee] : [])
        : [employee];
    } else {
      userIds = visibleUserIds;
    }

    if (Array.isArray(userIds) && userIds.length === 0) {
      return { data: [], pagination: { totalCount: 0 } };
    }

    // Default to last 7 days if no range provided (matches the old getTimeLogs path).
    if (!from || !to) {
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setDate(toDate.getDate() - 7);
      from = from || formatDate(fromDate);
      to = to || formatDate(toDate);
    }

    const normalizedClassification = normalizeClassificationFilter(classification);

    const { data, error } = await supabase.rpc('portal_app_usage_summary', {
      p_from: from,
      p_to: to,
      p_user_ids: Array.isArray(userIds) ? userIds : null,
      p_classification: (normalizedClassification && normalizedClassification !== 'all')
        ? normalizedClassification
        : null
    });

    if (error) {
      logger.error('[PortalService] Application usage RPC failed', { orgId, from, to, error });
      throw error;
    }

    const result = (data || []).map(row => ({
      application: row.application_name,
      applicationName: row.application_name,
      totalHours: (Number(row.total_seconds) || 0) / 3600,
      totalSeconds: Number(row.total_seconds) || 0,
      sessionCount: Number(row.session_count) || 0,
      employeeCount: Number(row.employee_count) || 0
    }));

    return { data: result, pagination: { totalCount: result.length } };
  }
}

module.exports = new PortalService();
