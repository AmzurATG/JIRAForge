'use strict';
const logger = require('../utils/logger');
const aggregationService = require('../services/db/aggregation-service');

/**
 * Get daily total work time for a user.
 * 
 * GET /api/analytics/daily?org_id=X&user_id=Y&date=2026-05-07&timezone=UTC
 * 
 * AC4: Returns same value as all other surfaces (consistent aggregation).
 */
async function getDailyTotal(req, res) {
  const { org_id, user_id, date, timezone } = req.query;
  
  if (!org_id || !user_id || !date) {
    return res.status(400).json({ 
      error: 'Missing required parameters: org_id, user_id, date' 
    });
  }
  
  try {
    const totalSeconds = await aggregationService.getDailyTotal(
      org_id, 
      user_id, 
      date, 
      timezone || 'UTC'
    );
    
    return res.json({
      date,
      total_seconds: totalSeconds,
      hours: (totalSeconds / 3600).toFixed(2),
      timezone: timezone || 'UTC'
    });
  } catch (error) {
    logger.error('getDailyTotal failed', { 
      org_id, 
      user_id, 
      date, 
      error: error.message 
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get weekly total work time for a user.
 * 
 * GET /api/analytics/weekly?org_id=X&user_id=Y&week_start=2026-05-05&timezone=UTC
 */
async function getWeeklyTotal(req, res) {
  const { org_id, user_id, week_start, timezone } = req.query;
  
  if (!org_id || !user_id || !week_start) {
    return res.status(400).json({ 
      error: 'Missing required parameters: org_id, user_id, week_start' 
    });
  }
  
  try {
    const totalSeconds = await aggregationService.getWeeklyTotal(
      org_id,
      user_id,
      week_start,
      timezone || 'UTC'
    );
    
    return res.json({
      week_start,
      total_seconds: totalSeconds,
      hours: (totalSeconds / 3600).toFixed(2),
      timezone: timezone || 'UTC'
    });
  } catch (error) {
    logger.error('getWeeklyTotal failed', { 
      org_id, 
      user_id, 
      week_start, 
      error: error.message 
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  getDailyTotal,
  getWeeklyTotal
};
