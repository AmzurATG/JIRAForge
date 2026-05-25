/**
 * Portal Admin Users Controller
 * 
 * CRUD operations for portal admin users management.
 */

'use strict';

const logger = require('../utils/logger');
const portalDbService = require('../services/db/portal-db-service');
const bcrypt = require('bcrypt');

/**
 * Get admin users list.
 * 
 * GET /api/portal/admin-users?page=&limit=
 */
async function getAdminUsers(req, res) {
  try {
    const { orgId, role } = req.portalUser;
    const { page = 1, limit = 20 } = req.query;
    
    // Role check: only superadmin can manage admin users
    if (role !== 'superadmin') {
      return res.status(403).json({ 
        success: false, 
        error: 'Only superadmin can manage admin users' 
      });
    }
    
    const result = await portalDbService.listAdmins(
      orgId,
      parseInt(page),
      parseInt(limit)
    );
    
    return res.json({ 
      success: true, 
      data: result.data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        totalCount: result.totalCount
      }
    });
    
  } catch (error) {
    logger.error('[PortalAdminUsers] Get admin users failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Create admin user.
 * 
 * POST /api/portal/admin-users
 * Body: { email, password, displayName, role }
 */
async function createAdminUser(req, res) {
  try {
    const { orgId, role } = req.portalUser;
    const { email, password, displayName, role: newUserRole } = req.body;
    
    // Role check: only superadmin can create admin users
    if (role !== 'superadmin') {
      return res.status(403).json({ 
        success: false, 
        error: 'Only superadmin can create admin users' 
      });
    }
    
    // Validation
    if (!email || !password || !displayName || !newUserRole) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email, password, displayName, and role are required' 
      });
    }
    
    // Validate role
    if (!['superadmin', 'admin', 'viewer'].includes(newUserRole)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid role. Must be superadmin, admin, or viewer' 
      });
    }
    
    // Check if admin with this email already exists
    const existingAdmin = await portalDbService.getAdminByEmail(email);
    if (existingAdmin) {
      return res.status(409).json({ 
        success: false, 
        error: 'Admin user with this email already exists' 
      });
    }
    
    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Create admin
    const newAdmin = await portalDbService.createAdmin(orgId, {
      email,
      passwordHash,
      displayName,
      role: newUserRole
    });
    
    // Don't return password hash
    const { password_hash, ...adminWithoutPassword } = newAdmin;
    
    return res.status(201).json({ 
      success: true, 
      data: adminWithoutPassword 
    });
    
  } catch (error) {
    logger.error('[PortalAdminUsers] Create admin user failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Update admin user.
 * 
 * PUT /api/portal/admin-users/:userId
 * Body: { displayName?, role? }
 */
async function updateAdminUser(req, res) {
  try {
    const { orgId, role, userId: currentUserId } = req.portalUser;
    const { userId } = req.params;
    const { displayName, role: newRole } = req.body;
    
    // Role check: only superadmin can update admin users
    if (role !== 'superadmin') {
      return res.status(403).json({ 
        success: false, 
        error: 'Only superadmin can update admin users' 
      });
    }
    
    // Can't update yourself
    if (userId === currentUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot modify your own user account' 
      });
    }
    
    // Validation
    if (!displayName && !newRole) {
      return res.status(400).json({ 
        success: false, 
        error: 'At least one field (displayName or role) must be provided' 
      });
    }
    
    // Validate role if provided
    if (newRole && !['superadmin', 'admin', 'viewer'].includes(newRole)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid role. Must be superadmin, admin, or viewer' 
      });
    }
    
    // Check if user exists
    const existingAdmin = await portalDbService.getAdminById(orgId, userId);
    if (!existingAdmin) {
      return res.status(404).json({ 
        success: false, 
        error: 'Admin user not found' 
      });
    }
    
    // Build updates object
    const updates = {};
    if (displayName) updates.display_name = displayName;
    if (newRole) updates.role = newRole;
    
    // Update admin
    const updatedAdmin = await portalDbService.updateAdmin(orgId, userId, updates);
    
    // Don't return password hash
    const { password_hash, ...adminWithoutPassword } = updatedAdmin;
    
    return res.json({ 
      success: true, 
      data: adminWithoutPassword 
    });
    
  } catch (error) {
    logger.error('[PortalAdminUsers] Update admin user failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Delete admin user.
 * 
 * DELETE /api/portal/admin-users/:userId
 */
async function deleteAdminUser(req, res) {
  try {
    const { orgId, role, userId: currentUserId } = req.portalUser;
    const { userId } = req.params;
    
    // Role check: only superadmin can delete admin users
    if (role !== 'superadmin') {
      return res.status(403).json({ 
        success: false, 
        error: 'Only superadmin can delete admin users' 
      });
    }
    
    // Can't delete yourself
    if (userId === currentUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot delete your own user account' 
      });
    }
    
    // Check if user exists
    const existingAdmin = await portalDbService.getAdminById(orgId, userId);
    if (!existingAdmin) {
      return res.status(404).json({ 
        success: false, 
        error: 'Admin user not found' 
      });
    }
    
    // Delete admin
    await portalDbService.deleteAdmin(orgId, userId);
    
    return res.json({ 
      success: true, 
      message: 'Admin user deleted successfully' 
    });
    
  } catch (error) {
    logger.error('[PortalAdminUsers] Delete admin user failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

module.exports = {
  getAdminUsers,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser
};
