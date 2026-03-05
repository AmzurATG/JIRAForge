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
        requiresReauth: true
      });
    });

    it('should handle 400 status as expired token', async () => {
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
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          requiresReauth: true
        })
      );
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
          organization_id: 'org-uuid'
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
        supabase_anon_key: 'anon-key-123',
        supabase_service_role_key: 'service-key-123'
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

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        config: expect.objectContaining({
          primary_engine: 'paddle',
          fallback_engines: ['tesseract']
        })
      });
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

      expect(res.json).toHaveBeenCalledWith({
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
      });

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

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        config: expect.objectContaining({
          preprocessing_target_dpi: 600
        })
      });

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

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        config: expect.objectContaining({
          engines: expect.objectContaining({
            paddle: expect.objectContaining({
              min_confidence: 0.85
            })
          })
        })
      });
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

      // Mock Object.keys to throw an error
      const originalKeys = Object.keys;
      let callCount = 0;
      Object.keys = jest.fn().mockImplementation((obj) => {
        callCount++;
        if (callCount > 1) {
          throw new Error('Internal error');
        }
        return originalKeys(obj);
      });

      await authController.getOcrConfig(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Internal error')
      });

      Object.keys = originalKeys;
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
});
