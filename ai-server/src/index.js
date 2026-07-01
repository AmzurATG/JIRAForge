const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const path = require('node:path');
const fs = require('node:fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const authController = require('./controllers/auth-controller');
const googleAuthController = require('./controllers/google-auth-controller');
const forgeProxyController = require('./controllers/forge-proxy-controller');
const appVersionController = require('./controllers/app-version-controller');
const feedbackController = require('./controllers/feedback-controller');
const notificationController = require('./controllers/notification-controller');
const userDataController = require('./controllers/user-data-controller');
const portalAuthController = require('./controllers/portal-auth-controller');
const portalController = require('./controllers/portal-controller');
const portalReportsController = require('./controllers/portal-reports-controller');
const portalAdminUsersController = require('./controllers/portal-admin-users-controller');
const portalAppClassificationsController = require('./controllers/portal-app-classifications-controller');
const portalLobController = require('./controllers/portal-lob-controller');
const portalLobRosterController = require('./controllers/portal-lob-roster-controller');
const portalAppCatalogController = require('./controllers/portal-app-catalog-controller');
const portalLobAppClassificationsController = require('./controllers/portal-lob-app-classifications-controller');
const portalEmployeeProfileController = require('./controllers/portal-employee-profile-controller');
const portalHolidayController = require('./controllers/portal-holiday-controller');
const desktopDqNudgesController = require('./controllers/desktop-dq-nudges-controller');
const desktopDqPreferencesController = require('./controllers/desktop-dq-preferences-controller');
const authMiddleware = require('./middleware/auth');
const forgeAuthMiddleware = require('./middleware/forge-auth');
const atlassianAuthMiddleware = require('./middleware/atlassian-auth');
const desktopAuthMiddleware = require('./middleware/desktop-auth');
const portalAuthMiddleware = require('./middleware/portal-auth');
const logger = require('./utils/logger');
const clusteringPollingService = require('./services/clustering-polling-service');
const notificationPollingService = require('./services/notifications/notification-polling');
const aiService = require('./services/ai');
const activityController = require('./controllers/activity-controller');
const analyticsController = require('./controllers/analytics-controller');
const adminDashboardController = require('./controllers/admin-dashboard-controller');
const activityPollingService = require('./services/activity-polling-service');
// REMOVABLE: AI accuracy tracking dashboard. Surfaced inside the Forge app
// frontend (Admin tab); these endpoints are gated by forgeAuthMiddleware (FIT)
// and the per-user email allowlist is enforced inside the Forge resolver
// before it calls these routes.
const accuracyDashboardController = require('./controllers/accuracy-dashboard-controller');
// AI-assisted Jira ticket description quality analysis. Forge-authenticated.
const descriptionController = require('./controllers/description-controller');
const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy - required for ngrok tunnel
app.set('trust proxy', 1);

// CORS configuration - whitelist trusted origins.
// CORS_ALLOWED_ORIGIN accepts a single origin OR a comma-separated list, so the
// separately-deployed portal frontend (Vercel) plus any preview/custom domains
// can all be whitelisted via env without a code change. Example:
//   CORS_ALLOWED_ORIGIN=https://myworkmate.amzur.com
const allowedOrigins = [
  // Production domains (set via env)
  process.env.AI_SERVER_URL,
  ...(process.env.CORS_ALLOWED_ORIGIN || '')
    .split(',')
    .map((o) => o.trim()),
  // Development
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002', // Portal frontend
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002', // Portal frontend
].filter(Boolean); // Remove undefined/empty values

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (desktop apps, server-to-server, same-origin)
    if (!origin) {
      return callback(null, true);
    }
    // Check if origin is in whitelist
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Always log the rejected origin (the Origin header is not sensitive) so a
    // CORS misconfiguration is diagnosable in production, not only in dev.
    logger.warn(`[CORS] Rejected origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  optionsSuccessStatus: 200
};

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // Allow inline scripts for admin dashboard
      styleSrc: ["'self'", "'unsafe-inline'"],   // Allow inline styles
      imgSrc: ["'self'", "data:", "https:"],
    }
  }
}));
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  // Use a simple key generator that works with proxies
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  }
});

// Apply general rate limiter to all /api/ routes EXCEPT /api/forge/* and /api/auth/*
// Forge routes have their own forgeLimiter. All Forge calls come from Atlassian's
// shared infrastructure IPs so a shared IP-based bucket would block all tenants.
// Auth routes are split between loginLimiter (login) and backgroundAuthLimiter
// (token refresh and other background ops) to prevent running app instances
// from exhausting the budget for new logins.
app.use('/api/', (req, res, next) => {
  if (req.path.startsWith('/forge/')) return next();
  if (req.path.startsWith('/auth/')) return next();
  // Portal data routes have their own (per-user) limiter below — keep them out of
  // this strict IP-keyed bucket so a shared office/NAT IP can't starve all users.
  if (req.path.startsWith('/portal/')) return next();
  return limiter(req, res, next);
});

// Portal API limiter — generous and keyed by the authenticated portal USER (from
// the JWT) rather than IP, so multiple portal users behind one shared office/NAT
// IP don't drain a single bucket (the cause of intermittent 429s on the portal).
// Portal /auth/* routes are excluded here and keep their stricter login limiters.
const portalApiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 300,                 // per portal user per window (the UI fires several calls per page)
  message: 'Too many requests, please slow down and try again shortly.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      try {
        // decode only (no verify) — purely to bucket by user; the route still
        // enforces real auth via verifyPortalToken.
        const decoded = jwt.decode(auth.slice(7));
        if (decoded && decoded.userId) return `puser:${decoded.userId}`;
      } catch (_) { /* fall through to IP */ }
    }
    return req.ip || req.headers['x-forwarded-for'] || 'unknown';
  }
});
app.use('/api/portal/', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next(); // login/forgot/reset keep their auth limiters
  return portalApiLimiter(req, res, next);
});

// Rate limiter for public/health endpoints — prevents abuse during DDoS
const publicLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,                  // 30 requests per minute per IP
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  }
});

// Strict rate limiter for the actual login endpoint (/api/auth/atlassian/callback).
// Prevents brute-force auth-code replay. Users rarely log in more than a handful
// of times in 15 minutes, so 30 is generous without opening abuse surface.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 login attempts per 15 minutes per IP
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  }
});

// Generous rate limiter for background auth operations (token refresh, config
// fetches, diagnostics). These run continuously in every running desktop app
// instance and must NOT share a bucket with the login flow — otherwise
// background refreshes from logged-in users exhaust the budget for new logins.
// 500 req/10 min covers ~10 users each doing a token refresh every ~1 min.
const backgroundAuthLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 500, // 500 requests per 10 minutes per IP
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  }
});

// Keep authLimiter as an alias used by admin dashboard login and other
// misc auth endpoints that are not background operations.
const authLimiter = loginLimiter;

// Lenient rate limiter for OAuth callbacks (Google already rate-limits their OAuth flow)
const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // 500 requests per 15 minutes per IP (generous for dev/testing)
  message: 'Too many OAuth attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  }
});

// REMOVABLE: dedicated limiter for the AI accuracy dashboard. publicLimiter
// (30/min) is too tight here: each dashboard refresh fires ~6 parallel
// requests (orgs + 5 panels), and changing a filter retriggers all of them.
// 200/min comfortably covers a person actively iterating on prompt-tuning
// while still rate-limiting brute-force token guessing.
const accuracyDashboardLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 200,
  message: 'Too many requests, please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  }
});

// Root endpoint
app.get('/', publicLimiter, (req, res) => {
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
app.get('/health', publicLimiter, (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    features: {
      descriptionContextEnrichment: true,
      imageAttachments: true,
      parentContext: true
    }
  });
});

// =============================================================================
// ADMIN DASHBOARD (Simple server-side dashboard - password protected)
// =============================================================================

// Serve the dashboard HTML page (public — login happens client-side)
app.get('/admin-dashboard', publicLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'admin-dashboard.html'));
});

// Dashboard login — validates password, returns session token
app.post('/admin-dashboard/api/login', authLimiter, adminDashboardController.login);

// Dashboard API — protected by session token
app.get('/admin-dashboard/api/stats', adminDashboardController.requireSession, adminDashboardController.getStats);

// =============================================================================
// AI ACCURACY DASHBOARD — REMOVABLE LAYER
// Surfaced inside the Forge app frontend (Admin tab). Gated by FIT
// (forgeAuthMiddleware); per-user email allowlist enforced inside the Forge
// resolver before it calls these routes. Delete this whole block plus the
// controller, the resolver in forge-app/src/resolvers/accuracyDashboardResolvers.js,
// the AdminAccuracyDashboardTab in static/main, and the migrations to
// remove the layer entirely. See plan/AI_ACCURACY_TRACKING_IMPLEMENTATION_PLAN.md.
// =============================================================================

// Dedicated limiter (200/min) — each dashboard refresh fires several parallel
// requests (orgs + summary/wrong-pairs/by-app/recent-mistakes), and changing
// a filter retriggers all of them.
app.get('/api/forge/accuracy/orgs', accuracyDashboardLimiter, forgeAuthMiddleware, accuracyDashboardController.listOrgs);
app.get('/api/forge/accuracy/summary', accuracyDashboardLimiter, forgeAuthMiddleware, accuracyDashboardController.getSummary);
app.get('/api/forge/accuracy/wrong-pairs', accuracyDashboardLimiter, forgeAuthMiddleware, accuracyDashboardController.getWrongPairs);
app.get('/api/forge/accuracy/by-app', accuracyDashboardLimiter, forgeAuthMiddleware, accuracyDashboardController.getByApp);
app.get('/api/forge/accuracy/recent-mistakes', accuracyDashboardLimiter, forgeAuthMiddleware, accuracyDashboardController.getRecentMistakes);

// =============================================================================
// LEGAL PAGES (Public - served as HTML from layout + content templates)
// =============================================================================

function renderLegalPage(title, pageTitle, contentFile) {
  const legalDir = path.join(__dirname, 'legal');
  const layout = fs.readFileSync(path.join(legalDir, 'layout.html'), 'utf8');
  const content = fs.readFileSync(path.join(legalDir, contentFile), 'utf8');
  return layout
    .replace('{{title}}', title)
    .replace('{{pageTitle}}', pageTitle)
    .replace('{{content}}', content);
}

// Privacy Policy
app.get('/legal/privacy', publicLimiter, (req, res) => {
  res.type('html').send(renderLegalPage('Privacy Policy - BRD Time Tracker', 'Privacy Policy', 'privacy-content.html'));
});

// Terms of Service
app.get('/legal/terms', publicLimiter, (req, res) => {
  res.type('html').send(renderLegalPage('Terms of Service - BRD Time Tracker', 'Terms of Service', 'terms-content.html'));
});

// Legal page styles (shared by Terms and Privacy pages)
app.get('/legal/styles.css', publicLimiter, (req, res) => {
  res.type('text/css');
  res.sendFile(path.join(__dirname, 'legal', 'styles.css'));
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

// Public OAuth config (exposes only the client ID — safe for browsers)
app.get('/api/auth/config', authLimiter, authController.getOAuthConfig);

// Exchange OAuth code for tokens (Atlassian OAuth callback proxy).
// Strict loginLimiter: this is the actual login step; keep it isolated from
// background ops so refresh-token floods can never block a fresh login.
app.post('/api/auth/atlassian/callback', loginLimiter, authController.atlassianCallback);

// Background auth operations — use the generous backgroundAuthLimiter so that
// token refreshes from many concurrent logged-in users don't exhaust the budget
// for new login attempts.

// Refresh Atlassian access token (runs continuously while app is open).
// LEGACY from desktop <= 1.4.7; kept fully functional during the custody
// migration (plan/2026-06-12_auth_server-side-token-custody.md).
app.post('/api/auth/refresh-token', backgroundAuthLimiter, authController.refreshToken);

// Server-side token custody (Phase 2): devices hold a revocable session token
// and fetch short-lived access tokens; rotation happens only on this server.
app.post('/api/auth/access-token', backgroundAuthLimiter, authController.getDeviceAccessToken);
app.post('/api/auth/migrate-custody', loginLimiter, authController.migrateCustody);
app.post('/api/auth/device/revoke', backgroundAuthLimiter, authController.revokeDevice);

// Exchange Atlassian token for Supabase JWT
app.post('/api/auth/exchange-token', backgroundAuthLimiter, authController.exchangeToken);

// Non-Jira Google SSO: exchange Google OAuth code (PKCE) for a Supabase JWT.
// Self-signup gated by the org_email_domains allowlist (company email only).
app.post('/api/auth/desktop-google', oauthLimiter, googleAuthController.desktopGoogleLogin);

// Re-mint the (1h) Supabase JWT for a Google user from their stored refresh token.
app.post('/api/auth/desktop-google/refresh', authLimiter, googleAuthController.desktopGoogleRefresh);

// Verify Atlassian token
app.post('/api/auth/verify', backgroundAuthLimiter, authController.verifyToken);

// Get Supabase configuration (returns credentials after verifying Atlassian token)
app.post('/api/auth/supabase-config', backgroundAuthLimiter, authController.getSupabaseConfig);

// Get OCR configuration (returns OCR settings after verifying Atlassian token)
app.post('/api/auth/ocr-config', backgroundAuthLimiter, authController.getOcrConfig);

// Submit client diagnostics (OCR status, login events, errors)
app.post('/api/auth/diagnostics', backgroundAuthLimiter, authController.submitDiagnostics);



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
// Rate-limited to prevent polling abuse
app.get('/api/feedback/status/:id', publicLimiter, feedbackController.getFeedbackStatus);

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
// All Forge app calls arrive from Atlassian's shared infrastructure IPs,
// not individual user IPs. We use a per-tenant key (cloudId) set by
// forgeAuthMiddleware. The limiter is applied AFTER auth so cloudId is available.
const forgeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 200, // 200 requests per minute per tenant (cloudId)
  message: 'Too many requests from this tenant, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // forgeAuthMiddleware runs before this limiter in the middleware chain
    return req.forgeContext?.cloudId || req.ip || 'unknown';
  }
});

// Helper: apply forgeAuth BEFORE forgeLimiter so cloudId-based keying works
const forgeMiddleware = [forgeAuthMiddleware, forgeLimiter];

// Generic Supabase query endpoint
app.post('/api/forge/supabase/query', ...forgeMiddleware, forgeProxyController.supabaseQuery);

// Batch endpoint - fetches all dashboard data in single request (RECOMMENDED)
app.post('/api/forge/dashboard', ...forgeMiddleware, forgeProxyController.getDashboardData);

// Organization management
app.post('/api/forge/organization', ...forgeMiddleware, forgeProxyController.getOrCreateOrganization);
app.post('/api/forge/organization/membership', ...forgeMiddleware, forgeProxyController.getOrganizationMembership);

// User management
app.post('/api/forge/user', ...forgeMiddleware, forgeProxyController.getOrCreateUser);

// Storage operations — larger body limit for file uploads
app.post('/api/forge/storage/upload', express.json({ limit: '10mb' }), ...forgeMiddleware, forgeProxyController.storageUpload);
app.post('/api/forge/storage/signed-url', ...forgeMiddleware, forgeProxyController.storageSignedUrl);
app.post('/api/forge/storage/delete', ...forgeMiddleware, forgeProxyController.storageDelete);

// App version (for update notifications in Forge UI)
app.post('/api/forge/app-version/latest', ...forgeMiddleware, forgeProxyController.getLatestAppVersion);

// Feedback session (opens feedback form in browser)
app.post('/api/forge/feedback/session', ...forgeMiddleware, forgeProxyController.createFeedbackSession);

// Issue cache — called by the avi:jira:updated:issue trigger to keep user_jira_issues_cache fresh
app.post('/api/forge/issues/cache', ...forgeMiddleware, forgeProxyController.cacheUserIssues);

// Recently active accounts — called by the scheduled Forge cache refresh trigger
app.get('/api/forge/issues/active-accounts', ...forgeMiddleware, forgeProxyController.getRecentlyActiveAccounts);

// Description quality (AI-assisted ticket description enhancement)
app.post('/api/forge/description/analyze', ...forgeMiddleware, descriptionController.analyze);
app.post('/api/forge/description/scores/batch', ...forgeMiddleware, descriptionController.getScoresBatch);
app.post('/api/forge/description/event', ...forgeMiddleware, descriptionController.recordEvent);
app.post('/api/forge/description/sync-issue-unassigned', ...forgeMiddleware, descriptionController.syncIssueUnassigned);
app.post('/api/forge/description/sync-all-unassigned', ...forgeMiddleware, descriptionController.syncAllUnassigned);

// Uninstall handler — called when app is uninstalled from Jira site (Forge-authenticated)
// Marks organization for deletion with 30-day grace period
const uninstallController = require('./controllers/uninstall-controller');

app.post('/api/forge/uninstall', ...forgeMiddleware, uninstallController.handleUninstall);

// Manual deletion trigger (Admin-only - for testing/recovery)
// Processes organizations that have passed the 30-day grace period
const { processScheduledDeletions } = require('./services/deletion-service');
app.post('/api/admin/process-deletions', authMiddleware, async (req, res) => {
  try {
    const result = await processScheduledDeletions();
    res.json(result);
  } catch (error) {
    logger.error('[Admin] Failed to process scheduled deletions', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================================================
// PERSONAL DATA REPORTING API (GDPR Compliance)
// Implements Atlassian's Personal Data Reporting API for user data export/deletion
// Requires Forge Invocation Token (FIT) authentication
// =============================================================================

// Mount user data routes
app.use('/api/v1/user-data', userDataController);

// =============================================================================
// PROTECTED ROUTES (require authMiddleware)
// =============================================================================

// Routes — apply larger body limit for upload-heavy endpoints
// Activity tracking endpoints (new event-based pipeline)
app.post('/api/analyze-batch', express.json({ limit: '10mb' }), authMiddleware, activityController.analyzeBatch);
// classify-app uses desktop dual auth: Atlassian token (Jira users) OR Supabase
// JWT (non-Jira Google users). Google users have no Atlassian token, so an
// Atlassian-only guard would 401 them and skip AI app classification.
app.post('/api/classify-app', desktopAuthMiddleware, activityController.classifyApp);
// identify-app uses Forge auth (called from Forge app for admin app classification)
app.post('/api/identify-app', ...forgeMiddleware, activityController.identifyApp);

// Description-Quality scheduled nudges (Enhancement #13) — desktop endpoints.
// Both routers use desktopAuthMiddleware (Supabase JWT OR Atlassian token).
app.use('/api/desktop/description-quality-nudges', desktopAuthMiddleware, desktopDqNudgesController);
app.use('/api/desktop/preferences/dq-nudges', desktopAuthMiddleware, desktopDqPreferencesController);

// Analytics endpoints (unified aggregation service)
app.get('/api/analytics/daily', authMiddleware, analyticsController.getDailyTotal);
app.get('/api/analytics/weekly', authMiddleware, analyticsController.getWeeklyTotal);

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

app.post('/api/cluster-unassigned-work', authMiddleware, async (req, res, next) => {
  try {
    const { sessions, userIssues } = req.body;

    if (!sessions || !Array.isArray(sessions)) {
      return res.status(400).json({
        success: false,
        error: 'Sessions array required'
      });
    }

    // Limit input size to prevent resource exhaustion / DDoS amplification
    const MAX_SESSIONS = 500;
    const MAX_ISSUES = 1000;
    if (sessions.length > MAX_SESSIONS) {
      return res.status(400).json({
        success: false,
        error: `Too many sessions (max ${MAX_SESSIONS})`
      });
    }
    if (Array.isArray(userIssues) && userIssues.length > MAX_ISSUES) {
      return res.status(400).json({
        success: false,
        error: `Too many issues (max ${MAX_ISSUES})`
      });
    }

    const clusteringService = require('./services/clustering-service');
    const result = await clusteringService.clusterUnassignedWork(sessions, userIssues || []);

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// =============================================================================
// WEB PRODUCTIVITY PORTAL ROUTES (JWT-authenticated)
// Standalone portal for HR/management to view employee analytics
// No Jira integration — uses email/password auth
// =============================================================================

// Debug middleware to log ALL portal requests
app.use('/api/portal', (req, res, next) => {
  logger.info('[Portal Request]', {
    method: req.method,
    path: req.path,
    url: req.url,
    origin: req.headers.origin,
    hasAuth: !!req.headers.authorization
  });
  next();
});

// Portal authentication (public - no auth required)
app.post('/api/portal/auth/login', authLimiter, portalAuthController.login);
app.post('/api/portal/auth/logout', portalAuthController.logout);
app.post('/api/portal/auth/forgot-password', authLimiter, portalAuthController.requestPasswordReset);
app.post('/api/portal/auth/reset-password', authLimiter, portalAuthController.resetPassword);

// Google OAuth for Portal SSO
app.get('/api/portal/auth/google/url', oauthLimiter, portalAuthController.getGoogleAuthUrl);
app.post('/api/portal/auth/google/callback', oauthLimiter, portalAuthController.googleCallback);

// Portal password management (authenticated)
app.post('/api/portal/auth/change-password', portalAuthMiddleware.verifyPortalToken, portalAuthController.changePassword);
app.post('/api/portal/auth/admin-reset-password', portalAuthMiddleware.verifyPortalToken, portalAuthController.adminResetPassword);

// Portal analytics endpoints (authenticated)
app.get('/api/portal/dashboard', portalAuthMiddleware.verifyPortalToken, portalController.getDashboard);
app.get('/api/portal/employees/list', portalAuthMiddleware.verifyPortalToken, portalController.getEmployeesList);
app.get('/api/portal/employees', portalAuthMiddleware.verifyPortalToken, portalController.getEmployees);
app.get('/api/portal/employees/:userId', portalAuthMiddleware.verifyPortalToken, portalController.getEmployeeDetail);
app.get('/api/portal/employees/:userId/logs', portalAuthMiddleware.verifyPortalToken, portalController.getEmployeeLogs);
app.get('/api/portal/time-logs', portalAuthMiddleware.verifyPortalToken, portalController.getTimeLogs);

// Employee locations (WS-B) — list: any portal user; manage: superadmin only
app.get('/api/portal/locations', portalAuthMiddleware.verifyPortalToken, portalEmployeeProfileController.getLocations);
app.post('/api/portal/locations', portalAuthMiddleware.verifyPortalToken, portalEmployeeProfileController.createLocation);
app.put('/api/portal/locations/:id', portalAuthMiddleware.verifyPortalToken, portalEmployeeProfileController.updateLocation);
app.delete('/api/portal/locations/:id', portalAuthMiddleware.verifyPortalToken, portalEmployeeProfileController.deleteLocation);
// Per-employee portal profile (location assignment) — superadmin only
app.put('/api/portal/employees/:userId/profile', portalAuthMiddleware.verifyPortalToken, portalEmployeeProfileController.setEmployeeProfile);
// Bulk location assignment (Employees action bar + Locations members picker) — superadmin only
app.put('/api/portal/employees/profiles', portalAuthMiddleware.verifyPortalToken, portalEmployeeProfileController.bulkSetEmployeeProfiles);

// Company holidays — list: any portal user (needed for legal-hours); manage: superadmin only
app.get('/api/portal/holidays', portalAuthMiddleware.verifyPortalToken, portalHolidayController.getHolidays);
app.post('/api/portal/holidays', portalAuthMiddleware.verifyPortalToken, portalHolidayController.createHoliday);
app.put('/api/portal/holidays/:id', portalAuthMiddleware.verifyPortalToken, portalHolidayController.updateHoliday);
app.delete('/api/portal/holidays/:id', portalAuthMiddleware.verifyPortalToken, portalHolidayController.deleteHoliday);

// Portal reports endpoints (authenticated)
app.get('/api/portal/reports/data', portalAuthMiddleware.verifyPortalToken, portalReportsController.getReportData);
app.get('/api/portal/reports/export/csv', portalAuthMiddleware.verifyPortalToken, portalReportsController.exportCSV);
app.get('/api/portal/reports/export/excel', portalAuthMiddleware.verifyPortalToken, portalReportsController.exportExcel);
app.get('/api/portal/reports/export/pdf', portalAuthMiddleware.verifyPortalToken, portalReportsController.exportPDF);

// Portal admin users endpoints (authenticated - superadmin only)
app.get('/api/portal/admin-users', portalAuthMiddleware.verifyPortalToken, portalAdminUsersController.getAdminUsers);
app.post('/api/portal/admin-users', portalAuthMiddleware.verifyPortalToken, portalAdminUsersController.createAdminUser);
app.put('/api/portal/admin-users/:userId', portalAuthMiddleware.verifyPortalToken, portalAdminUsersController.updateAdminUser);
app.delete('/api/portal/admin-users/:userId', portalAuthMiddleware.verifyPortalToken, portalAdminUsersController.deleteAdminUser);

// Portal application classifications endpoints (authenticated - admin/superadmin)
app.get('/api/portal/app-classifications', portalAuthMiddleware.verifyPortalToken, portalAppClassificationsController.getAppClassifications);
app.post('/api/portal/app-classifications', portalAuthMiddleware.verifyPortalToken, portalAppClassificationsController.createAppClassification);
app.post('/api/portal/app-classifications/bulk-import', portalAuthMiddleware.verifyPortalToken, portalAppClassificationsController.bulkImportAppClassifications);
app.put('/api/portal/app-classifications/:id', portalAuthMiddleware.verifyPortalToken, portalAppClassificationsController.updateAppClassification);
app.delete('/api/portal/app-classifications/:id', portalAuthMiddleware.verifyPortalToken, portalAppClassificationsController.deleteAppClassification);

// =============================================================================
// LOB SEGMENTATION & RBAC (Phase 1) — all authenticated; role/scope enforced in
// controllers. Analytics scoping itself is gated by PORTAL_LOB_ENFORCEMENT.
// =============================================================================

// LOB management (create/update/delete: superadmin; list: superadmin or head)
app.get('/api/portal/lobs', portalAuthMiddleware.verifyPortalToken, portalLobController.getLobs);
app.post('/api/portal/lobs', portalAuthMiddleware.verifyPortalToken, portalLobController.createLob);
app.put('/api/portal/lobs/:lobId', portalAuthMiddleware.verifyPortalToken, portalLobController.updateLob);
app.delete('/api/portal/lobs/:lobId', portalAuthMiddleware.verifyPortalToken, portalLobController.deleteLob);

// LOB members (employees) — manage: superadmin; list: superadmin or head of LOB
app.get('/api/portal/lobs/:lobId/members', portalAuthMiddleware.verifyPortalToken, portalLobController.getMembers);
app.post('/api/portal/lobs/:lobId/members', portalAuthMiddleware.verifyPortalToken, portalLobController.addMembers);
app.delete('/api/portal/lobs/:lobId/members/:userId', portalAuthMiddleware.verifyPortalToken, portalLobController.removeMember);

// LOB expected-member roster (adoption tracking) — import/delete: superadmin; read: superadmin or head
app.post('/api/portal/lobs/:lobId/roster/import', portalAuthMiddleware.verifyPortalToken, portalLobRosterController.importRoster);
app.get('/api/portal/lobs/:lobId/roster', portalAuthMiddleware.verifyPortalToken, portalLobRosterController.getRoster);
app.delete('/api/portal/lobs/:lobId/roster/:id', portalAuthMiddleware.verifyPortalToken, portalLobRosterController.removeRosterEntry);

// LOB heads — superadmin only
app.get('/api/portal/lobs/:lobId/heads', portalAuthMiddleware.verifyPortalToken, portalLobController.getHeads);
app.post('/api/portal/lobs/:lobId/heads', portalAuthMiddleware.verifyPortalToken, portalLobController.addHeads);
app.delete('/api/portal/lobs/:lobId/heads/:adminId', portalAuthMiddleware.verifyPortalToken, portalLobController.removeHead);

// Per-LOB app classifications — superadmin or head of the LOB
app.get('/api/portal/lobs/:lobId/app-classifications', portalAuthMiddleware.verifyPortalToken, portalLobAppClassificationsController.getClassifications);
// Apps used by this LOB but not yet in the catalog (discovery)
app.get('/api/portal/lobs/:lobId/unlisted-apps', portalAuthMiddleware.verifyPortalToken, portalLobAppClassificationsController.getUnlistedApps);
// Add a new application to this LOB (find-or-create catalog entry + classify)
app.post('/api/portal/lobs/:lobId/apps', portalAuthMiddleware.verifyPortalToken, portalLobAppClassificationsController.addApp);
app.put('/api/portal/lobs/:lobId/app-classifications', portalAuthMiddleware.verifyPortalToken, portalLobAppClassificationsController.setClassification);
app.post('/api/portal/lobs/:lobId/app-classifications/bulk', portalAuthMiddleware.verifyPortalToken, portalLobAppClassificationsController.bulkSet);
app.delete('/api/portal/lobs/:lobId/app-classifications/:appId', portalAuthMiddleware.verifyPortalToken, portalLobAppClassificationsController.deleteClassification);

// Shared application catalog — read: any portal user; write: superadmin
// AI app-suggest is LLM-backed (cost) — tighter per-user budget on top of the
// general portal limiter. Keyed by the authenticated portal user (JWT), not IP.
const aiSuggestLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15,             // 15 AI suggestions/min per portal user
  message: 'Too many AI suggestions, please slow down and try again shortly.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      try {
        const decoded = jwt.decode(auth.slice(7));
        if (decoded && decoded.userId) return `puser:${decoded.userId}`;
      } catch (_) { /* fall through to IP */ }
    }
    return req.ip || 'unknown';
  }
});

app.get('/api/portal/app-catalog', portalAuthMiddleware.verifyPortalToken, portalAppCatalogController.getCatalog);
// AI-assisted suggestion for the Add Application modal (any portal user; gated by PORTAL_AI_APP_SUGGEST)
app.post('/api/portal/app-catalog/ai-suggest', portalAuthMiddleware.verifyPortalToken, aiSuggestLimiter, portalAppCatalogController.aiSuggest);
app.post('/api/portal/app-catalog', portalAuthMiddleware.verifyPortalToken, portalAppCatalogController.createApp);
app.post('/api/portal/app-catalog/bulk-import', portalAuthMiddleware.verifyPortalToken, portalAppCatalogController.bulkImport);
app.put('/api/portal/app-catalog/:id', portalAuthMiddleware.verifyPortalToken, portalAppCatalogController.updateApp);
app.delete('/api/portal/app-catalog/:id', portalAuthMiddleware.verifyPortalToken, portalAppCatalogController.deleteApp);

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
    const server = app.listen(PORT, async () => {
      // DDoS protection: connection and request timeouts
      server.timeout = 120000;          // 120s max for entire request (some AI calls are slow)
      server.headersTimeout = 15000;    // 15s to receive all headers — prevents slow-loris
      server.keepAliveTimeout = 5000;   // 5s keep-alive — prevents connection hogging
      server.maxHeadersCount = 50;      // Limit number of headers per request

      logger.info(`AI Analysis Server running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);

      // Initialize AI clients at startup
      logger.info('Initializing AI clients...');
      aiService.initializeClient();


      // Step 1: Start clustering service first (includes startup clustering if needed)
      logger.info('Initializing clustering service...');
      await clusteringPollingService.start();
      logger.info('Clustering service initialized - daily clustering scheduled');

      // Step 2: Start activity polling service for event-based pipeline
      // Processes pending activity_records (text-only AI analysis)
      activityPollingService.start();
      logger.info('Activity polling service started - will process pending activity records');

      // Step 3: Start notification polling service for email notifications
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

// Export for testing
module.exports = { app, startServer };

// Only start server if this file is run directly (not imported)
// This allows tests to import the app without starting the server
const isMainModule = require.main === module || process.env.START_SERVER === 'true';

if (isMainModule) {
  // Initialize server
  (async () => {
    try {
      await startServer();
    } catch (error) {
      logger.error('Failed to start server:', error);
      process.exit(1);
    }
  })();
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  clusteringPollingService.stop();
  activityPollingService.stop();
  notificationPollingService.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  clusteringPollingService.stop();
  activityPollingService.stop();
  notificationPollingService.stop();
  process.exit(0);
});
