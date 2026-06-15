/**
 * Auth Controller Unit Tests
 */

const axios = require('axios');
const jwt = require('jsonwebtoken');
const authController = require('../../src/controllers/auth-controller');
const logger = require('../../src/utils/logger');
const { getClient } = require('../../src/services/db/supabase-client');

// Mock all dependencies
jest.mock('axios');
jest.mock('jsonwebtoken');
jest.mock('../../src/utils/logger');
jest.mock('../../src/services/db/supabase-client');
jest.mock('../../src/services/token-custody-service');

const custody = require('../../src/services/token-custody-service');

describe('Auth Controller', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    
    req = {
      body: {},
      query: {}
    };
    
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    
    // Set default environment variables
    process.env.ATLASSIAN_CLIENT_ID = 'test-client-id';
    process.env.ATLASSIAN_CLIENT_SECRET = 'test-client-secret';
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    process.env.SUPABASE_URL = 'https://test.supabase.co';
  });

  afterEach(() => {
    delete process.env.ATLASSIAN_CLIENT_ID;
    delete process.env.ATLASSIAN_CLIENT_SECRET;
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_URL;
  });

  describe('atlassianCallback', () => {
    it('should exchange code for tokens successfully', async () => {
      req.body = {
        code: 'test-code',
        redirect_uri: 'http://localhost:3000/callback'
      };

      axios.post.mockResolvedValue({
        data: {
          access_token: 'access-123',
          refresh_token: 'refresh-123',
          expires_in: 3600,
          token_type: 'Bearer'
        }
      });

      await authController.atlassianCallback(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        access_token: 'access-123',
        refresh_token: 'refresh-123',
        expires_in: 3600,
        token_type: 'Bearer'
      });
      expect(axios.post).toHaveBeenCalledWith(
        'https://auth.atlassian.com/oauth/token',
        expect.objectContaining({
          grant_type: 'authorization_code',
          code: 'test-code',
          redirect_uri: 'http://localhost:3000/callback'
        }),
        expect.any(Object)
      );
    });

    it('should exchange code for tokens with PKCE', async () => {
      req.body = {
        code: 'test-code',
        redirect_uri: 'http://localhost:3000/callback',
        code_verifier: 'test-verifier'
      };

      axios.post.mockResolvedValue({
        data: {
          access_token: 'access-123',
          refresh_token: 'refresh-123',
          expires_in: 3600,
          token_type: 'Bearer'
        }
      });

      await authController.atlassianCallback(req, res);

      expect(axios.post).toHaveBeenCalledWith(
        'https://auth.atlassian.com/oauth/token',
        expect.objectContaining({
          code_verifier: 'test-verifier'
        }),
        expect.any(Object)
      );
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('with PKCE'));
    });

    it('should return 400 if code is missing', async () => {
      req.body = {
        redirect_uri: 'http://localhost:3000/callback'
      };

      await authController.atlassianCallback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Authorization code is required'
      });
    });

    it('should return 400 if redirect_uri is missing', async () => {
      req.body = {
        code: 'test-code'
      };

      await authController.atlassianCallback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Redirect URI is required'
      });
    });

    it('should return 500 if Atlassian credentials not configured', async () => {
      delete process.env.ATLASSIAN_CLIENT_ID;
      req.body = {
        code: 'test-code',
        redirect_uri: 'http://localhost:3000/callback'
      };

      await authController.atlassianCallback(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Server configuration error')
      });
    });

    it('should handle Atlassian API errors', async () => {
      req.body = {
        code: 'invalid-code',
        redirect_uri: 'http://localhost:3000/callback'
      };

      axios.post.mockRejectedValue({
        response: {
          status: 400,
          data: {
            error: 'invalid_grant',
            error_description: 'Code expired'
          }
        }
      });

      await authController.atlassianCallback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Code expired')
      });
    });

    it('should handle network errors', async () => {
      req.body = {
        code: 'test-code',
        redirect_uri: 'http://localhost:3000/callback'
      };

      axios.post.mockRejectedValue(new Error('Network error'));

      await authController.atlassianCallback(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Network error')
      });
    });
  });

  describe('refreshToken', () => {
    it('should refresh access token successfully', async () => {
      req.body = {
        refresh_token: 'refresh-123'
      };

      axios.post.mockResolvedValue({
        data: {
          access_token: 'new-access-123',
          refresh_token: 'new-refresh-123',
          expires_in: 3600,
          token_type: 'Bearer'
        }
      });

      await authController.refreshToken(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        access_token: 'new-access-123',
        refresh_token: 'new-refresh-123',
        expires_in: 3600,
        token_type: 'Bearer'
      });
    });

    it('should use old refresh token if new one not returned', async () => {
      req.body = {
        refresh_token: 'refresh-123'
      };

      axios.post.mockResolvedValue({
        data: {
          access_token: 'new-access-123',
          expires_in: 3600,
          token_type: 'Bearer'
        }
      });

      await authController.refreshToken(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          refresh_token: 'refresh-123'
        })
      );
    });

    it('should return 400 if refresh_token is missing', async () => {
      req.body = {};

      await authController.refreshToken(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Refresh token is required'
      });
    });

    it('should return 401 if refresh token expired', async () => {
      req.body = {
        refresh_token: 'expired-token'
      };

      axios.post.mockRejectedValue({
        response: {
          status: 401,
          data: { error: 'invalid_grant' }
        }
      });

      await authController.refreshToken(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Refresh token expired'),
        requiresReauth: true,
        errorCode: 'OAUTH_REAUTH_REQUIRED'
      });
    });

    it('should treat 400 + invalid_grant as permanent (re-auth required)', async () => {
      // invalid_grant is terminal per RFC 6749 regardless of the HTTP status
      // Atlassian wraps it in. It must NOT be classified as a transient/retryable
      // failure (that is what caused the refresh-token retry storm).
      req.body = {
        refresh_token: 'invalid-token'
      };

      axios.post.mockRejectedValue({
        response: {
          status: 400,
          data: { error: 'invalid_grant' }
        }
      });

      await authController.refreshToken(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('re-authenticate'),
        requiresReauth: true,
        errorCode: 'OAUTH_REAUTH_REQUIRED'
      });
    });

    it('should treat 403 + unauthorized_client (rotated refresh token) as permanent', async () => {
      // Exact production payload from the 2026-05/06 log storm: Atlassian returns
      // HTTP 403 with this body when a refresh token has rotated out of the chain.
      req.body = { refresh_token: 'rotated-token' };

      axios.post.mockRejectedValue({
        response: {
          status: 403,
          data: { error: 'unauthorized_client', error_description: 'refresh_token is invalid' }
        }
      });

      await authController.refreshToken(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('re-authenticate'),
        requiresReauth: true,
        errorCode: 'OAUTH_REAUTH_REQUIRED'
      });
    });

    it('should treat 403 + invalid_grant (globally revoked) as permanent', async () => {
      req.body = { refresh_token: 'revoked-token' };

      axios.post.mockRejectedValue({
        response: {
          status: 403,
          data: { error: 'invalid_grant', error_description: 'Token was globally revoked' }
        }
      });

      await authController.refreshToken(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          requiresReauth: true,
          errorCode: 'OAUTH_REAUTH_REQUIRED'
        })
      );
    });

    it('should treat 403 with dead-token text in the error field itself as permanent', async () => {
      // Exact production payload from the 2026-06-12 incident: Atlassian returned
      // the dead-token wording in `error` (no error_description, no terminal OAuth
      // code), which slipped past field-equality checks and was misclassified as
      // OAUTH_TEMPORARY_FAILURE — the desktop then retried a consumed token forever.
      req.body = { refresh_token: 'consumed-token' };

      axios.post.mockRejectedValue({
        response: {
          status: 403,
          data: { error: 'refresh_token is invalid' }
        }
      });

      await authController.refreshToken(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          requiresReauth: true,
          errorCode: 'OAUTH_REAUTH_REQUIRED'
        })
      );
    });

    it('should treat 403 + non-terminal code with dead-token description as permanent', async () => {
      req.body = { refresh_token: 'consumed-token' };

      axios.post.mockRejectedValue({
        response: {
          status: 403,
          data: { error: 'access_denied', error_description: 'refresh_token is invalid' }
        }
      });

      await authController.refreshToken(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          requiresReauth: true,
          errorCode: 'OAUTH_REAUTH_REQUIRED'
        })
      );
    });

    it('should treat Atlassian documented "Unknown or invalid refresh token" wording as permanent', async () => {
      // Wording published in Atlassian's refresh-token docs for reused/expired
      // rotating tokens (403 + invalid_grant body in their docs, but the text is
      // authoritative regardless of which code wraps it).
      req.body = { refresh_token: 'reused-token' };

      axios.post.mockRejectedValue({
        response: {
          status: 400,
          data: { error: 'invalid_request', error_description: 'Unknown or invalid refresh token.' }
        }
      });

      await authController.refreshToken(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          requiresReauth: true,
          errorCode: 'OAUTH_REAUTH_REQUIRED'
        })
      );
    });

    it('should include temporary error code for 403 failures without a terminal OAuth code', async () => {
      req.body = { refresh_token: 'refresh-123' };

      axios.post.mockRejectedValue({
        response: { status: 403, data: { error: 'forbidden' } }
      });

      await authController.refreshToken(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: 'OAUTH_TEMPORARY_FAILURE'
        })
      );
    });

    it('should keep a 400 with no terminal OAuth code as a transient failure', async () => {
      // Guard against over-classifying: a malformed-request 400 that is NOT one of
      // the terminal OAuth codes must remain retryable, not force a re-auth.
      req.body = { refresh_token: 'refresh-123' };

      axios.post.mockRejectedValue({
        response: { status: 400, data: { error: 'invalid_request' } }
      });

      await authController.refreshToken(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: 'OAUTH_TEMPORARY_FAILURE'
        })
      );
    });

    it('should return 500 if Atlassian credentials not configured', async () => {
      delete process.env.ATLASSIAN_CLIENT_ID;
      req.body = { refresh_token: 'refresh-123' };

      await authController.refreshToken(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Server configuration error')
      });
    });

    it('should return 500 for non-400/401 Atlassian errors', async () => {
      req.body = { refresh_token: 'refresh-123' };

      axios.post.mockRejectedValue({
        response: { status: 503, data: { error: 'service_unavailable' } }
      });

      await authController.refreshToken(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Token refresh failed'),
        errorCode: 'OAUTH_TEMPORARY_FAILURE'
      });
    });
  });

  describe('exchangeToken', () => {
    it('should exchange Atlassian token for Supabase JWT', async () => {
      req.body = {
        atlassian_token: 'atlassian-123'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'acc-123',
          email: 'test@example.com',
          name: 'Test User'
        }
      });

      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: {
            id: 'user-uuid',
            organization_id: 'org-uuid'
          },
          error: null
        })
      };
      getClient.mockReturnValue(mockSupabase);

      jwt.sign.mockReturnValue('supabase-jwt-token');

      await authController.exchangeToken(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        supabase_token: 'supabase-jwt-token',
        expires_in: 3600,
        user: {
          id: 'user-uuid',
          atlassian_account_id: 'acc-123',
          email: 'test@example.com',
          organization_id: 'org-uuid',
          jira_cloud_id: null
        }
      });
      expect(jwt.sign).toHaveBeenCalled();
    });

    it('should return 400 if atlassian_token is missing', async () => {
      req.body = {};

      await authController.exchangeToken(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Atlassian token is required'
      });
    });

    it('should return 500 if JWT secret not configured', async () => {
      delete process.env.SUPABASE_JWT_SECRET;
      req.body = {
        atlassian_token: 'atlassian-123'
      };

      await authController.exchangeToken(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('JWT secret not configured')
      });
    });

    it('should return 401 if Atlassian token is invalid', async () => {
      req.body = {
        atlassian_token: 'invalid-token'
      };

      axios.get.mockRejectedValue({
        response: { status: 401 }
      });

      await authController.exchangeToken(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid or expired Atlassian token'
      });
    });

    it('should return 400 if account_id not in response', async () => {
      req.body = {
        atlassian_token: 'atlassian-123'
      };

      axios.get.mockResolvedValue({
        data: {
          email: 'test@example.com'
        }
      });

      await authController.exchangeToken(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Could not retrieve Atlassian account ID'
      });
    });

    it('should return 500 if Supabase client not available', async () => {
      req.body = {
        atlassian_token: 'atlassian-123'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'acc-123',
          email: 'test@example.com'
        }
      });

      getClient.mockReturnValue(null);

      await authController.exchangeToken(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('database not available')
      });
    });

    it('should return 403 if user not found in system', async () => {
      req.body = {
        atlassian_token: 'atlassian-123'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'acc-123',
          email: 'test@example.com'
        }
      });

      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: null,
          error: new Error('Not found')
        })
      };
      getClient.mockReturnValue(mockSupabase);

      await authController.exchangeToken(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('not associated with an organization')
      });
    });

    it('should return 403 if user has no organization', async () => {
      req.body = {
        atlassian_token: 'atlassian-123'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'acc-123',
          email: 'test@example.com'
        }
      });

      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: {
            id: 'user-uuid',
            organization_id: null
          },
          error: null
        })
      };
      getClient.mockReturnValue(mockSupabase);

      await authController.exchangeToken(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('not associated with an organization')
      });
    });
  });

  describe('getSupabaseConfig', () => {
    beforeEach(() => {
      process.env.SUPABASE_ANON_KEY = 'anon-key-123';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-123';
    });

    afterEach(() => {
      delete process.env.SUPABASE_ANON_KEY;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    });

    it('should return Supabase config for authenticated user', async () => {
      req.body = {
        atlassian_token: 'atlassian-123'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'acc-123',
          email: 'test@example.com'
        }
      });

      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: {
            id: 'user-uuid',
            organization_id: 'org-uuid'
          },
          error: null
        })
      };
      getClient.mockReturnValue(mockSupabase);

      await authController.getSupabaseConfig(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        supabase_url: 'https://test.supabase.co',
        supabase_anon_key: 'anon-key-123'
      });
    });

    it('should return 400 if atlassian_token is missing', async () => {
      req.body = {};

      await authController.getSupabaseConfig(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 401 for invalid token', async () => {
      req.body = {
        atlassian_token: 'invalid-token'
      };

      axios.get.mockRejectedValue({
        response: { status: 401 }
      });

      await authController.getSupabaseConfig(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('should return 500 if Supabase credentials not configured', async () => {
      delete process.env.SUPABASE_URL;
      req.body = {
        atlassian_token: 'atlassian-123'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'acc-123',
          email: 'test@example.com'
        }
      });

      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: {
            id: 'user-uuid',
            organization_id: 'org-uuid'
          },
          error: null
        })
      };
      getClient.mockReturnValue(mockSupabase);

      await authController.getSupabaseConfig(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Supabase credentials not configured')
      });
    });

    it('should return 500 if Supabase client not available', async () => {
      req.body = { atlassian_token: 'atlassian-123' };

      axios.get.mockResolvedValue({
        data: { account_id: 'acc-123', email: 'test@example.com' }
      });

      getClient.mockReturnValue(null);

      await authController.getSupabaseConfig(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('database not available')
      });
    });

    it('should return 403 if user not found in system', async () => {
      req.body = { atlassian_token: 'atlassian-123' };

      axios.get.mockResolvedValue({
        data: { account_id: 'acc-123', email: 'test@example.com' }
      });

      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: null, error: new Error('Not found') })
      };
      getClient.mockReturnValue(mockSupabase);

      await authController.getSupabaseConfig(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should return 403 if user has no organization', async () => {
      req.body = { atlassian_token: 'atlassian-123' };

      axios.get.mockResolvedValue({
        data: { account_id: 'acc-123', email: 'test@example.com' }
      });

      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: { id: 'user-uuid', organization_id: null },
          error: null
        })
      };
      getClient.mockReturnValue(mockSupabase);

      await authController.getSupabaseConfig(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('getOcrConfig', () => {
    beforeEach(() => {
      process.env.OCR_PRIMARY_ENGINE = 'paddle';
      process.env.OCR_FALLBACK_ENGINES = 'tesseract';
      process.env.OCR_USE_PREPROCESSING = 'true';
      process.env.OCR_MAX_IMAGE_DIMENSION = '4096';
      process.env.OCR_PADDLE_ENABLED = 'true';
      process.env.OCR_PADDLE_MIN_CONFIDENCE = '0.7';
    });

    afterEach(() => {
      delete process.env.OCR_PRIMARY_ENGINE;
      delete process.env.OCR_FALLBACK_ENGINES;
      delete process.env.OCR_USE_PREPROCESSING;
      delete process.env.OCR_MAX_IMAGE_DIMENSION;
      delete process.env.OCR_PADDLE_ENABLED;
      delete process.env.OCR_PADDLE_MIN_CONFIDENCE;
    });

    it('should return OCR config for authenticated user', async () => {
      req.body = {
        atlassian_token: 'atlassian-123'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'acc-123',
          email: 'test@example.com'
        }
      });

      await authController.getOcrConfig(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        config: expect.objectContaining({
          primary_engine: 'paddle',
          fallback_engines: ['tesseract'],
          use_preprocessing: true,
          max_image_dimension: 4096,
          engines: expect.any(Object)
        }),
        privacy: expect.objectContaining({
          enabled: true,
          detect_pii: true,
          detect_custom_patterns: true,
        })
      });
    });

    it('should return 400 if atlassian_token is missing', async () => {
      req.body = {};

      await authController.getOcrConfig(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 401 for invalid token', async () => {
      req.body = {
        atlassian_token: 'invalid-token'
      };

      axios.get.mockRejectedValue({
        response: { status: 401 }
      });

      await authController.getOcrConfig(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('should use default values for missing env vars', async () => {
      delete process.env.OCR_PRIMARY_ENGINE;
      delete process.env.OCR_FALLBACK_ENGINES;
      
      req.body = {
        atlassian_token: 'atlassian-123'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'acc-123',
          email: 'test@example.com'
        }
      });

      await authController.getOcrConfig(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        config: expect.objectContaining({
          primary_engine: 'rapidocr',
          fallback_engines: ['winrtocr']
        })
      }));
    });

    it('should parse OCR engine priorities from env', async () => {
      process.env.PADDLE_PRIORITY = '1';
      
      req.body = {
        atlassian_token: 'atlassian-123'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'acc-123',
          email: 'test@example.com'
        }
      });

      await authController.getOcrConfig(req, res);

      expect(res.json).toHaveBeenCalled();
      delete process.env.PADDLE_PRIORITY;
    });

    it('should capture custom engine parameters in extra_params (standardKeys.has coverage)', async () => {
      // Set up custom parameter that is NOT a standard key
      process.env.OCR_PADDLE_CUSTOM_PARAM = 'custom_value';
      process.env.OCR_PADDLE_MODEL_PATH = '/path/to/model';
      
      req.body = {
        atlassian_token: 'atlassian-123'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'acc-123',
          email: 'test@example.com'
        }
      });

      await authController.getOcrConfig(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        config: expect.objectContaining({
          engines: expect.objectContaining({
            paddle: expect.objectContaining({
              extra_params: expect.objectContaining({
                custom_param: 'custom_value',
                model_path: '/path/to/model'
              })
            })
          })
        })
      }));

      delete process.env.OCR_PADDLE_CUSTOM_PARAM;
      delete process.env.OCR_PADDLE_MODEL_PATH;
    });

    it('should use Number.parseInt for preprocessing_target_dpi', async () => {
      process.env.OCR_PREPROCESSING_TARGET_DPI = '600';
      
      req.body = {
        atlassian_token: 'atlassian-123'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'acc-123',
          email: 'test@example.com'
        }
      });

      await authController.getOcrConfig(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        config: expect.objectContaining({
          preprocessing_target_dpi: 600
        })
      }));

      delete process.env.OCR_PREPROCESSING_TARGET_DPI;
    });

    it('should use Number.parseFloat for min_confidence', async () => {
      process.env.OCR_PADDLE_MIN_CONFIDENCE = '0.85';
      
      req.body = {
        atlassian_token: 'atlassian-123'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'acc-123',
          email: 'test@example.com'
        }
      });

      await authController.getOcrConfig(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        config: expect.objectContaining({
          engines: expect.objectContaining({
            paddle: expect.objectContaining({
              min_confidence: 0.85
            })
          })
        })
      }));
    });

    it('should handle getOcrConfig internal errors', async () => {
      req.body = {
        atlassian_token: 'atlassian-123'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'acc-123',
          email: 'test@example.com'
        }
      });

      // Safely trigger the catch block by making Number.parseFloat throw
      // (used when building engine min_confidence from env vars)
      const spy = jest.spyOn(Number, 'parseFloat').mockImplementationOnce(() => {
        throw new Error('Internal error');
      });

      await authController.getOcrConfig(req, res);

      spy.mockRestore();

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Internal error')
      });
    });

    // ================================================================
    // Privacy config delivery tests
    // ================================================================

    it('should include privacy config with defaults in OCR config response', async () => {
      req.body = { atlassian_token: 'atlassian-123' };

      axios.get.mockResolvedValue({
        data: { account_id: 'acc-123', email: 'test@example.com' }
      });

      await authController.getOcrConfig(req, res);

      const response = res.json.mock.calls[0][0];
      expect(response.privacy).toBeDefined();
      expect(response.privacy).toEqual({
        enabled: true,
        min_confidence: 0.7,
        detect_pii: true,
        detect_secrets: false,
        detect_custom_patterns: true,
        redaction_strategy: 'mask',
        mask_char: '*',
        mask_length: 8,
        fail_open: false,
      });
    });

    it('should read privacy config from environment variables', async () => {
      process.env.PRIVACY_FILTER_ENABLED = 'false';
      process.env.PRIVACY_DETECT_PII = 'false';
      process.env.PRIVACY_MIN_CONFIDENCE = '0.9';
      process.env.PRIVACY_REDACTION_STRATEGY = 'entity_type';
      process.env.PRIVACY_FAIL_OPEN = 'true';

      req.body = { atlassian_token: 'atlassian-123' };

      axios.get.mockResolvedValue({
        data: { account_id: 'acc-123', email: 'test@example.com' }
      });

      await authController.getOcrConfig(req, res);

      const response = res.json.mock.calls[0][0];
      expect(response.privacy.enabled).toBe(false);
      expect(response.privacy.detect_pii).toBe(false);
      expect(response.privacy.min_confidence).toBe(0.9);
      expect(response.privacy.redaction_strategy).toBe('entity_type');
      expect(response.privacy.fail_open).toBe(true);

      delete process.env.PRIVACY_FILTER_ENABLED;
      delete process.env.PRIVACY_DETECT_PII;
      delete process.env.PRIVACY_MIN_CONFIDENCE;
      delete process.env.PRIVACY_REDACTION_STRATEGY;
      delete process.env.PRIVACY_FAIL_OPEN;
    });

    it('should default PRIVACY_DETECT_PII to true when env var not set', async () => {
      // Ensure it's not set
      delete process.env.PRIVACY_DETECT_PII;

      req.body = { atlassian_token: 'atlassian-123' };

      axios.get.mockResolvedValue({
        data: { account_id: 'acc-123', email: 'test@example.com' }
      });

      await authController.getOcrConfig(req, res);

      const response = res.json.mock.calls[0][0];
      expect(response.privacy.detect_pii).toBe(true);
    });

    it('should parse PRIVACY_MASK_LENGTH as integer', async () => {
      process.env.PRIVACY_MASK_LENGTH = '16';

      req.body = { atlassian_token: 'atlassian-123' };

      axios.get.mockResolvedValue({
        data: { account_id: 'acc-123', email: 'test@example.com' }
      });

      await authController.getOcrConfig(req, res);

      const response = res.json.mock.calls[0][0];
      expect(response.privacy.mask_length).toBe(16);
      expect(typeof response.privacy.mask_length).toBe('number');

      delete process.env.PRIVACY_MASK_LENGTH;
    });

    it('should parse PRIVACY_MIN_CONFIDENCE as float', async () => {
      process.env.PRIVACY_MIN_CONFIDENCE = '0.85';

      req.body = { atlassian_token: 'atlassian-123' };

      axios.get.mockResolvedValue({
        data: { account_id: 'acc-123', email: 'test@example.com' }
      });

      await authController.getOcrConfig(req, res);

      const response = res.json.mock.calls[0][0];
      expect(response.privacy.min_confidence).toBe(0.85);
      expect(typeof response.privacy.min_confidence).toBe('number');

      delete process.env.PRIVACY_MIN_CONFIDENCE;
    });
  });

  describe('verifyToken', () => {
    it('should verify valid Atlassian token', async () => {
      req.body = {
        atlassian_token: 'valid-token'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'acc-123',
          email: 'test@example.com',
          name: 'Test User'
        }
      });

      await authController.verifyToken(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        valid: true,
        user: {
          account_id: 'acc-123',
          email: 'test@example.com',
          name: 'Test User'
        }
      });
    });

    it('should return 400 if atlassian_token is missing', async () => {
      req.body = {};

      await authController.verifyToken(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return valid:false for expired token', async () => {
      req.body = {
        atlassian_token: 'expired-token'
      };

      axios.get.mockRejectedValue({
        response: { status: 401 }
      });

      await authController.verifyToken(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        valid: false,
        error: 'Token expired or invalid'
      });
    });

    it('should handle network errors', async () => {
      req.body = {
        atlassian_token: 'valid-token'
      };

      axios.get.mockRejectedValue(new Error('Network error'));

      await authController.verifyToken(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ===========================================================================
  // Phase 2 — server-side token custody endpoints
  // Plan: plan/2026-06-12_auth_server-side-token-custody.md
  // ===========================================================================

  describe('getDeviceAccessToken (POST /api/auth/access-token)', () => {
    it('returns a fresh access token for a valid device session', async () => {
      req.body = { device_token: 'device-abc' };
      custody.verifyDeviceSession.mockResolvedValue({ sessionId: 's1', userId: 'user-1', organizationId: 'org-1' });
      custody.getAccessTokenForUser.mockResolvedValue({ accessToken: 'fresh-access', expiresAt: '2026-06-12T12:00:00Z' });

      await authController.getDeviceAccessToken(req, res);

      expect(custody.getAccessTokenForUser).toHaveBeenCalledWith('user-1');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        access_token: 'fresh-access',
        expires_at: '2026-06-12T12:00:00Z'
      });
    });

    it('returns 400 when device_token is missing', async () => {
      req.body = {};
      await authController.getDeviceAccessToken(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false })
      );
    });

    it('returns 401 DEVICE_SESSION_INVALID for unknown/revoked/expired device tokens', async () => {
      req.body = { device_token: 'revoked-or-unknown' };
      custody.verifyDeviceSession.mockResolvedValue(null);

      await authController.getDeviceAccessToken(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, errorCode: 'DEVICE_SESSION_INVALID', requiresReauth: true })
      );
      expect(custody.getAccessTokenForUser).not.toHaveBeenCalled();
    });

    it('returns 401 OAUTH_REAUTH_REQUIRED when the stored credential is dead', async () => {
      req.body = { device_token: 'device-abc' };
      custody.verifyDeviceSession.mockResolvedValue({ sessionId: 's1', userId: 'user-1' });
      const dead = new Error('Refresh token is no longer valid — login required');
      dead.code = 'OAUTH_REAUTH_REQUIRED';
      custody.getAccessTokenForUser.mockRejectedValue(dead);

      await authController.getDeviceAccessToken(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, errorCode: 'OAUTH_REAUTH_REQUIRED', requiresReauth: true })
      );
    });

    it('returns 503 OAUTH_TEMPORARY_FAILURE on transient rotation failures', async () => {
      req.body = { device_token: 'device-abc' };
      custody.verifyDeviceSession.mockResolvedValue({ sessionId: 's1', userId: 'user-1' });
      const transient = new Error('Network failure during rotation');
      transient.code = 'OAUTH_TEMPORARY_FAILURE';
      custody.getAccessTokenForUser.mockRejectedValue(transient);

      await authController.getDeviceAccessToken(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, errorCode: 'OAUTH_TEMPORARY_FAILURE' })
      );
    });
  });

  describe('migrateCustody (POST /api/auth/migrate-custody)', () => {
    function mockIdentity() {
      axios.get.mockResolvedValue({
        data: { account_id: 'acc-123', email: 'test@example.com', name: 'Test User' }
      });
      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: { id: 'user-uuid', organization_id: 'org-uuid' },
          error: null
        })
      };
      getClient.mockReturnValue(mockSupabase);
    }

    it('stores the refresh token server-side and issues a device token', async () => {
      req.body = {
        atlassian_token: 'access-123',
        refresh_token: 'refresh-456',
        device_name: 'LAP-001',
        app_version: '1.4.8'
      };
      mockIdentity();
      custody.storeCredential.mockResolvedValue();
      custody.issueDeviceSession.mockResolvedValue({ deviceToken: 'new-device-token', expiresAt: '2026-12-09T00:00:00Z' });

      await authController.migrateCustody(req, res);

      expect(custody.storeCredential).toHaveBeenCalledWith('user-uuid', expect.objectContaining({
        refreshToken: 'refresh-456',
        accessToken: 'access-123'
      }));
      expect(custody.issueDeviceSession).toHaveBeenCalledWith('user-uuid', expect.objectContaining({
        organizationId: 'org-uuid',
        deviceName: 'LAP-001',
        appVersion: '1.4.8'
      }));
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        device_token: 'new-device-token',
        device_token_expires_at: '2026-12-09T00:00:00Z'
      });
    });

    it('returns 400 when refresh_token is missing', async () => {
      req.body = { atlassian_token: 'access-123' };
      await authController.migrateCustody(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 401 when the Atlassian access token is invalid', async () => {
      req.body = { atlassian_token: 'bad-token', refresh_token: 'refresh-456' };
      axios.get.mockRejectedValue({ response: { status: 401 } });

      await authController.migrateCustody(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(custody.storeCredential).not.toHaveBeenCalled();
    });
  });

  describe('revokeDeviceSession (POST /api/auth/device/revoke)', () => {
    it('revokes the device session', async () => {
      req.body = { device_token: 'device-abc' };
      custody.revokeDeviceSession.mockResolvedValue(true);

      await authController.revokeDevice(req, res);

      expect(custody.revokeDeviceSession).toHaveBeenCalledWith('device-abc');
      expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    it('returns 400 when device_token is missing', async () => {
      req.body = {};
      await authController.revokeDevice(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('reports success false when nothing was revoked', async () => {
      req.body = { device_token: 'unknown' };
      custody.revokeDeviceSession.mockResolvedValue(false);

      await authController.revokeDevice(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Device session not found' });
    });
  });
});
