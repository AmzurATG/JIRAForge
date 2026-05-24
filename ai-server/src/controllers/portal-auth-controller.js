/**
 * Portal Authentication Controller
 * 
 * Handles login, logout, and password management for portal admins.
 */

'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const portalDbService = require('../services/db/portal-db-service');

const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = '24h';

/**
 * Login endpoint for portal admins.
 * 
 * POST /api/portal/auth/login
 * Body: { email, password }
 */
async function login(req, res) {
  try {
    const { email, password } = req.body;
    
    // Validation
    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email and password are required' 
      });
    }
    
    // Query portal admin user by email only
    const admin = await portalDbService.getAdminByEmail(email.toLowerCase());
    
    if (!admin) {
      logger.warn('[PortalAuth] Login attempt with invalid email', { email });
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid email or password' 
      });
    }
    
    // Verify password
    const isPasswordValid = await bcrypt.compare(password, admin.password_hash);
    
    if (!isPasswordValid) {
      logger.warn('[PortalAuth] Login attempt with invalid password', { 
        userId: admin.id, 
        email 
      });
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid email or password' 
      });
    }
    
    // Generate JWT token
    const secret = process.env.PORTAL_JWT_SECRET;
    if (!secret) {
      logger.error('[PortalAuth] PORTAL_JWT_SECRET not configured');
      return res.status(500).json({ 
        success: false, 
        error: 'Server configuration error' 
      });
    }
    
    const tokenPayload = {
      userId: admin.id,
      orgId: admin.org_id,
      email: admin.email,
      role: admin.role
    };
    
    const token = jwt.sign(tokenPayload, secret, { expiresIn: TOKEN_EXPIRY });
    
    // Update last login timestamp
    await portalDbService.updateLastLogin(admin.org_id, admin.id);
    
    // Return token and user info (exclude password_hash)
    const userInfo = {
      id: admin.id,
      email: admin.email,
      displayName: admin.display_name,
      role: admin.role,
      orgId: admin.org_id
    };
    
    logger.info('[PortalAuth] Login successful', { 
      userId: admin.id, 
      email: admin.email,
      role: admin.role 
    });
    
    return res.json({ 
      success: true, 
      token,
      user: userInfo
    });
    
  } catch (error) {
    logger.error('[PortalAuth] Login failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Change password endpoint.
 * 
 * POST /api/portal/auth/change-password
 * Body: { currentPassword, newPassword }
 */
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;
    const { userId, orgId } = req.portalUser;
    
    // Validation
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ 
        success: false, 
        error: 'Current password and new password are required' 
      });
    }
    
    if (newPassword.length < 8) {
      return res.status(400).json({ 
        success: false, 
        error: 'New password must be at least 8 characters' 
      });
    }
    
    // Fetch user
    const admin = await portalDbService.getAdminById(orgId, userId);
    
    if (!admin) {
      logger.error('[PortalAuth] User not found for password change', { userId, orgId });
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, admin.password_hash);
    
    if (!isCurrentPasswordValid) {
      logger.warn('[PortalAuth] Password change attempt with invalid current password', { 
        userId 
      });
      return res.status(401).json({ 
        success: false, 
        error: 'Current password is incorrect' 
      });
    }
    
    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    
    // Update password in database
    await portalDbService.updateAdmin(orgId, userId, {
      password_hash: newPasswordHash
    });
    
    logger.info('[PortalAuth] Password changed successfully', { userId });
    
    return res.json({ 
      success: true, 
      message: 'Password changed successfully' 
    });
    
  } catch (error) {
    logger.error('[PortalAuth] Change password failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Logout endpoint (optional for stateless JWT).
 * 
 * POST /api/portal/auth/logout
 */
async function logout(req, res) {
  try {
    // For stateless JWT, logout is handled client-side (delete token)
    // This endpoint exists for future enhancements (token blacklisting, etc.)
    
    return res.json({ 
      success: true, 
      message: 'Logged out successfully' 
    });
    
  } catch (error) {
    logger.error('[PortalAuth] Logout failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

module.exports = {
  login,
  changePassword,
  logout
};
