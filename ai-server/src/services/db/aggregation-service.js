/**
 * Unified Aggregation Service — Single Source of Truth for Time Totals
 * 
 * AC4: All queries enforce org_id (RLS safety) and consistent timezone handling.
 * AC5: Excludes idle records from work time calculations.
 * AC8: Used by all surfaces (Dashboard, Forge Issue Panel, Forge Project Page).
 * 
 * Security: All queries filter by org_id to prevent data leakage across organizations.
 */

'use strict';

const { getClient } = require('./supabase-client');
const logger = require('../../utils/logger');

/**
 * Aggregation Service Class
 */
class AggregationService {
  
  /**
   * Get daily total work time for a user.
   * 
   * @param {string} org_id - Organization ID (RLS enforcement)
   * @param {string} user_id - User ID
   * @param {string} date - Date in YYYY-MM-DD format
   * @param {string} timezone - IANA timezone (default: UTC)
   * @returns {Promise<number>} Total seconds worked on that date
   */
  async getDailyTotal(org_id, user_id, date, timezone = 'UTC') {
    if (!org_id) {
      throw new Error('org_id is required');
    }
    
    if (!user_id) {
      throw new Error('user_id is required');
    }
    
    if (!date) {
      throw new Error('date is required (format: YYYY-MM-DD)');
    }
    
    const supabase = getClient();
    if (!supabase) {
      throw new Error('Supabase client not initialized');
    }
    
    // Query for date range in UTC (timezone conversion handled at display layer)
    const startOfDay = `${date}T00:00:00Z`;
    const endOfDay = this._addDays(date, 1) + 'T00:00:00Z';
    
    const { data, error } = await supabase
      .from('activity_records')
      .select('duration_seconds')
      .eq('org_id', org_id)
      .eq('user_id', user_id)
      .gte('timestamp', startOfDay)
      .lt('timestamp', endOfDay)
      .neq('is_idle', true);  // Exclude idle time from work totals
      
    if (error) {
      logger.error('getDailyTotal query failed', { 
        org_id, 
        user_id, 
        date, 
        error: error.message 
      });
      throw error;
    }
    
    // Sum duration_seconds
    const total = data.reduce((sum, row) => sum + (row.duration_seconds || 0), 0);
    
    logger.debug('Daily total computed', { 
      org_id, 
      user_id, 
      date, 
      total, 
      record_count: data.length 
    });
    
    return total;
  }
  
  /**
   * Get weekly total work time for a user.
   * 
   * @param {string} org_id - Organization ID
   * @param {string} user_id - User ID
   * @param {string} week_start - Monday date in YYYY-MM-DD format
   * @param {string} timezone - IANA timezone (default: UTC)
   * @returns {Promise<number>} Total seconds worked that week
   */
  async getWeeklyTotal(org_id, user_id, week_start, timezone = 'UTC') {
    if (!org_id) {
      throw new Error('org_id is required');
    }
    
    if (!user_id) {
      throw new Error('user_id is required');
    }
    
    const supabase = getClient();
    if (!supabase) {
      throw new Error('Supabase client not initialized');
    }
    
    const week_end = this._addDays(week_start, 7);
    
    const startOfWeek = `${week_start}T00:00:00Z`;
    const endOfWeek = `${week_end}T00:00:00Z`;
    
    const { data, error } = await supabase
      .from('activity_records')
      .select('duration_seconds')
      .eq('org_id', org_id)
      .eq('user_id', user_id)
      .gte('timestamp', startOfWeek)
      .lt('timestamp', endOfWeek)
      .neq('is_idle', true);
      
    if (error) {
      logger.error('getWeeklyTotal query failed', { 
        org_id, 
        user_id, 
        week_start, 
        error: error.message 
      });
      throw error;
    }
    
    const total = data.reduce((sum, row) => sum + (row.duration_seconds || 0), 0);
    
    logger.debug('Weekly total computed', {
      org_id,
      user_id,
      week_start,
      total,
      record_count: data.length
    });
    
    return total;
  }
  
  /**
   * Get user activities for a date range (for timeline display).
   * 
   * @param {string} org_id - Organization ID
   * @param {string} user_id - User ID
   * @param {string} start_date - Start date YYYY-MM-DD
   * @param {string} end_date - End date YYYY-MM-DD
   * @returns {Promise<Array>} Activity records
   */
  async getUserActivities(org_id, user_id, start_date, end_date) {
    if (!org_id) {
      throw new Error('org_id is required');
    }
    
    const supabase = getClient();
    if (!supabase) {
      throw new Error('Supabase client not initialized');
    }
    
    const { data, error } = await supabase
      .from('activity_records')
      .select('*')
      .eq('org_id', org_id)
      .eq('user_id', user_id)
      .gte('timestamp', `${start_date}T00:00:00Z`)
      .lt('timestamp', `${end_date}T00:00:00Z`)
      .order('timestamp', { ascending: true });
      
    if (error) {
      logger.error('getUserActivities query failed', { 
        org_id, 
        user_id, 
        start_date, 
        end_date,
        error: error.message 
      });
      throw error;
    }
    
    return data || [];
  }
  
  /**
   * Helper: Add days to a date string
   * @private
   */
  _addDays(dateStr, days) {
    const date = new Date(dateStr);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().split('T')[0];
  }
}

module.exports = new AggregationService();
