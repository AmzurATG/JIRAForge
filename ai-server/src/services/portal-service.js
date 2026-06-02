/**
 * Portal Service
 * 
 * Business logic for portal analytics and aggregations.
 * Queries activity_records table directly for portal analytics.
 */

'use strict';

const logger = require('../utils/logger');
const { getClient } = require('./db/supabase-client');

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
        summary: { totalProductiveHours: 0, totalNonProductiveHours: 0, productivityPercentage: 0, employeeCount: 0 },
        dailyTrend: []
      };
    }

    // Query activity records for the date range.
    // visibleUserIds: array → restrict to those employees (LOB scope); null/undefined → all.
    let activityQuery = supabase
      .from('activity_records')
      .select('classification, duration_seconds, user_id, work_date')
      .gte('work_date', from)
      .lte('work_date', to)
      .neq('is_idle', true);
    if (Array.isArray(visibleUserIds)) activityQuery = activityQuery.in('user_id', visibleUserIds);
    const { data: activities, error } = await activityQuery
      .order('start_time', { ascending: false })
      .limit(50000);
    
    if (error) {
      logger.error('[PortalService] Dashboard query failed', { orgId, from, to, error });
      throw error;
    }
    
    // Calculate KPIs
    let productiveSeconds = 0;
    let nonProductiveSeconds = 0;
    const uniqueEmployees = new Set();
    const dailyTrend = {};
    
    activities.forEach(activity => {
      const seconds = activity.duration_seconds || 0;
      
      if (activity.classification === 'productive') {
        productiveSeconds += seconds;
      } else if (isNonProductiveClassification(activity.classification)) {
        nonProductiveSeconds += seconds;
      }
      
      uniqueEmployees.add(activity.user_id);
      
      // Aggregate by day
      const date = activity.work_date;
      if (!dailyTrend[date]) {
        dailyTrend[date] = { date, productiveSeconds: 0, nonProductiveSeconds: 0 };
      }
      
      if (activity.classification === 'productive') {
        dailyTrend[date].productiveSeconds += seconds;
      } else if (isNonProductiveClassification(activity.classification)) {
        dailyTrend[date].nonProductiveSeconds += seconds;
      }
    });
    
    const totalSeconds = productiveSeconds + nonProductiveSeconds;
    const productivityPercentage = totalSeconds > 0 
      ? (productiveSeconds / totalSeconds) * 100 
      : 0;
    
    return {
      summary: {
        totalProductiveHours: productiveSeconds / 3600,
        totalNonProductiveHours: nonProductiveSeconds / 3600,
        productivityPercentage: Math.round(productivityPercentage * 10) / 10,
        employeeCount: uniqueEmployees.size
      },
      dailyTrend: Object.values(dailyTrend).map(day => ({
        date: day.date,
        productiveHours: day.productiveSeconds / 3600,
        nonProductiveHours: day.nonProductiveSeconds / 3600
      })).sort((a, b) => a.date.localeCompare(b.date))
    };
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

    let { search, productivityRange, from, to } = filters;
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
    
    // First get activity data for the date range (no org filter)
    // Use a smaller limit and no ORDER BY to avoid full table scan
    let activityQuery = supabase
      .from('activity_records')
      .select('user_id, classification, duration_seconds, start_time')
      .neq('is_idle', true)
      .gte('work_date', from)
      .lte('work_date', to);
    if (Array.isArray(visibleUserIds)) activityQuery = activityQuery.in('user_id', visibleUserIds);
    activityQuery = activityQuery.limit(10000);  // cap to keep queries fast

    const { data: activities, error: activityError } = await activityQuery;
    
    if (activityError) {
      logger.error('[PortalService] Employees activity query failed', { orgId, error: activityError });
      throw activityError;
    }
    
    // Aggregate by user
    const userMetrics = {};
    activities.forEach(activity => {
      const userId = activity.user_id;
      if (!userMetrics[userId]) {
        userMetrics[userId] = {
          productiveSeconds: 0,
          nonProductiveSeconds: 0,
          lastActivity: activity.start_time
        };
      }
      
      if (activity.classification === 'productive') {
        userMetrics[userId].productiveSeconds += activity.duration_seconds || 0;
      } else if (isNonProductiveClassification(activity.classification)) {
        userMetrics[userId].nonProductiveSeconds += activity.duration_seconds || 0;
      }
      
      if (activity.start_time > userMetrics[userId].lastActivity) {
        userMetrics[userId].lastActivity = activity.start_time;
      }
    });
    
    // Get user details
    const userIds = Object.keys(userMetrics);
    if (userIds.length === 0) {
      return { data: [], pagination: { page, limit, totalCount: 0 } };
    }
    
    let userQuery = supabase
      .from('users')
      .select('id, display_name, email')
      .in('id', userIds);
    
    if (search) {
      userQuery = userQuery.or(`display_name.ilike.%${search}%,email.ilike.%${search}%`);
    }
    
    const { data: users, error: userError } = await userQuery;
    
    if (userError) {
      logger.error('[PortalService] Users query failed', { orgId, error: userError });
      throw userError;
    }
    
    // Combine data
    let employees = (users || []).map(user => {
      const metrics = userMetrics[user.id];
      const totalSeconds = metrics.productiveSeconds + metrics.nonProductiveSeconds;
      const productivityPercentage = totalSeconds > 0 
        ? (metrics.productiveSeconds / totalSeconds) * 100 
        : 0;
      
      const displayName = user.display_name || user.email || 'Unknown User';

      return {
        userId: user.id,
        name: displayName,
        email: user.email,
        productiveHours: metrics.productiveSeconds / 3600,
        nonProductiveHours: metrics.nonProductiveSeconds / 3600,
        productivityPercentage: Math.round(productivityPercentage * 10) / 10,
        lastActivityAt: metrics.lastActivity
      };
    });
    
    // Filter by productivity range (aligned with frontend: high >70%, medium 50-70%, low <50%)
    if (productivityRange && productivityRange !== 'all') {
      employees = employees.filter(emp => {
        const pct = emp.productivityPercentage;
        if (productivityRange === 'high') return pct >= 70;
        if (productivityRange === 'medium') return pct >= 50 && pct < 70;
        if (productivityRange === 'low') return pct < 50;
        return true;
      });
    }
    
    // Sort by name
    employees.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    // Paginate
    const totalCount = employees.length;
    const offset = (page - 1) * limit;
    const paginatedEmployees = employees.slice(offset, offset + limit);
    
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
    
    // Get activity data (no org filter)
    const { data: activities, error: activityError } = await supabase
      .from('activity_records')
      .select('classification, duration_seconds, work_date')
      .eq('user_id', userId)
      .gte('work_date', from)
      .lte('work_date', to)
      .neq('is_idle', true);
    
    if (activityError) {
      logger.error('[PortalService] Activity query failed', { orgId, userId, error: activityError });
      throw activityError;
    }
    
    // Calculate summary
    let productiveSeconds = 0;
    let nonProductiveSeconds = 0;
    const dailyTrend = {};
    
    activities.forEach(activity => {
      const seconds = activity.duration_seconds || 0;
      
      if (activity.classification === 'productive') {
        productiveSeconds += seconds;
      } else if (isNonProductiveClassification(activity.classification)) {
        nonProductiveSeconds += seconds;
      }
      
      // Daily aggregation
      const date = activity.work_date;
      if (!dailyTrend[date]) {
        dailyTrend[date] = { date, productiveSeconds: 0, totalSeconds: 0 };
      }
      
      if (activity.classification === 'productive') {
        dailyTrend[date].productiveSeconds += seconds;
      }
      dailyTrend[date].totalSeconds += seconds;
    });
    
    const totalSeconds = productiveSeconds + nonProductiveSeconds;
    const productivityPercentage = totalSeconds > 0 
      ? (productiveSeconds / totalSeconds) * 100 
      : 0;
    
    return {
      user: {
        userId: user.id,
        name: user.display_name,
        email: user.email
      },
      summary: {
        productiveHours: productiveSeconds / 3600,
        nonProductiveHours: nonProductiveSeconds / 3600,
        idleHours: 0, // Not tracked separately in v1
        productivityPercentage: Math.round(productivityPercentage * 10) / 10
      },
      dailyTrend: Object.values(dailyTrend).map(day => ({
        date: day.date,
        productivityPercentage: day.totalSeconds > 0 
          ? Math.round((day.productiveSeconds / day.totalSeconds) * 1000) / 10 
          : 0,
        productiveHours: day.productiveSeconds / 3600,
        totalHours: day.totalSeconds / 3600
      })).sort((a, b) => a.date.localeCompare(b.date))
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

    let { classification, employee, app, from, to, durationMin, durationMax, confidenceMin, confidenceMax } = filters;
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
        start_time,
        end_time,
        duration_seconds,
        ocr_confidence,
        users!activity_records_user_id_fkey!inner(display_name, email)
      `, { count: 'estimated' })  // Use estimated count instead of exact to avoid timeout
      .neq('is_idle', true);
    
    // Apply filters
    if (normalizedClassification && normalizedClassification !== 'all') {
      query = query.eq('classification', normalizedClassification);
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
}

module.exports = new PortalService();
