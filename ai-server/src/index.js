const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('node:path');
require('dotenv').config();

const screenshotController = require('./controllers/screenshot-controller');
const brdController = require('./controllers/brd-controller');
const authController = require('./controllers/auth-controller');
const forgeProxyController = require('./controllers/forge-proxy-controller');
const appVersionController = require('./controllers/app-version-controller');
const feedbackController = require('./controllers/feedback-controller');
const notificationController = require('./controllers/notification-controller');
const authMiddleware = require('./middleware/auth');
const forgeAuthMiddleware = require('./middleware/forge-auth');
const atlassianAuthMiddleware = require('./middleware/atlassian-auth');
const logger = require('./utils/logger');
const pollingService = require('./services/polling-service');
const clusteringPollingService = require('./services/clustering-polling-service');
const cleanupService = require('./services/cleanup-service');
const notificationPollingService = require('./services/notifications/notification-polling');
const aiService = require('./services/ai');
const { initializeSheetsLogger } = require('./services/sheets-logger');
const activityController = require('./controllers/activity-controller');
const activityPollingService = require('./services/activity-polling-service');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy - required for ngrok tunnel
app.set('trust proxy', 1);

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  // Use a simple key generator that works with proxies
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  }
});

app.use('/api/', limiter);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'BRD Time Tracker AI Server',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      api: '/api/*',
      legal: {
        privacy: '/legal/privacy',
        terms: '/legal/terms'
      }
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// =============================================================================
// LEGAL PAGES (Public - served as static HTML)
// =============================================================================

// Privacy Policy
app.get('/legal/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'legal', 'privacy-policy.html'));
});

// Terms of Service
app.get('/legal/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'legal', 'terms-of-service.html'));
});

// Redirect shortcuts
app.get('/privacy', (req, res) => res.redirect('/legal/privacy'));
app.get('/privacy-policy', (req, res) => res.redirect('/legal/privacy'));
app.get('/terms', (req, res) => res.redirect('/legal/terms'));
app.get('/terms-of-service', (req, res) => res.redirect('/legal/terms'));

// =============================================================================
// AUTH ROUTES (Public - no authMiddleware)
// These endpoints handle secure token exchange for the desktop app
// =============================================================================

// Rate limiter specifically for auth endpoints (stricter to prevent abuse)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 requests per 15 minutes per IP
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  }
});

// Exchange OAuth code for tokens (Atlassian OAuth callback proxy)
app.post('/api/auth/atlassian/callback', authLimiter, authController.atlassianCallback);

// Refresh Atlassian access token
app.post('/api/auth/refresh-token', authLimiter, authController.refreshToken);

// Exchange Atlassian token for Supabase JWT
app.post('/api/auth/exchange-token', authLimiter, authController.exchangeToken);

// Verify Atlassian token
app.post('/api/auth/verify', authLimiter, authController.verifyToken);

// Get Supabase configuration (returns credentials after verifying Atlassian token)
app.post('/api/auth/supabase-config', authLimiter, authController.getSupabaseConfig);

// Get OCR configuration (returns OCR settings after verifying Atlassian token)
app.post('/api/auth/ocr-config', authLimiter, authController.getOcrConfig);

// =============================================================================
// FEEDBACK ROUTES (Session-authenticated via feedback session store)
// Desktop app creates a session, then opens the browser to the feedback form
// =============================================================================

// Rate limiter for feedback submissions (stricter than general)
const feedbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 submissions per 15 minutes per IP
  message: 'Too many feedback submissions, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  }
});

// Create feedback session (desktop app sends Atlassian token)
app.post('/api/feedback/session', authLimiter, feedbackController.createSession);

// Serve feedback form (session-authenticated via query param)
// Using /api/feedback/form so nginx forwards it to the AI server
app.get('/api/feedback/form', feedbackController.getFeedbackPage);

// Serve feedback form JavaScript (public static file)
app.get('/api/feedback/feedback-form.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'feedback', 'feedback-form.js'));
});

// Submit feedback (session-authenticated via body)
app.post('/api/feedback/submit', feedbackLimiter, feedbackController.submitFeedback);

// Check feedback/Jira creation status (public - feedback ID is unguessable UUID)
app.get('/api/feedback/status/:id', feedbackController.getFeedbackStatus);

// =============================================================================
// APP VERSION ROUTES (Public - for desktop app update checking)
// These endpoints allow the desktop app to check for updates
// =============================================================================

// Rate limiter for version check endpoints (generous limits)
const versionCheckLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60, // 60 requests per 15 minutes per IP (4 per minute)
  message: 'Too many version check requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  }
});

// Get latest version for a platform (public - used by desktop app)
app.get('/api/app-version/latest', versionCheckLimiter, appVersionController.getLatestVersion);

// Check if update is available (public - used by desktop app)
app.get('/api/app-version/check', versionCheckLimiter, appVersionController.checkForUpdate);

