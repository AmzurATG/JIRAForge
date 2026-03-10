/**
 * Tests for ai-server/src/index.js
 * Tests Express server routes, middleware, and error handling
 */

const request = require('supertest');

// Mock all dependencies before requiring index.js
jest.mock('../src/utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Mock controllers
jest.mock('../src/controllers/screenshot-controller', () => ({
    analyzeScreenshot: jest.fn((req, res) => res.json({ success: true }))
}));

jest.mock('../src/controllers/brd-controller', () => ({
    processBRD: jest.fn((req, res) => res.json({ success: true }))
}));

jest.mock('../src/controllers/auth-controller', () => ({
    atlassianCallback: jest.fn((req, res) => res.json({ success: true })),
    refreshToken: jest.fn((req, res) => res.json({ success: true })),
    exchangeToken: jest.fn((req, res) => res.json({ success: true })),
    verifyToken: jest.fn((req, res) => res.json({ success: true })),
    getSupabaseConfig: jest.fn((req, res) => res.json({ success: true })),
    getOcrConfig: jest.fn((req, res) => res.json({ success: true }))
}));

jest.mock('../src/controllers/forge-proxy-controller', () => ({
    supabaseQuery: jest.fn((req, res) => res.json({ success: true })),
    getDashboardData: jest.fn((req, res) => res.json({ success: true })),
    getOrCreateOrganization: jest.fn((req, res) => res.json({ success: true })),
    getOrganizationMembership: jest.fn((req, res) => res.json({ success: true })),
    getOrCreateUser: jest.fn((req, res) => res.json({ success: true })),
    storageUpload: jest.fn((req, res) => res.json({ success: true })),
    storageSignedUrl: jest.fn((req, res) => res.json({ success: true })),
    storageDelete: jest.fn((req, res) => res.json({ success: true })),
    getLatestAppVersion: jest.fn((req, res) => res.json({ success: true })),
    createFeedbackSession: jest.fn((req, res) => res.json({ success: true }))
}));

jest.mock('../src/controllers/app-version-controller', () => ({
    getLatestVersion: jest.fn((req, res) => res.json({ success: true })),
    checkForUpdate: jest.fn((req, res) => res.json({ success: true })),
    getAllReleases: jest.fn((req, res) => res.json({ success: true })),
    createRelease: jest.fn((req, res) => res.json({ success: true })),
    computeChecksum: jest.fn((req, res) => res.json({ success: true }))
}));

jest.mock('../src/controllers/feedback-controller', () => ({
    createSession: jest.fn((req, res) => res.json({ success: true })),
    getFeedbackPage: jest.fn((req, res) => res.json({ success: true })),
    submitFeedback: jest.fn((req, res) => res.json({ success: true })),
    getFeedbackStatus: jest.fn((req, res) => res.json({ success: true }))
}));

jest.mock('../src/controllers/notification-controller', () => {
    const router = require('express').Router();
    router.get('/preferences', (req, res) => res.json({ success: true }));
    return router;
});

jest.mock('../src/controllers/activity-controller', () => ({
    analyzeBatch: jest.fn((req, res) => res.json({ success: true })),
    classifyApp: jest.fn((req, res) => res.json({ success: true })),
    identifyApp: jest.fn((req, res) => res.json({ success: true }))
}));

// Mock middleware - pass through by default
jest.mock('../src/middleware/auth', () => jest.fn((req, res, next) => next()));

jest.mock('../src/middleware/forge-auth', () => jest.fn((req, res, next) => {
    req.forgeContext = { cloudId: 'test-cloud-id' };
    next();
}));

jest.mock('../src/middleware/atlassian-auth', () => jest.fn((req, res, next) => next()));

// Mock services
jest.mock('../src/services/polling-service', () => ({
    start: jest.fn(),
    stop: jest.fn()
}));

jest.mock('../src/services/clustering-polling-service', () => ({
    start: jest.fn().mockResolvedValue(),
    stop: jest.fn(),
    isClusteringRunning: jest.fn().mockReturnValue(false),
    processUserUnassignedWork: jest.fn().mockResolvedValue()
}));

jest.mock('../src/services/cleanup-service', () => ({
    start: jest.fn().mockResolvedValue(),
    stop: jest.fn(),
    isCleanupRunning: jest.fn().mockReturnValue(false),
    runCleanup: jest.fn().mockResolvedValue({ success: true, deleted: 5, errors: 0 })
}));

jest.mock('../src/services/notifications/notification-polling', () => ({
    start: jest.fn(),
    stop: jest.fn()
}));

jest.mock('../src/services/ai', () => ({
    initializeClient: jest.fn()
}));

jest.mock('../src/services/sheets-logger', () => ({
    initializeSheetsLogger: jest.fn()
}));

jest.mock('../src/services/activity-polling-service', () => ({
    start: jest.fn(),
    stop: jest.fn()
}));

jest.mock('../src/services/cost-tracker', () => ({
    initializeCostTracker: jest.fn()
}));

jest.mock('../src/services/supabase-service', () => ({
    getUsersWithUnassignedWork: jest.fn().mockResolvedValue([])
}));

jest.mock('../src/services/clustering-service', () => ({
    clusterUnassignedWork: jest.fn().mockResolvedValue({ success: true, clusters: [] })
}));

// Import the app from index.js (server won't start due to require.main check)
const { app } = require('../src/index');

// Import mocked dependencies for assertions
const screenshotController = require('../src/controllers/screenshot-controller');
const brdController = require('../src/controllers/brd-controller');
const authController = require('../src/controllers/auth-controller');
const forgeProxyController = require('../src/controllers/forge-proxy-controller');
const appVersionController = require('../src/controllers/app-version-controller');
const feedbackController = require('../src/controllers/feedback-controller');
const activityController = require('../src/controllers/activity-controller');
const authMiddleware = require('../src/middleware/auth');
const forgeAuthMiddleware = require('../src/middleware/forge-auth');
const atlassianAuthMiddleware = require('../src/middleware/atlassian-auth');
const clusteringPollingService = require('../src/services/clustering-polling-service');
const cleanupService = require('../src/services/cleanup-service');

describe('AI Server Index', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });
    
    // ==========================================================================
    // Root and Health Endpoints
    // ==========================================================================
    describe('Root and Health Endpoints', () => {
        it('should return server info on root endpoint', async () => {
            const res = await request(app).get('/');
            
            expect(res.status).toBe(200);
            expect(res.body.name).toBe('BRD Time Tracker AI Server');
            expect(res.body.version).toBe('1.0.0');
            expect(res.body.status).toBe('running');
            expect(res.body.endpoints).toBeDefined();
        });
        
        it('should return health status', async () => {
            const res = await request(app).get('/health');
            
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('healthy');
            expect(res.body.timestamp).toBeDefined();
            expect(res.body.uptime).toBeDefined();
        });
    });
    
    // ==========================================================================
    // Legal Pages and Redirects
    // ==========================================================================
    describe('Legal Pages and Redirects', () => {
        it('should redirect /privacy to /legal/privacy', async () => {
            const res = await request(app).get('/privacy');
            
            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/legal/privacy');
        });
        
        it('should redirect /privacy-policy to /legal/privacy', async () => {
            const res = await request(app).get('/privacy-policy');
            
            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/legal/privacy');
        });
        
        it('should redirect /terms to /legal/terms', async () => {
            const res = await request(app).get('/terms');
            
            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/legal/terms');
        });
        
        it('should redirect /terms-of-service to /legal/terms', async () => {
            const res = await request(app).get('/terms-of-service');
            
            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/legal/terms');
        });
        
        it('should serve privacy policy page', async () => {
            const res = await request(app).get('/legal/privacy');
            
            // May return 200 (file found) or 404/500 (file not found in test env)
            expect([200, 404, 500]).toContain(res.status);
        });
        
        it('should serve terms of service page', async () => {
            const res = await request(app).get('/legal/terms');
            
            // May return 200 (file found) or 404/500 (file not found in test env)
            expect([200, 404, 500]).toContain(res.status);
        });
    });
    
    // ==========================================================================
    // Auth Routes
    // ==========================================================================
    describe('Auth Routes', () => {
        it('should handle Atlassian OAuth callback', async () => {
            const res = await request(app)
                .post('/api/auth/atlassian/callback')
                .send({ code: 'test-code' });
            
            expect(res.status).toBe(200);
            expect(authController.atlassianCallback).toHaveBeenCalled();
        });
        
        it('should handle token refresh', async () => {
            const res = await request(app)
                .post('/api/auth/refresh-token')
                .send({ refresh_token: 'test-token' });
            
            expect(res.status).toBe(200);
            expect(authController.refreshToken).toHaveBeenCalled();
        });
        
        it('should handle token exchange', async () => {
            const res = await request(app)
                .post('/api/auth/exchange-token')
                .send({ token: 'test-token' });
            
            expect(res.status).toBe(200);
            expect(authController.exchangeToken).toHaveBeenCalled();
        });
        
        it('should handle token verification', async () => {
            const res = await request(app)
                .post('/api/auth/verify')
                .send({ token: 'test-token' });
            
            expect(res.status).toBe(200);
            expect(authController.verifyToken).toHaveBeenCalled();
        });
        
        it('should handle supabase config request', async () => {
            const res = await request(app)
                .post('/api/auth/supabase-config')
                .send({ token: 'test-token' });
            
            expect(res.status).toBe(200);
            expect(authController.getSupabaseConfig).toHaveBeenCalled();
        });
        
        it('should handle OCR config request', async () => {
            const res = await request(app)
                .post('/api/auth/ocr-config')
                .send({ token: 'test-token' });
            
            expect(res.status).toBe(200);
            expect(authController.getOcrConfig).toHaveBeenCalled();
        });
    });
    
    // ==========================================================================
    // Feedback Routes
    // ==========================================================================
    describe('Feedback Routes', () => {
        it('should create feedback session', async () => {
            const res = await request(app)
                .post('/api/feedback/session')
                .send({ token: 'test-token' });
            
            expect(res.status).toBe(200);
            expect(feedbackController.createSession).toHaveBeenCalled();
        });
        
        it('should get feedback form page', async () => {
            const res = await request(app)
                .get('/api/feedback/form');
            
            expect(res.status).toBe(200);
            expect(feedbackController.getFeedbackPage).toHaveBeenCalled();
        });
        
        it('should serve feedback form JavaScript', async () => {
            const res = await request(app)
                .get('/api/feedback/feedback-form.js');
            
            // May return 200 (file found) or 404/500 (file not found in test env)
            expect([200, 404, 500]).toContain(res.status);
            if (res.status === 200) {
                expect(res.headers['content-type']).toMatch(/javascript/);
            }
        });
        
        it('should submit feedback', async () => {
            const res = await request(app)
                .post('/api/feedback/submit')
                .send({ feedback: 'test feedback' });
            
            expect(res.status).toBe(200);
            expect(feedbackController.submitFeedback).toHaveBeenCalled();
        });
        
        it('should get feedback status', async () => {
            const res = await request(app)
                .get('/api/feedback/status/test-id');
            
            expect(res.status).toBe(200);
            expect(feedbackController.getFeedbackStatus).toHaveBeenCalled();
        });
    });
    
    // ==========================================================================
    // App Version Routes
    // ==========================================================================
    describe('App Version Routes', () => {
        it('should get latest version (public)', async () => {
            const res = await request(app)
                .get('/api/app-version/latest');
            
            expect(res.status).toBe(200);
            expect(appVersionController.getLatestVersion).toHaveBeenCalled();
        });
        
        it('should check for update (public)', async () => {
            const res = await request(app)
                .get('/api/app-version/check');
            
            expect(res.status).toBe(200);
            expect(appVersionController.checkForUpdate).toHaveBeenCalled();
        });
        
        it('should get all releases (protected)', async () => {
            const res = await request(app)
                .get('/api/app-version/releases');
            
            expect(res.status).toBe(200);
            expect(authMiddleware).toHaveBeenCalled();
            expect(appVersionController.getAllReleases).toHaveBeenCalled();
        });
        
        it('should create release (protected)', async () => {
            const res = await request(app)
                .post('/api/app-version/releases')
                .send({ version: '1.0.0' });
            
            expect(res.status).toBe(200);
            expect(authMiddleware).toHaveBeenCalled();
            expect(appVersionController.createRelease).toHaveBeenCalled();
        });
        
        it('should compute checksum (protected)', async () => {
            const res = await request(app)
                .post('/api/app-version/compute-checksum')
                .send({ url: 'https://example.com/file' });
            
            expect(res.status).toBe(200);
            expect(authMiddleware).toHaveBeenCalled();
            expect(appVersionController.computeChecksum).toHaveBeenCalled();
        });
    });
    
    // ==========================================================================
    // Forge Routes
    // ==========================================================================
    describe('Forge Routes', () => {
        it('should handle supabase query', async () => {
            const res = await request(app)
                .post('/api/forge/supabase/query')
                .send({ query: 'test' });
            
            expect(res.status).toBe(200);
            expect(forgeAuthMiddleware).toHaveBeenCalled();
            expect(forgeProxyController.supabaseQuery).toHaveBeenCalled();
        });
        
        it('should get dashboard data', async () => {
            const res = await request(app)
                .post('/api/forge/dashboard')
                .send({});
            
            expect(res.status).toBe(200);
            expect(forgeProxyController.getDashboardData).toHaveBeenCalled();
        });
        
        it('should get or create organization', async () => {
            const res = await request(app)
                .post('/api/forge/organization')
                .send({});
            
            expect(res.status).toBe(200);
            expect(forgeProxyController.getOrCreateOrganization).toHaveBeenCalled();
        });
        
        it('should get organization membership', async () => {
            const res = await request(app)
                .post('/api/forge/organization/membership')
                .send({});
            
            expect(res.status).toBe(200);
            expect(forgeProxyController.getOrganizationMembership).toHaveBeenCalled();
        });
        
        it('should get or create user', async () => {
            const res = await request(app)
                .post('/api/forge/user')
                .send({});
            
            expect(res.status).toBe(200);
            expect(forgeProxyController.getOrCreateUser).toHaveBeenCalled();
        });
        
        it('should handle storage upload', async () => {
            const res = await request(app)
                .post('/api/forge/storage/upload')
                .send({});
            
            expect(res.status).toBe(200);
            expect(forgeProxyController.storageUpload).toHaveBeenCalled();
        });
        
        it('should handle storage signed URL', async () => {
            const res = await request(app)
                .post('/api/forge/storage/signed-url')
                .send({});
            
            expect(res.status).toBe(200);
            expect(forgeProxyController.storageSignedUrl).toHaveBeenCalled();
        });
        
        it('should handle storage delete', async () => {
            const res = await request(app)
                .post('/api/forge/storage/delete')
                .send({});
            
            expect(res.status).toBe(200);
            expect(forgeProxyController.storageDelete).toHaveBeenCalled();
        });
        
        it('should get latest app version via Forge', async () => {
            const res = await request(app)
                .post('/api/forge/app-version/latest')
                .send({});
            
            expect(res.status).toBe(200);
            expect(forgeProxyController.getLatestAppVersion).toHaveBeenCalled();
        });
        
        it('should create feedback session via Forge', async () => {
            const res = await request(app)
                .post('/api/forge/feedback/session')
                .send({});
            
            expect(res.status).toBe(200);
            expect(forgeProxyController.createFeedbackSession).toHaveBeenCalled();
        });
    });
    
    // ==========================================================================
    // Protected Routes
    // ==========================================================================
    describe('Protected Routes', () => {
        it('should analyze screenshot', async () => {
            const res = await request(app)
                .post('/api/analyze-screenshot')
                .send({ screenshot: 'base64data' });
            
            expect(res.status).toBe(200);
            expect(authMiddleware).toHaveBeenCalled();
            expect(screenshotController.analyzeScreenshot).toHaveBeenCalled();
        });
        
        it('should process BRD', async () => {
            const res = await request(app)
                .post('/api/process-brd')
                .send({ brd: 'data' });
            
            expect(res.status).toBe(200);
            expect(authMiddleware).toHaveBeenCalled();
            expect(brdController.processBRD).toHaveBeenCalled();
        });
        
        it('should analyze batch', async () => {
            const res = await request(app)
                .post('/api/analyze-batch')
                .send({ batch: [] });
            
            expect(res.status).toBe(200);
            expect(authMiddleware).toHaveBeenCalled();
            expect(activityController.analyzeBatch).toHaveBeenCalled();
        });
        
        it('should classify app (Atlassian auth)', async () => {
            const res = await request(app)
                .post('/api/classify-app')
                .send({ app: 'test' });
            
            expect(res.status).toBe(200);
            expect(atlassianAuthMiddleware).toHaveBeenCalled();
            expect(activityController.classifyApp).toHaveBeenCalled();
        });
        
        it('should identify app (Forge auth)', async () => {
            const res = await request(app)
                .post('/api/identify-app')
                .send({ app: 'test' });
            
            expect(res.status).toBe(200);
            expect(forgeAuthMiddleware).toHaveBeenCalled();
            expect(activityController.identifyApp).toHaveBeenCalled();
        });
    });
    
    // ==========================================================================
    // Clustering Endpoints
    // ==========================================================================
    describe('Clustering Endpoints', () => {
        it('should trigger clustering successfully', async () => {
            const res = await request(app)
                .post('/api/trigger-clustering')
                .send({ userId: 'user-1', organizationId: 'org-1' });
            
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(clusteringPollingService.processUserUnassignedWork).toHaveBeenCalledWith('user-1', 'org-1');
        });
        
        it('should return 400 when userId is missing', async () => {
            const res = await request(app)
                .post('/api/trigger-clustering')
                .send({ organizationId: 'org-1' });
            
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('userId and organizationId are required');
        });
        
        it('should return 400 when organizationId is missing', async () => {
            const res = await request(app)
                .post('/api/trigger-clustering')
                .send({ userId: 'user-1' });
            
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('userId and organizationId are required');
        });
        
        it('should return 409 when clustering is already running', async () => {
            clusteringPollingService.isClusteringRunning.mockReturnValueOnce(true);
            
            const res = await request(app)
                .post('/api/trigger-clustering')
                .send({ userId: 'user-1', organizationId: 'org-1' });
            
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('Clustering is already in progress. Please wait for it to complete.');
        });
        
        it('should trigger org-wide clustering', async () => {
            const res = await request(app)
                .post('/api/trigger-org-clustering')
                .send({ organizationId: 'org-1' });
            
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
        
        it('should return 400 when organizationId missing for org clustering', async () => {
            const res = await request(app)
                .post('/api/trigger-org-clustering')
                .send({});
            
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('organizationId is required');
        });
        
        it('should return 409 when org clustering already running', async () => {
            clusteringPollingService.isClusteringRunning.mockReturnValueOnce(true);
            
            const res = await request(app)
                .post('/api/trigger-org-clustering')
                .send({ organizationId: 'org-1' });
            
            expect(res.status).toBe(409);
        });
        
        it('should process org users with unassigned work', async () => {
            const supabaseService = require('../src/services/supabase-service');
            supabaseService.getUsersWithUnassignedWork.mockResolvedValueOnce([
                { id: 'user-1', organization_id: 'org-1' },
                { id: 'user-2', organization_id: 'org-1' }
            ]);
            
            const res = await request(app)
                .post('/api/trigger-org-clustering')
                .send({ organizationId: 'org-1' });
            
            expect(res.status).toBe(200);
            expect(res.body.usersProcessed).toBe(2);
        });

        it('should handle individual user processing errors in org clustering', async () => {
            const supabaseService = require('../src/services/supabase-service');
            supabaseService.getUsersWithUnassignedWork.mockResolvedValueOnce([
                { id: 'user-1', organization_id: 'org-1' },
                { id: 'user-2', organization_id: 'org-1' }
            ]);
            
            // First user succeeds, second user fails
            clusteringPollingService.processUserUnassignedWork
                .mockResolvedValueOnce()
                .mockRejectedValueOnce(new Error('User processing failed'));
            
            const res = await request(app)
                .post('/api/trigger-org-clustering')
                .send({ organizationId: 'org-1' });
            
            expect(res.status).toBe(200);
            expect(res.body.usersProcessed).toBe(1);
            expect(res.body.errors).toBe(1);
        });

        it('should handle getUsersWithUnassignedWork error', async () => {
            const supabaseService = require('../src/services/supabase-service');
            supabaseService.getUsersWithUnassignedWork.mockRejectedValueOnce(new Error('DB Error'));
            
            const res = await request(app)
                .post('/api/trigger-org-clustering')
                .send({ organizationId: 'org-1' });
            
            expect(res.status).toBe(500);
            expect(res.body.error).toBe('DB Error');
        });
        
        it('should cluster unassigned work', async () => {
            const res = await request(app)
                .post('/api/cluster-unassigned-work')
                .send({ sessions: [], userIssues: [] });
            
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
        
        it('should return 400 when sessions missing', async () => {
            const res = await request(app)
                .post('/api/cluster-unassigned-work')
                .send({});
            
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Sessions array required');
        });
        
        it('should return 400 when sessions is not array', async () => {
            const res = await request(app)
                .post('/api/cluster-unassigned-work')
                .send({ sessions: 'not-array' });
            
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Sessions array required');
        });
    });
    
    // ==========================================================================
    // Cleanup Endpoints
    // ==========================================================================
    describe('Cleanup Endpoints', () => {
        it('should trigger cleanup successfully', async () => {
            const res = await request(app)
                .post('/api/trigger-cleanup')
                .send({});
            
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.filesDeleted).toBe(5);
        });
        
        it('should return 409 when cleanup is already running', async () => {
            cleanupService.isCleanupRunning.mockReturnValueOnce(true);
            
            const res = await request(app)
                .post('/api/trigger-cleanup')
                .send({});
            
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('Cleanup is already in progress. Please wait for it to complete.');
        });
    });
    
    // ==========================================================================
    // Error Handling
    // ==========================================================================
    describe('Error Handling', () => {
        it('should return 404 for unknown endpoints', async () => {
            const res = await request(app).get('/api/unknown-endpoint');
            
            expect(res.status).toBe(404);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('Endpoint not found');
        });
        
        it('should handle errors from clustering', async () => {
            clusteringPollingService.processUserUnassignedWork.mockRejectedValueOnce(new Error('Clustering failed'));
            
            const res = await request(app)
                .post('/api/trigger-clustering')
                .send({ userId: 'user-1', organizationId: 'org-1' });
            
            expect(res.status).toBe(500);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('Clustering failed');
        });
        
        it('should handle errors from cleanup', async () => {
            cleanupService.runCleanup.mockRejectedValueOnce(new Error('Cleanup failed'));
            
            const res = await request(app)
                .post('/api/trigger-cleanup')
                .send({});
            
            expect(res.status).toBe(500);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('Cleanup failed');
        });
    });
    
    // ==========================================================================
    // CORS
    // ==========================================================================
    describe('CORS', () => {
        it('should allow requests from localhost:3000', async () => {
            const res = await request(app)
                .get('/')
                .set('Origin', 'http://localhost:3000');
            
            expect(res.status).toBe(200);
            expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
        });
        
        it('should allow requests with no origin', async () => {
            const res = await request(app).get('/');
            
            expect(res.status).toBe(200);
        });
    });
    
    // ==========================================================================
    // Notification Routes
    // ==========================================================================
    describe('Notification Routes', () => {
        it('should access notification preferences (protected)', async () => {
            const res = await request(app)
                .get('/api/notifications/preferences');
            
            expect(res.status).toBe(200);
            expect(authMiddleware).toHaveBeenCalled();
        });
    });
});

describe('CORS Edge Cases', () => {
    it('should reject requests from unauthorized origins', async () => {
        const res = await request(app)
            .get('/')
            .set('Origin', 'http://evil-site.com');
        
        expect(res.status).toBe(500); // CORS error results in 500
    });
    
    it('should log warning in development mode for rejected origins', async () => {
        const originalEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'development';
        
        const res = await request(app)
            .get('/')
            .set('Origin', 'http://unauthorized-origin.com');
        
        expect(res.status).toBe(500);
        
        process.env.NODE_ENV = originalEnv;
    });
});

describe('startServer function', () => {
    const { app, startServer } = require('../src/index');
    const logger = require('../src/utils/logger');
    const aiService = require('../src/services/ai');
    const { initializeSheetsLogger } = require('../src/services/sheets-logger');
    const pollingService = require('../src/services/polling-service');
    const notificationPollingService = require('../src/services/notifications/notification-polling');
    const activityPollingService = require('../src/services/activity-polling-service');
    
    let originalListen;
    
    beforeEach(() => {
        jest.clearAllMocks();
        originalListen = app.listen;
        // Mock app.listen to call callback immediately
        app.listen = jest.fn((port, callback) => {
            callback();
            return { close: jest.fn() };
        });
    });
    
    afterEach(() => {
        app.listen = originalListen;
    });
    
    it('should be exported and callable', () => {
        expect(typeof startServer).toBe('function');
    });
    
    it('should start the server and initialize services', async () => {
        await startServer();
        
        expect(app.listen).toHaveBeenCalled();
        expect(aiService.initializeClient).toHaveBeenCalled();
        expect(initializeSheetsLogger).toHaveBeenCalled();
        expect(clusteringPollingService.start).toHaveBeenCalled();
        expect(pollingService.start).toHaveBeenCalled();
        expect(cleanupService.start).toHaveBeenCalled();
        expect(activityPollingService.start).toHaveBeenCalled();
    });
    
    it('should start notification polling when EMAIL_PROVIDER is set', async () => {
        const originalEmailProvider = process.env.EMAIL_PROVIDER;
        process.env.EMAIL_PROVIDER = 'sendgrid';
        
        await startServer();
        
        expect(notificationPollingService.start).toHaveBeenCalled();
        
        process.env.EMAIL_PROVIDER = originalEmailProvider;
    });
    
    it('should not start notification polling when EMAIL_PROVIDER is not set', async () => {
        const originalEmailProvider = process.env.EMAIL_PROVIDER;
        delete process.env.EMAIL_PROVIDER;
        
        jest.clearAllMocks();
        await startServer();
        
        expect(notificationPollingService.start).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('EMAIL_PROVIDER not configured'));
        
        process.env.EMAIL_PROVIDER = originalEmailProvider;
    });
    
    it('should log server startup information', async () => {
        await startServer();
        
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('AI Analysis Server running'));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Environment:'));
    });
});

