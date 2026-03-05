/**
 * Atlassian Auth Middleware Unit Tests
 */

const axios = require('axios');
const logger = require('../../src/utils/logger');

// Mock dependencies
jest.mock('axios');
jest.mock('../../src/utils/logger');

// Import middleware after mocks
const atlassianAuth = require('../../src/middleware/atlassian-auth');

describe('Atlassian Auth Middleware', () => {
  let req, res, next;

  beforeEach(() => {
    jest.clearAllMocks();

    req = {
      headers: {}
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };

    next = jest.fn();
  });

  describe('Authorization header validation', () => {
    it('should return 401 when authorization header is missing', async () => {
      await atlassianAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Authorization header missing'
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when authorization type is not Bearer', async () => {
      req.headers.authorization = 'Basic abc123';

      await atlassianAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid authorization format. Use: Bearer <atlassian_token>'
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when token is missing after Bearer', async () => {
      req.headers.authorization = 'Bearer ';

      await atlassianAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid authorization format. Use: Bearer <atlassian_token>'
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when authorization header is just Bearer with no space', async () => {
      req.headers.authorization = 'Bearer';

      await atlassianAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid authorization format. Use: Bearer <atlassian_token>'
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Token verification', () => {
    const validToken = 'valid-atlassian-token';
    const mockUserData = {
      account_id: 'user-123',
      email: 'test@example.com',
      name: 'Test User'
    };

    it('should call next() when token is valid', async () => {
      req.headers.authorization = `Bearer ${validToken}`;
      axios.get.mockResolvedValue({ data: mockUserData });

      await atlassianAuth(req, res, next);

      expect(axios.get).toHaveBeenCalledWith('https://api.atlassian.com/me', {
        headers: {
          'Authorization': `Bearer ${validToken}`,
          'Accept': 'application/json'
        },
        timeout: 10000
      });
      expect(req.atlassianUser).toEqual(mockUserData);
      expect(logger.debug).toHaveBeenCalledWith(
        '[AtlassianAuth] Token verified for user:',
        mockUserData.account_id
      );
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should return 401 when Atlassian API returns 401', async () => {
      req.headers.authorization = `Bearer ${validToken}`;
      axios.get.mockRejectedValue({
        response: { status: 401 }
      });

      await atlassianAuth(req, res, next);

      expect(logger.warn).toHaveBeenCalledWith(
        '[AtlassianAuth] Invalid Atlassian token:',
        401
      );
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid or expired Atlassian token'
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when Atlassian API returns 403', async () => {
      req.headers.authorization = `Bearer ${validToken}`;
      axios.get.mockRejectedValue({
        response: { status: 403 }
      });

      await atlassianAuth(req, res, next);

      expect(logger.warn).toHaveBeenCalledWith(
        '[AtlassianAuth] Invalid Atlassian token:',
        403
      );
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid or expired Atlassian token'
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when network error occurs', async () => {
      req.headers.authorization = `Bearer ${validToken}`;
      axios.get.mockRejectedValue(new Error('Network Error'));

      await atlassianAuth(req, res, next);

      expect(logger.warn).toHaveBeenCalledWith(
        '[AtlassianAuth] Invalid Atlassian token:',
        'Network Error'
      );
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid or expired Atlassian token'
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when request times out', async () => {
      req.headers.authorization = `Bearer ${validToken}`;
      const timeoutError = new Error('timeout of 10000ms exceeded');
      timeoutError.code = 'ECONNABORTED';
      axios.get.mockRejectedValue(timeoutError);

      await atlassianAuth(req, res, next);

      expect(logger.warn).toHaveBeenCalledWith(
        '[AtlassianAuth] Invalid Atlassian token:',
        'timeout of 10000ms exceeded'
      );
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid or expired Atlassian token'
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Unexpected errors', () => {
    it('should return 500 when an unexpected error occurs', async () => {
      // Simulate an unexpected error by making headers.authorization throw
      req = {
        get headers() {
          throw new Error('Unexpected error');
        }
      };

      await atlassianAuth(req, res, next);

      expect(logger.error).toHaveBeenCalledWith(
        '[AtlassianAuth] Middleware error:',
        expect.any(Error)
      );
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Authentication failed'
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Edge cases', () => {
    it('should handle token with spaces after Bearer correctly', async () => {
      const validToken = 'valid-token-123';
      req.headers.authorization = `Bearer ${validToken}`;
      axios.get.mockResolvedValue({ 
        data: { account_id: 'user-123' } 
      });

      await atlassianAuth(req, res, next);

      expect(axios.get).toHaveBeenCalledWith(
        'https://api.atlassian.com/me',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': `Bearer ${validToken}`
          })
        })
      );
      expect(next).toHaveBeenCalled();
    });

    it('should handle error response without status property', async () => {
      req.headers.authorization = 'Bearer some-token';
      const errorWithoutStatus = new Error('Connection refused');
      // No response property at all
      axios.get.mockRejectedValue(errorWithoutStatus);

      await atlassianAuth(req, res, next);

      expect(logger.warn).toHaveBeenCalledWith(
        '[AtlassianAuth] Invalid Atlassian token:',
        'Connection refused'
      );
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});