// Get all releases for a platform (protected - admin view)
app.get('/api/app-version/releases', authMiddleware, appVersionController.getAllReleases);

// Create a new release (protected - admin only)
app.post('/api/app-version/releases', authMiddleware, appVersionController.createRelease);

// Compute SHA256 checksum for a file URL (protected - admin utility)
app.post('/api/app-version/compute-checksum', authMiddleware, appVersionController.computeChecksum);

// =============================================================================
// NOTIFICATION ROUTES (Protected - require authMiddleware)
// Email notifications for login reminders, download reminders, new versions, etc.
// =============================================================================

// Mount notification routes
app.use('/api/notifications', authMiddleware, notificationController);

// =============================================================================
// FORGE REMOTE ROUTES (require Forge Invocation Token authentication)
// These endpoints are called by the Forge app via Forge Remote
// =============================================================================

// Rate limiter for Forge routes
const forgeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 200, // 200 requests per minute per IP
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use cloudId from FIT token if available for rate limiting per tenant
    return req.forgeContext?.cloudId || req.ip || 'unknown';
  }
});

// Generic Supabase query endpoint
app.post('/api/forge/supabase/query', forgeLimiter, forgeAuthMiddleware, forgeProxyController.supabaseQuery);

// Batch endpoint - fetches all dashboard data in single request (RECOMMENDED)
app.post('/api/forge/dashboard', forgeLimiter, forgeAuthMiddleware, forgeProxyController.getDashboardData);

// Organization management
app.post('/api/forge/organization', forgeLimiter, forgeAuthMiddleware, forgeProxyController.getOrCreateOrganization);
app.post('/api/forge/organization/membership', forgeLimiter, forgeAuthMiddleware, forgeProxyController.getOrganizationMembership);

// User management
app.post('/api/forge/user', forgeLimiter, forgeAuthMiddleware, forgeProxyController.getOrCreateUser);

// Storage operations
app.post('/api/forge/storage/upload', forgeLimiter, forgeAuthMiddleware, forgeProxyController.storageUpload);
app.post('/api/forge/storage/signed-url', forgeLimiter, forgeAuthMiddleware, forgeProxyController.storageSignedUrl);
app.post('/api/forge/storage/delete', forgeLimiter, forgeAuthMiddleware, forgeProxyController.storageDelete);

// App version (for update notifications in Forge UI)
app.post('/api/forge/app-version/latest', forgeLimiter, forgeAuthMiddleware, forgeProxyController.getLatestAppVersion);

// Feedback session (opens feedback form in browser)
app.post('/api/forge/feedback/session', forgeLimiter, forgeAuthMiddleware, forgeProxyController.createFeedbackSession);

// =============================================================================
// PROTECTED ROUTES (require authMiddleware)
// =============================================================================

// Routes
app.post('/api/analyze-screenshot', authMiddleware, screenshotController.analyzeScreenshot);
app.post('/api/process-brd', authMiddleware, brdController.processBRD);

// Activity tracking endpoints (new event-based pipeline)
app.post('/api/analyze-batch', authMiddleware, activityController.analyzeBatch);
// classify-app uses Atlassian token auth (desktop app sends OAuth token)
app.post('/api/classify-app', atlassianAuthMiddleware, activityController.classifyApp);
// identify-app uses Forge auth (called from Forge app for admin app classification)
app.post('/api/identify-app', forgeLimiter, forgeAuthMiddleware, activityController.identifyApp);

// Manual trigger for clustering - called by organization admins from Forge app
app.post('/api/trigger-clustering', authMiddleware, async (req, res, next) => {
  try {
    const { userId, organizationId } = req.body;

    if (!userId || !organizationId) {
      return res.status(400).json({
        success: false,
        error: 'userId and organizationId are required'
      });
    }

    // Check if clustering is already running
    if (clusteringPollingService.isClusteringRunning()) {
      return res.status(409).json({
        success: false,
        error: 'Clustering is already in progress. Please wait for it to complete.'
      });
    }

    logger.info(`[API] Manual clustering triggered for user ${userId} in org ${organizationId}`);

    // Process the specific user's unassigned work
    await clusteringPollingService.processUserUnassignedWork(userId, organizationId);

    res.json({
      success: true,
      message: 'Clustering completed successfully'
    });
  } catch (error) {
    logger.error('[API] Error in manual clustering:', error);
    next(error);
  }
});