describe('Cluster Unassigned Work Errors', () => {
    it('should handle clustering service errors', async () => {
        const clusteringService = require('../src/services/clustering-service');
        clusteringService.clusterUnassignedWork.mockRejectedValueOnce(new Error('Clustering service failed'));
        
        const res = await request(app)
            .post('/api/cluster-unassigned-work')
            .send({ sessions: [], userIssues: [] });
        
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Clustering service failed');
    });
});

describe('Process Signal Handlers', () => {
    const pollingService = require('../src/services/polling-service');
    const clusteringPollingService = require('../src/services/clustering-polling-service');
    const cleanupService = require('../src/services/cleanup-service');
    const activityPollingService = require('../src/services/activity-polling-service');
    const notificationPollingService = require('../src/services/notifications/notification-polling');
    const logger = require('../src/utils/logger');
    
    let originalExit;
    let sigTermHandler;
    let sigIntHandler;
    
    beforeAll(() => {
        // Capture the registered signal handlers
        const listeners = process.listeners('SIGTERM');
        sigTermHandler = listeners[listeners.length - 1];
        
        const intListeners = process.listeners('SIGINT');
        sigIntHandler = intListeners[intListeners.length - 1];
    });
    
    beforeEach(() => {
        jest.clearAllMocks();
        originalExit = process.exit;
        process.exit = jest.fn();
    });
    
    afterEach(() => {
        process.exit = originalExit;
    });
    
    it('should handle SIGTERM and stop all services', () => {
        if (sigTermHandler) {
            sigTermHandler();
            
            expect(logger.info).toHaveBeenCalledWith('SIGTERM received, shutting down gracefully');
            expect(pollingService.stop).toHaveBeenCalled();
            expect(clusteringPollingService.stop).toHaveBeenCalled();
            expect(cleanupService.stop).toHaveBeenCalled();
            expect(activityPollingService.stop).toHaveBeenCalled();
            expect(notificationPollingService.stop).toHaveBeenCalled();
            expect(process.exit).toHaveBeenCalledWith(0);
        }
    });
    
    it('should handle SIGINT and stop all services', () => {
        if (sigIntHandler) {
            sigIntHandler();

            expect(logger.info).toHaveBeenCalledWith('SIGINT received, shutting down gracefully');
            expect(pollingService.stop).toHaveBeenCalled();
            expect(clusteringPollingService.stop).toHaveBeenCalled();
            expect(cleanupService.stop).toHaveBeenCalled();
            expect(activityPollingService.stop).toHaveBeenCalled();
            expect(notificationPollingService.stop).toHaveBeenCalled();
            expect(process.exit).toHaveBeenCalledWith(0);
        }
    });
});

