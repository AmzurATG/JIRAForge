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
// Dummy hash for timing attack mitigation - always compare against this when user doesn't exist
const DUMMY_HASH = process.env.DUMMY_PASSWORD_HASH || '$2b$10$BpDAJkzEBob4XnzEWi4KoORn45XbhjLZL2Gi1egv3JqLY3WY.US5q';

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
    const normalizedEmail = email.toLowerCase().trim();
    const admin = await portalDbService.getAdminByEmail(normalizedEmail);
    
    // SECURITY: Always call bcrypt.compare() to prevent timing attacks
    // If user doesn't exist, compare against dummy hash to match execution time
    const hashToCompare = admin ? admin.password_hash : DUMMY_HASH;
    const isPasswordValid = await bcrypt.compare(password, hashToCompare);
    
    // Check both conditions together
    if (!admin || !isPasswordValid) {
      logger.warn('[PortalAuth] Login failed', { 
        email: normalizedEmail,
        reason: admin ? 'invalid_password' : 'user_not_found'
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

/**
 * Request password reset (forgot password).
 * 
 * POST /api/portal/auth/forgot-password
 * Body: { email }
 */
async function requestPasswordReset(req, res) {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email is required' 
      });
    }
    
    // Look up user by email
    const admin = await portalDbService.getAdminByEmail(email.toLowerCase());
    
    // Always return success for security (don't leak if email exists)
    if (!admin) {
      logger.info('[PortalAuth] Password reset requested for non-existent email', { email });
      return res.json({ 
        success: true, 
        message: 'If the email exists, a password reset link has been sent' 
      });
    }
    
    // Generate reset token (crypto.randomBytes for secure token)
    const crypto = require('crypto');
    const resetToken = crypto.randomBytes(32).toString('hex');
    
    // SECURITY: Hash token before storing (defense-in-depth)
    const tokenHash = await bcrypt.hash(resetToken, SALT_ROUNDS);
    
    // Token expires in 1 hour
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);
    
    // Store token hash (not plaintext) on user record
    await portalDbService.setPasswordResetToken(
      admin.org_id,
      admin.id,
      tokenHash,  // Store hash, not plaintext
      expiresAt
    );
    
    // Send password reset email
    const notifmeWrapper = require('../services/notifications/notifme-wrapper');
    const portalBase = (process.env.PORTAL_BASE_URL || 'http://localhost:3002').replace(/\/+$/, '');
    const resetLink = `${portalBase}/reset-password?token=${resetToken}`;
    
    const emailResult = await notifmeWrapper.send({
      to: admin.email,
      subject: 'Password Reset Request - Amzur Time Tracker',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Password Reset Request</h2>
          <p>Hi ${admin.display_name},</p>
          <p>You requested a password reset for your Amzur Time Tracker account.</p>
          <p>Click the link below to reset your password:</p>
          <p style="margin: 20px 0;">
            <a href="${resetLink}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
              Reset Password
            </a>
          </p>
          <p>Or copy and paste this link into your browser:</p>
          <p style="word-break: break-all; color: #666;">${resetLink}</p>
          <p><strong>This link will expire in 1 hour.</strong></p>
          <p>If you didn't request this password reset, you can safely ignore this email.</p>
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
          <p style="color: #666; font-size: 12px;">
            Amzur Time Tracker - Time Tracking System
          </p>
        </div>
      `
    });
    
    if (!emailResult.success) {
      logger.error('[PortalAuth] Failed to send password reset email', { email, error: emailResult.errors });
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to send password reset email' 
      });
    }
    
    logger.info('[PortalAuth] Password reset email sent', { userId: admin.id, email });
    
    return res.json({ 
      success: true, 
      message: 'If the email exists, a password reset link has been sent' 
    });
    
  } catch (error) {
    logger.error('[PortalAuth] Request password reset failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Reset password with token.
 * SECURITY: Tokens are hashed in DB, so we fetch all active tokens and compare.
 * 
 * POST /api/portal/auth/reset-password
 * Body: { token, newPassword }
 */
async function resetPassword(req, res) {
  try {
    const { token, newPassword } = req.body;
    
    if (!token || !newPassword) {
      return res.status(400).json({ 
        success: false, 
        error: 'Token and new password are required' 
      });
    }
    
    if (newPassword.length < 8) {
      return res.status(400).json({ 
        success: false, 
        error: 'Password must be at least 8 characters' 
      });
    }
    
    // SECURITY: Fetch all users with active reset tokens
    // We can't query by token hash directly, so we compare each one
    const adminsWithTokens = await portalDbService.getAdminsWithActiveResetToken();
    
    if (!adminsWithTokens || adminsWithTokens.length === 0) {
      logger.warn('[PortalAuth] Password reset attempted with no active tokens');
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid or expired reset token' 
      });
    }
    
    // Find matching admin by comparing token hashes
    let matchedAdmin = null;
    for (const admin of adminsWithTokens) {
      const isMatch = await bcrypt.compare(token, admin.reset_token);
      if (isMatch) {
        matchedAdmin = admin;
        break;
      }
    }
    
    if (!matchedAdmin) {
      logger.warn('[PortalAuth] Password reset attempted with invalid token');
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid or expired reset token' 
      });
    }
    
    // Check if token is expired (already filtered by SQL, but double-check)
    const now = new Date();
    const expiresAt = new Date(matchedAdmin.reset_token_expires_at);
    
    if (now > expiresAt) {
      // Clear expired token
      await portalDbService.clearPasswordResetToken(matchedAdmin.org_id, matchedAdmin.id);
      return res.status(400).json({ 
        success: false, 
        error: 'Reset token has expired' 
      });
    }
    
    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    
    // Update password in database
    await portalDbService.updateAdmin(matchedAdmin.org_id, matchedAdmin.id, {
      password_hash: newPasswordHash
    });
    
    // Clear reset token after successful use
    await portalDbService.clearPasswordResetToken(matchedAdmin.org_id, matchedAdmin.id);
    
    logger.info('[PortalAuth] Password reset successful', { userId: matchedAdmin.id });
    
    return res.json({ 
      success: true, 
      message: 'Password reset successfully' 
    });
    
  } catch (error) {
    logger.error('[PortalAuth] Reset password failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Admin reset password (superadmin only).
 * Allows superadmin to reset password for any user without requiring current password.
 * 
 * POST /api/portal/auth/admin-reset-password
 * Body: { targetUserId, newPassword }
 * Auth: Requires superadmin role
 */
async function adminResetPassword(req, res) {
  try {
    const { targetUserId, newPassword } = req.body;
    const { userId: adminUserId, orgId, role } = req.portalUser;
    
    // Authorization check - only superadmins can reset passwords
    if (role !== 'superadmin') {
      logger.warn('[PortalAuth] Non-superadmin attempted to reset user password', { 
        adminUserId, 
        targetUserId 
      });
      return res.status(403).json({ 
        success: false, 
        error: 'Only superadmins can reset user passwords' 
      });
    }
    
    // Validation
    if (!targetUserId || !newPassword) {
      return res.status(400).json({ 
        success: false, 
        error: 'Target user ID and new password are required' 
      });
    }
    
    if (newPassword.length < 8) {
      return res.status(400).json({ 
        success: false, 
        error: 'Password must be at least 8 characters' 
      });
    }
    
    // Get target user
    const targetUser = await portalDbService.getAdminById(orgId, targetUserId);
    
    if (!targetUser) {
      return res.status(404).json({ 
        success: false, 
        error: 'Target user not found' 
      });
    }
    
    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    
    // Update password in database
    await portalDbService.updateAdmin(orgId, targetUserId, {
      password_hash: newPasswordHash
    });
    
    // Clear any existing reset tokens
    await portalDbService.clearPasswordResetToken(orgId, targetUserId);
    
    logger.info('[PortalAuth] Admin password reset successful', { 
      adminUserId, 
      targetUserId,
      targetEmail: targetUser.email 
    });
    
    return res.json({ 
      success: true, 
      message: 'Password reset successfully' 
    });
    
  } catch (error) {
    logger.error('[PortalAuth] Admin reset password failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Get Google OAuth URL for frontend to redirect to
 * 
 * GET /api/portal/auth/google/url
 */
async function getGoogleAuthUrl(req, res) {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3002/auth/google/callback';
    
    if (!clientId) {
      return res.status(500).json({
        success: false,
        error: 'Google OAuth not configured'
      });
    }
    
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(clientId)}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `response_type=code&` +
      `scope=${encodeURIComponent('openid email profile')}&` +
      `access_type=offline&` +
      `prompt=consent`;
    
    return res.json({
      success: true,
      url: googleAuthUrl
    });
  } catch (error) {
    logger.error('[PortalAuth] Failed to generate Google OAuth URL', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * Handle Google OAuth callback
 * 
 * POST /api/portal/auth/google/callback
 * Body: { code }
 */
async function googleCallback(req, res) {
  try {
    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Authorization code is required'
      });
    }
    
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3002/auth/google/callback';
    
    if (!clientId || !clientSecret) {
      return res.status(500).json({
        success: false,
        error: 'Google OAuth not configured'
      });
    }
    
    logger.info('[PortalAuth] Exchanging Google OAuth code', { 
      clientId: clientId.substring(0, 20) + '...', 
      redirectUri 
    });
    
    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });
    
    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json();
      logger.error('[PortalAuth] Google token exchange failed', { 
        error: errorData,
        redirectUri,
        statusCode: tokenResponse.status
      });
      return res.status(400).json({
        success: false,
        error: errorData.error_description || 'Failed to exchange authorization code. Please ensure the redirect URI in Google Cloud Console matches: ' + redirectUri
      });
    }
    
    const tokens = await tokenResponse.json();
    
    // Get user info from Google
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`
      }
    });
    
    if (!userInfoResponse.ok) {
      logger.error('[PortalAuth] Failed to get Google user info');
      return res.status(400).json({
        success: false,
        error: 'Failed to get user information'
      });
    }
    
    const googleUser = await userInfoResponse.json();
    const normalizedEmail = googleUser.email.toLowerCase().trim();
    
    // Check if user exists in portal_admin_users
    const admin = await portalDbService.getAdminByEmail(normalizedEmail);
    
    if (!admin) {
      logger.warn('[PortalAuth] Google SSO login attempt by unregistered user', { email: normalizedEmail });
      return res.status(403).json({
        success: false,
        error: 'Email not authorized for portal access'
      });
    }
    
    // Generate JWT token
    const jwtSecret = process.env.PORTAL_JWT_SECRET;
    if (!jwtSecret) {
      throw new Error('PORTAL_JWT_SECRET not configured');
    }
    
    const token = jwt.sign(
      { 
        userId: admin.id,
        email: admin.email,
        orgId: admin.org_id,
        role: admin.role
      },
      jwtSecret,
      { expiresIn: TOKEN_EXPIRY }
    );
    
    logger.info('[PortalAuth] Google SSO login successful', { 
      userId: admin.id, 
      email: admin.email, 
      role: admin.role,
      googleEmail: googleUser.email
    });
    
    return res.json({
      success: true,
      token,
      user: {
        id: admin.id,
        email: admin.email,
        displayName: admin.display_name || googleUser.name,
        role: admin.role,
        orgId: admin.org_id
      }
    });
    
  } catch (error) {
    logger.error('[PortalAuth] Google OAuth callback failed', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

module.exports = {
  login,
  changePassword,
  logout,
  requestPasswordReset,
  resetPassword,
  adminResetPassword,
  getGoogleAuthUrl,
  googleCallback
};
