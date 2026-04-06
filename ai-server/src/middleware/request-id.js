/**
 * Request ID Middleware
 * Adds unique ID to each request for tracing and forensic analysis
 * 
 * DDoS Protection: Enables tracking and correlation of suspicious requests
 * Security: Helps identify attack patterns and malicious IPs
 */

const crypto = require('node:crypto');
const logger = require('../utils/logger');

/**
 * Generate a unique request ID
 * Uses crypto.randomBytes for better randomness than UUID
 * 
 * @returns {string} 16-character hexadecimal request ID
 */
function generateRequestId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Request ID middleware
 * Adds X-Request-ID header to all requests and responses
 * Logs suspicious request patterns for DDoS detection
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
function requestIdMiddleware(req, res, next) {
  // Generate or use existing request ID (from client or load balancer)
  const requestId = req.headers['x-request-id'] || generateRequestId();
  
  // Attach to request object for use in controllers/services
  req.id = requestId;
  
  // Add to response headers for client correlation
  res.setHeader('X-Request-ID', requestId);
  
  // Track request start time for latency monitoring
  req.startTime = Date.now();
  
  // Log request details with ID
  logger.debug('[Request] Incoming', {
    requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  
  // Monitor response completion
  res.on('finish', () => {
    const duration = Date.now() - req.startTime;
    const statusCode = res.statusCode;
    
    // Log completed request
    const logLevel = statusCode >= 500 ? 'error' : 
                     statusCode >= 400 ? 'warn' : 
                     'debug';
    
    logger[logLevel]('[Request] Completed', {
      requestId,
      method: req.method,
      path: req.path,
      statusCode,
      duration,
      ip: req.ip
    });
    
    // Detect slow requests (potential slowloris attack)
    if (duration > 30000) { // 30 seconds
      logger.warn('[Security] Slow request detected', {
        requestId,
        method: req.method,
        path: req.path,
        duration,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        warning: 'Potential slowloris attack or slow client'
      });
    }
    
    // Detect rate limit responses
    if (statusCode === 429) {
      logger.warn('[Security] Rate limit triggered', {
        requestId,
        method: req.method,
        path: req.path,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        warning: 'Excessive requests from this IP'
      });
    }
  });
  
  // Monitor request errors
  res.on('error', (error) => {
    logger.error('[Request] Error', {
      requestId,
      method: req.method,
      path: req.path,
      error: error.message,
      ip: req.ip
    });
  });
  
  next();
}

/**
 * Enhanced rate limit handler with request ID logging
 * Use this as the handler option in express-rate-limit
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
function rateLimitHandler(req, res) {
  const requestId = req.id || 'unknown';
  const retryAfter = Math.ceil(req.rateLimit.resetTime.getTime() / 1000);
  
  // Log detailed rate limit event
  logger.warn('[RateLimit] Request blocked', {
    requestId,
    ip: req.ip,
    path: req.path,
    method: req.method,
    userAgent: req.get('user-agent'),
    limit: req.rateLimit.limit,
    current: req.rateLimit.current,
    remaining: req.rateLimit.remaining,
    resetTime: req.rateLimit.resetTime,
    warning: 'Potential DDoS attempt - IP exceeded rate limit'
  });
  
  // Check if this is a sustained attack (multiple rate limit hits)
  // In production, integrate with Redis or similar to track repeated offenders
  
  res.status(429).json({
    success: false,
    error: 'Too many requests, please try again later',
    requestId,
    retryAfter: retryAfter,
    limit: req.rateLimit.limit,
    remaining: 0
  });
}

/**
 * Get current request ID from request context
 * Helper function for use in controllers/services
 * 
 * @param {Object} req - Express request object
 * @returns {string} Request ID or 'unknown'
 */
function getRequestId(req) {
  return req?.id || 'unknown';
}

/**
 * Add request ID to logger context
 * Returns a child logger with request ID attached
 * 
 * @param {Object} req - Express request object
 * @returns {Object} Winston child logger with request ID
 */
function getLoggerWithRequestId(req) {
  return logger.child({ requestId: getRequestId(req) });
}

module.exports = {
  requestIdMiddleware,
  rateLimitHandler,
  getRequestId,
  getLoggerWithRequestId,
  generateRequestId
};