// Trigger clustering for entire organization (admin only)
app.post('/api/trigger-org-clustering', authMiddleware, async (req, res, next) => {
  try {
    const { organizationId } = req.body;

    if (!organizationId) {
      return res.status(400).json({
        success: false,
        error: 'organizationId is required'
      });
    }

    // Check if clustering is already running
    if (clusteringPollingService.isClusteringRunning()) {
      return res.status(409).json({
        success: false,
        error: 'Clustering is already in progress. Please wait for it to complete.'
      });
    }

    logger.info(`[API] Manual organization-wide clustering triggered for org ${organizationId}`);

    // Get all users with unassigned work in this organization
    const supabaseService = require('./services/supabase-service');
    const usersWithUnassigned = await supabaseService.getUsersWithUnassignedWork();
    
    // Filter to only users in this organization
    const orgUsers = usersWithUnassigned.filter(u => u.organization_id === organizationId);

    if (orgUsers.length === 0) {
      return res.json({
        success: true,
        message: 'No users with unassigned work found in this organization',
        usersProcessed: 0
      });
    }

    logger.info(`[API] Found ${orgUsers.length} users with unassigned work in org ${organizationId}`);

    let successCount = 0;
    let errorCount = 0;

    // Process each user
    for (const user of orgUsers) {
      try {
        await clusteringPollingService.processUserUnassignedWork(user.id, organizationId);
        successCount++;
      } catch (error) {
        errorCount++;
        logger.error(`[API] Error processing user ${user.id}:`, error);
      }
    }

    res.json({
      success: true,
      message: `Clustering completed. ${successCount} users processed, ${errorCount} errors.`,
      usersProcessed: successCount,
      errors: errorCount
    });
  } catch (error) {
    logger.error('[API] Error in organization clustering:', error);
    next(error);
  }
});

app.post('/api/cluster-unassigned-work', async (req, res, next) => {
  try {
    const { sessions, userIssues } = req.body;

    if (!sessions || !Array.isArray(sessions)) {
      return res.status(400).json({
        success: false,
        error: 'Sessions array required'
      });
    }

    const clusteringService = require('./services/clustering-service');
    const result = await clusteringService.clusterUnassignedWork(sessions, userIssues || []);

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Manual trigger for cleanup - deletes old screenshot files from storage
app.post('/api/trigger-cleanup', authMiddleware, async (req, res, next) => {
  try {
    // Check if cleanup is already running
    if (cleanupService.isCleanupRunning()) {
      return res.status(409).json({
        success: false,
        error: 'Cleanup is already in progress. Please wait for it to complete.'
      });
    }

    logger.info('[API] Manual cleanup triggered');

    const result = await cleanupService.runCleanup();

    res.json({
      success: result.success,
      message: `Cleanup completed. ${result.deleted} files deleted, ${result.errors} errors.`,
      filesDeleted: result.deleted,
      errors: result.errors
    });
  } catch (error) {
    logger.error('[API] Error in manual cleanup:', error);
    next(error);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);

  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Start server with async initialization
async function startServer() {
  return new Promise((resolve) => {
    app.listen(PORT, async () => {
      logger.info(`AI Analysis Server running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
      
      // Initialize AI clients at startup
      logger.info('Initializing AI clients...');
      aiService.initializeClient();

      // Initialize Google Sheets logger for LLM usage tracking
      initializeSheetsLogger();

      // Initialize cost tracker for Sheet 2 (cost tracking)
      const { initializeCostTracker } = require('./services/cost-tracker');
      initializeCostTracker();

      // Step 1: Start clustering service first (includes startup clustering if needed)
      // This runs any missed clustering before we start processing new screenshots
      logger.info('Initializing clustering service...');
      await clusteringPollingService.start();
      logger.info('Clustering service initialized - daily clustering scheduled');

      // Step 2: Start screenshot analysis polling AFTER clustering is ready
      // This ensures we don't have race conditions between analysis and clustering
      pollingService.start();
      logger.info('Screenshot analysis polling service started - will process pending screenshots automatically');

      // Step 3: Start cleanup service for old screenshot files
      // Runs monthly to delete files older than 2 months
      await cleanupService.start();
      logger.info('Cleanup service started - monthly cleanup scheduled');

      // Step 4: Start activity polling service for new event-based pipeline
      // Processes pending activity_records (text-only AI analysis)
      activityPollingService.start();
      logger.info('Activity polling service started - will process pending activity records');

      // Step 5: Start notification polling service for email notifications
      // Sends login reminders, download reminders, new version alerts, and inactivity alerts
      if (process.env.EMAIL_PROVIDER) {
        notificationPollingService.start();
        logger.info('Notification polling service started - will send email notifications');
      } else {
        logger.info('Notification polling service not started - EMAIL_PROVIDER not configured');
      }

      resolve();
    });
  });
}

// Initialize server
try {
  await startServer();
} catch (error) {
  logger.error('Failed to start server:', error);
  process.exit(1);
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  pollingService.stop();
  clusteringPollingService.stop();
  cleanupService.stop();
  activityPollingService.stop();
  notificationPollingService.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  pollingService.stop();
  clusteringPollingService.stop();
  cleanupService.stop();
  activityPollingService.stop();
  notificationPollingService.stop();
  process.exit(0);
});
