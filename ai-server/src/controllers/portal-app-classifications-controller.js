/**
 * Portal Application Classifications Controller
 * 
 * CRUD operations for application whitelist/blacklist management.
 */

'use strict';

const logger = require('../utils/logger');
const portalDbService = require('../services/db/portal-db-service');

/**
 * Get application classifications list.
 * 
 * GET /api/portal/app-classifications?page=&limit=&classification=&match_by=
 */
async function getAppClassifications(req, res) {
  try {
    const { orgId, role } = req.portalUser;
    const { page = 1, limit = 50, classification, match_by, search } = req.query;
    
    // Role check: admin or superadmin
    if (!['admin', 'superadmin'].includes(role)) {
      return res.status(403).json({ 
        success: false, 
        error: 'Only admins can view application classifications' 
      });
    }
    
    const result = await portalDbService.listAppClassifications(
      orgId,
      parseInt(page),
      parseInt(limit),
      { classification, match_by, search }
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
    logger.error('[PortalAppClassifications] Get classifications failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Create application classification.
 * 
 * POST /api/portal/app-classifications
 * Body: { identifier, displayName, classification, matchBy, projectKey, isDefault }
 */
async function createAppClassification(req, res) {
  try {
    const { orgId, role, userId } = req.portalUser;
    const { identifier, displayName, classification, matchBy, projectKey, isDefault } = req.body;
    
    // Role check: admin or superadmin
    if (!['admin', 'superadmin'].includes(role)) {
      return res.status(403).json({ 
        success: false, 
        error: 'Only admins can create application classifications' 
      });
    }
    
    // Validation
    if (!identifier || !displayName || !classification || !matchBy) {
      return res.status(400).json({ 
        success: false, 
        error: 'identifier, displayName, classification, and matchBy are required' 
      });
    }
    
    // Validate classification
    if (!['productive', 'non_productive', 'private'].includes(classification)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid classification. Must be productive, non_productive, or private' 
      });
    }
    
    // Validate matchBy
    if (!['process', 'url'].includes(matchBy)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid matchBy. Must be process or url' 
      });
    }
    
    const data = {
      organization_id: orgId,
      project_key: projectKey || null,
      identifier,
      display_name: displayName,
      classification,
      match_by: matchBy,
      is_default: isDefault || false,
      created_by: userId
    };
    
    const newClassification = await portalDbService.createAppClassification(data);
    
    return res.status(201).json({ 
      success: true, 
      data: newClassification 
    });
    
  } catch (error) {
    logger.error('[PortalAppClassifications] Create classification failed', error);
    
    // Check for unique constraint violation
    if (error.message?.includes('duplicate') || error.code === '23505') {
      return res.status(409).json({ 
        success: false, 
        error: 'This application classification already exists' 
      });
    }
    
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Update application classification.
 * 
 * PUT /api/portal/app-classifications/:id
 * Body: { displayName, classification, isDefault }
 */
async function updateAppClassification(req, res) {
  try {
    const { orgId, role } = req.portalUser;
    const { id } = req.params;
    const { displayName, classification, isDefault } = req.body;
    
    // Role check: admin or superadmin
    if (!['admin', 'superadmin'].includes(role)) {
      return res.status(403).json({ 
        success: false, 
        error: 'Only admins can update application classifications' 
      });
    }
    
    // Validation
    if (classification && !['productive', 'non_productive', 'private'].includes(classification)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid classification. Must be productive, non_productive, or private' 
      });
    }
    
    const data = {};
    if (displayName !== undefined) data.display_name = displayName;
    if (classification !== undefined) data.classification = classification;
    if (isDefault !== undefined) data.is_default = isDefault;
    
    const updated = await portalDbService.updateAppClassification(orgId, id, data);
    
    if (!updated) {
      return res.status(404).json({ 
        success: false, 
        error: 'Application classification not found' 
      });
    }
    
    return res.json({ 
      success: true, 
      data: updated 
    });
    
  } catch (error) {
    logger.error('[PortalAppClassifications] Update classification failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Delete application classification.
 * 
 * DELETE /api/portal/app-classifications/:id
 */
async function deleteAppClassification(req, res) {
  try {
    const { orgId, role } = req.portalUser;
    const { id } = req.params;
    
    // Role check: admin or superadmin
    if (!['admin', 'superadmin'].includes(role)) {
      return res.status(403).json({ 
        success: false, 
        error: 'Only admins can delete application classifications' 
      });
    }
    
    const deleted = await portalDbService.deleteAppClassification(orgId, id);
    
    if (!deleted) {
      return res.status(404).json({ 
        success: false, 
        error: 'Application classification not found' 
      });
    }
    
    return res.json({ 
      success: true, 
      message: 'Application classification deleted successfully' 
    });
    
  } catch (error) {
    logger.error('[PortalAppClassifications] Delete classification failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Bulk import application classifications from CSV.
 * 
 * POST /api/portal/app-classifications/bulk-import
 * Body: { data: [{ identifier, displayName, classification, matchBy, projectKey }] }
 */
async function bulkImportAppClassifications(req, res) {
  try {
    const { orgId, role, userId } = req.portalUser;
    const { data } = req.body;
    
    // Role check: admin or superadmin
    if (!['admin', 'superadmin'].includes(role)) {
      return res.status(403).json({ 
        success: false, 
        error: 'Only admins can bulk import application classifications' 
      });
    }
    
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Data array is required and must not be empty' 
      });
    }
    
    const results = {
      success: [],
      failed: []
    };
    
    for (const item of data) {
      try {
        const classificationData = {
          organization_id: orgId,
          project_key: item.projectKey || null,
          identifier: item.identifier,
          display_name: item.displayName,
          classification: item.classification,
          match_by: item.matchBy,
          is_default: item.isDefault || false,
          created_by: userId
        };
        
        const created = await portalDbService.createAppClassification(classificationData);
        results.success.push({ identifier: item.identifier, id: created.id });
      } catch (error) {
        results.failed.push({ 
          identifier: item.identifier, 
          error: error.message 
        });
      }
    }
    
    return res.json({ 
      success: true, 
      data: results,
      summary: {
        total: data.length,
        successful: results.success.length,
        failed: results.failed.length
      }
    });
    
  } catch (error) {
    logger.error('[PortalAppClassifications] Bulk import failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

module.exports = {
  getAppClassifications,
  createAppClassification,
  updateAppClassification,
  deleteAppClassification,
  bulkImportAppClassifications
};
