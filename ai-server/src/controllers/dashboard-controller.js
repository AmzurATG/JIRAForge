/**
 * Dashboard Controller
 * REST API handlers for the admin status report dashboard.
 * All handlers expect req.organizationId to be set by dashboard-auth middleware.
 */

const logger = require('../utils/logger');
const dashboardDb = require('../services/db/dashboard-db-service');

// ── READ ────────────────────────────────────────────

exports.getData = async (req, res) => {
  try {
    const data = await dashboardDb.fetchDashboardData(req.organizationId);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('[Dashboard] getData error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ── HEADER METRICS ──────────────────────────────────

exports.addMetric = async (req, res) => {
  try {
    const result = await dashboardDb.addHeaderMetric(req.organizationId, req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[Dashboard] addMetric error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.updateMetric = async (req, res) => {
  try {
    const result = await dashboardDb.updateHeaderMetric(req.params.id, req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[Dashboard] updateMetric error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.deleteMetric = async (req, res) => {
  try {
    await dashboardDb.deleteHeaderMetric(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] deleteMetric error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ── ORGANIZATIONS ───────────────────────────────────

exports.addOrg = async (req, res) => {
  try {
    const result = await dashboardDb.addOrganization(req.organizationId, req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[Dashboard] addOrg error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.updateOrg = async (req, res) => {
  try {
    const result = await dashboardDb.updateOrganization(req.params.id, req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[Dashboard] updateOrg error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.deleteOrg = async (req, res) => {
  try {
    await dashboardDb.deleteOrganization(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] deleteOrg error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ── TICKETS PER TEAM ────────────────────────────────

exports.addTicketTeam = async (req, res) => {
  try {
    const result = await dashboardDb.addTicketTeam(req.organizationId, req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[Dashboard] addTicketTeam error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.updateTicketTeam = async (req, res) => {
  try {
    const result = await dashboardDb.updateTicketTeam(req.params.id, req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[Dashboard] updateTicketTeam error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.deleteTicketTeam = async (req, res) => {
  try {
    await dashboardDb.deleteTicketTeam(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] deleteTicketTeam error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ── TICKET STATUS ───────────────────────────────────

exports.addTicketStatus = async (req, res) => {
  try {
    const result = await dashboardDb.addTicketStatus(req.organizationId, req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[Dashboard] addTicketStatus error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.updateTicketStatus = async (req, res) => {
  try {
    const result = await dashboardDb.updateTicketStatus(req.params.id, req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[Dashboard] updateTicketStatus error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.deleteTicketStatus = async (req, res) => {
  try {
    await dashboardDb.deleteTicketStatus(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] deleteTicketStatus error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};
