/**
 * Portal Authentication Middleware
 * 
 * Validates JWT tokens for portal admin users.
 * Enforces email/password authentication (no Jira integration).
 */

'use strict';

const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

/**
 * Verify JWT token and attach portal user to request.
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next middleware
 */
function verifyPortalToken(req, res, next) {
  logger.info('[PortalAuth] verifyPortalToken called', { 
    path: req.path,
    method: req.method,
    hasAuthHeader: !!req.headers.authorization 
  });
  
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Authentication required' 
      });
    }
    
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    if (!token) {
      return res.status(401).json({ 
        success: false, 
        error: 'Token missing' 
      });
    }
    
    // Verify token
    const secret = process.env.PORTAL_JWT_SECRET;
    if (!secret) {
      logger.error('[PortalAuth] PORTAL_JWT_SECRET not configured');
      return res.status(500).json({ 
        success: false, 
        error: 'Server configuration error' 
      });
    }
    
    const decoded = jwt.verify(token, secret);
    
    // Attach user info to request
    req.portalUser = {
      userId: decoded.userId,
      orgId: decoded.orgId,
      email: decoded.email,
      role: decoded.role
    };
    
    logger.debug('[PortalAuth] Token verified', { 
      userId: decoded.userId, 
      orgId: decoded.orgId,
      role: decoded.role 
    });
    
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid token' 
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        success: false, 
        error: 'Token expired' 
      });
    }
    
    logger.error('[PortalAuth] Token verification failed', error);
    return res.status(401).json({ 
      success: false, 
      error: 'Authentication failed' 
    });
  }
}

/**
 * Role-based access control middleware.
 * 
 * @param {Array<string>} allowedRoles - Roles allowed to access endpoint
 * @returns {Function} Express middleware
 */
function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.portalUser) {
      return res.status(401).json({ 
        success: false, 
        error: 'Authentication required' 
      });
    }
    
    if (!allowedRoles.includes(req.portalUser.role)) {
      return res.status(403).json({ 
        success: false, 
        error: 'Insufficient permissions' 
      });
    }
    
    next();
  };
}

module.exports = {
  verifyPortalToken,
  requireRole
};