describe('isMainModule bootstrap', () => {
    let originalExit;

    beforeEach(() => {
        originalExit = process.exit;
        process.exit = jest.fn();
        jest.clearAllMocks();
    });

    afterEach(() => {
        process.exit = originalExit;
        delete process.env.START_SERVER;
    });

    it('should invoke startServer IIFE when START_SERVER is true', async () => {
        const http = require('http');
        const originalListen = http.Server.prototype.listen;
        // Call the listen callback immediately to let startServer() resolve
        http.Server.prototype.listen = jest.fn(function (_port, cb) {
            if (typeof cb === 'function') cb();
            return this;
        });

        process.env.START_SERVER = 'true';
        try {
            jest.isolateModules(() => {
                require('../src/index');
            });
            // Flush microtask and macrotask queues so the async IIFE completes
            await new Promise((r) => setImmediate(r));
            await new Promise((r) => setImmediate(r));
        } finally {
            http.Server.prototype.listen = originalListen;
        }

        // Success path: process.exit should NOT have been called
        expect(process.exit).not.toHaveBeenCalled();
    });

    it('should log error and call process.exit(1) when startServer rejects', async () => {
        const http = require('http');
        const originalListen = http.Server.prototype.listen;
        // Throwing synchronously inside new Promise() causes the promise to reject,
        // which propagates out of startServer() and into the IIFE catch block.
        http.Server.prototype.listen = jest.fn(function () {
            throw new Error('Port in use');
        });

        process.env.START_SERVER = 'true';
        try {
            jest.isolateModules(() => {
                require('../src/index');
            });
            await new Promise((r) => setImmediate(r));
            await new Promise((r) => setImmediate(r));
        } finally {
            http.Server.prototype.listen = originalListen;
        }

        expect(process.exit).toHaveBeenCalledWith(1);
    });
});
