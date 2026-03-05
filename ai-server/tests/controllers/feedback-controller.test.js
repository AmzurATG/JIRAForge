/**
 * Feedback Controller Unit Tests
 */

const axios = require('axios');
const sessionStore = require('../../src/services/feedback-session-store');
const { createFeedback, getFeedbackById } = require('../../src/services/db/feedback-db-service');
const { uploadFile } = require('../../src/services/db/storage-service');
const { processAndCreateJiraTicket } = require('../../src/services/feedback-service');
const logger = require('../../src/utils/logger');

// Mock all dependencies
jest.mock('axios');
jest.mock('../../src/services/feedback-session-store');
jest.mock('../../src/services/db/feedback-db-service');
jest.mock('../../src/services/db/storage-service');
jest.mock('../../src/services/feedback-service');
jest.mock('../../src/utils/logger');

// Import controller after mocks
const feedbackController = require('../../src/controllers/feedback-controller');

describe('Feedback Controller', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();

    req = {
      body: {},
      params: {},
      query: {}
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      sendFile: jest.fn().mockReturnThis()
    };
  });

  describe('createSession', () => {
    const mockAtlassianUser = {
      account_id: 'user123',
      email: 'test@example.com',
      name: 'Test User'
    };

    it('should create session with valid Atlassian token', async () => {
      req.body = {
        atlassian_token: 'valid_token',
        cloud_id: 'cloud123'
      };

      axios.get.mockResolvedValue({
        data: mockAtlassianUser
      });

      sessionStore.createSession.mockReturnValue('session123');

      await feedbackController.createSession(req, res);

      expect(axios.get).toHaveBeenCalledWith(
        'https://api.atlassian.com/me',
        expect.objectContaining({
          headers: {
            'Authorization': 'Bearer valid_token',
            'Accept': 'application/json'
          }
        })
      );

      expect(sessionStore.createSession).toHaveBeenCalledWith({
        atlassianToken: 'valid_token',
        cloudId: 'cloud123',
        userInfo: {
          account_id: 'user123',
          email: 'test@example.com',
          name: 'Test User'
        }
      });

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        session_id: 'session123'
      });
    });

    it('should return 400 if atlassian_token is missing', async () => {
      req.body = {
        cloud_id: 'cloud123'
      };

      await feedbackController.createSession(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Atlassian token is required'
      });
    });

    it('should return 400 if cloud_id is missing', async () => {
      req.body = {
        atlassian_token: 'valid_token'
      };

      await feedbackController.createSession(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Cloud ID is required'
      });
    });

    it('should return 401 if Atlassian token is invalid', async () => {
      req.body = {
        atlassian_token: 'invalid_token',
        cloud_id: 'cloud123'
      };

      axios.get.mockRejectedValue({
        response: { status: 401 }
      });

      await feedbackController.createSession(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid or expired Atlassian token'
      });
    });

    it('should handle user with display_name instead of name', async () => {
      req.body = {
        atlassian_token: 'valid_token',
        cloud_id: 'cloud123'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'user123',
          email: 'test@example.com',
          display_name: 'Display Name'
        }
      });

      sessionStore.createSession.mockReturnValue('session123');

      await feedbackController.createSession(req, res);

      expect(sessionStore.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userInfo: expect.objectContaining({
            name: 'Display Name'
          })
        })
      );
    });

    it('should handle Atlassian API errors without response', async () => {
      req.body = {
        atlassian_token: 'token',
        cloud_id: 'cloud123'
      };

      axios.get.mockRejectedValue(new Error('Network error'));

      await feedbackController.createSession(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should handle timeout errors', async () => {
      req.body = {
        atlassian_token: 'token',
        cloud_id: 'cloud123'
      };

      axios.get.mockRejectedValue({ code: 'ETIMEDOUT' });

      await feedbackController.createSession(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('should handle empty atlassian_token string', async () => {
      req.body = {
        atlassian_token: '',
        cloud_id: 'cloud123'
      };

      await feedbackController.createSession(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should handle empty cloud_id string', async () => {
      req.body = {
        atlassian_token: 'token',
        cloud_id: ''
      };

      await feedbackController.createSession(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('submitFeedback', () => {
    const mockSession = {
      userInfo: {
        account_id: 'user123',
        email: 'test@example.com',
        name: 'Test User'
      },
      atlassianToken: 'token',
      cloudId: 'cloud123'
    };

    beforeEach(() => {
      sessionStore.getSession.mockReturnValue(mockSession);
    });

    it('should submit feedback successfully without images', async () => {
      req.body = {
        session_id: 'session123',
        category: 'bug',
        description: 'Test bug report',
        title: 'Test Title'
      };

      createFeedback.mockResolvedValue({
        id: 'feedback123',
        status: 'pending'
      });

      await feedbackController.submitFeedback(req, res);

      expect(sessionStore.getSession).toHaveBeenCalledWith('session123');
      expect(createFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          user_account_id: 'user123',
          category: 'bug',
          description: 'Test bug report',
          title: 'Test Title'
        })
      );

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        feedback_id: 'feedback123'
      });
    });

    it('should submit feedback with images', async () => {
      req.body = {
        session_id: 'session123',
        category: 'feature_request',
        description: 'Add new feature',
        title: 'Feature Request',
        images: [
          {
            data: Buffer.from('test').toString('base64'),
            type: 'image/png'
          }
        ]
      };

      uploadFile.mockResolvedValue({ path: 'user123/123456_0.png' });
      createFeedback.mockResolvedValue({
        id: 'feedback123',
        status: 'pending'
      });

      await feedbackController.submitFeedback(req, res);

      expect(uploadFile).toHaveBeenCalled();
      expect(createFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          image_paths: expect.any(Array)
        })
      );
    });

    it('should return 400 if session_id is missing', async () => {
      req.body = {
        category: 'bug',
        description: 'Test'
      };

      await feedbackController.submitFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Session ID is required'
      });
    });

    it('should return 400 if category is missing', async () => {
      req.body = {
        session_id: 'session123',
        description: 'Test'
      };

      await feedbackController.submitFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Category is required'
      });
    });

    it('should return 400 if description is missing', async () => {
      req.body = {
        session_id: 'session123',
        category: 'bug'
      };

      await feedbackController.submitFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Description is required'
      });
    });

    it('should return 400 if description is empty/whitespace', async () => {
      req.body = {
        session_id: 'session123',
        category: 'bug',
        description: '   '
      };

      await feedbackController.submitFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Description is required'
      });
    });

    it('should return 400 if category is invalid', async () => {
      req.body = {
        session_id: 'session123',
        category: 'invalid_category',
        description: 'Test'
      };

      await feedbackController.submitFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid category'
      });
    });

    it('should return 401 if session is invalid', async () => {
      req.body = {
        session_id: 'invalid_session',
        category: 'bug',
        description: 'Test'
      };

      sessionStore.getSession.mockReturnValue(null);

      await feedbackController.submitFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid or expired session'
      });
    });

    it('should skip invalid images during upload', async () => {
      req.body = {
        session_id: 'session123',
        category: 'bug',
        description: 'Test',
        images: [
          {
            data: Buffer.from('x'.repeat(6 * 1024 * 1024)).toString('base64'), // > 5MB
            type: 'image/png'
          },
          {
            data: Buffer.from('valid').toString('base64'),
            type: 'image/invalid' // Invalid type
          }
        ]
      };

      createFeedback.mockResolvedValue({
        id: 'feedback123',
        status: 'pending'
      });

      await feedbackController.submitFeedback(req, res);

      expect(logger.warn).toHaveBeenCalled();
      expect(createFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          image_paths: []
        })
      );
    });

    it('should limit images to MAX_IMAGES (3)', async () => {
      req.body = {
        session_id: 'session123',
        category: 'bug',
        description: 'Test',
        images: [
          { data: Buffer.from('1').toString('base64'), type: 'image/png' },
          { data: Buffer.from('2').toString('base64'), type: 'image/png' },
          { data: Buffer.from('3').toString('base64'), type: 'image/png' },
          { data: Buffer.from('4').toString('base64'), type: 'image/png' },
          { data: Buffer.from('5').toString('base64'), type: 'image/png' }
        ]
      };

      uploadFile.mockResolvedValue({ path: 'test.png' });
      createFeedback.mockResolvedValue({
        id: 'feedback123',
        status: 'pending'
      });

      await feedbackController.submitFeedback(req, res);

      expect(uploadFile).toHaveBeenCalledTimes(3);
    });

    it('should handle upload errors gracefully', async () => {
      req.body = {
        session_id: 'session123',
        category: 'bug',
        description: 'Test',
        images: [
          { data: Buffer.from('test').toString('base64'), type: 'image/png' }
        ]
      };

      uploadFile.mockRejectedValue(new Error('Upload failed'));
      createFeedback.mockResolvedValue({
        id: 'feedback123',
        status: 'pending'
      });

      await feedbackController.submitFeedback(req, res);

      expect(logger.warn).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        feedback_id: 'feedback123'
      });
    });

    it('should accept all valid categories', async () => {
      const validCategories = ['bug', 'feature_request', 'improvement', 'question', 'other'];

      for (const category of validCategories) {
        jest.clearAllMocks();
        
        req.body = {
          session_id: 'session123',
          category,
          description: 'Test'
        };

        createFeedback.mockResolvedValue({
          id: 'feedback123',
          status: 'pending'
        });

        await feedbackController.submitFeedback(req, res);

        expect(res.json).toHaveBeenCalledWith({
          success: true,
          feedback_id: 'feedback123'
        });
      }
    });

    it('should accept all valid image types', async () => {
      const validTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

      for (const type of validTypes) {
        jest.clearAllMocks();
        
        req.body = {
          session_id: 'session123',
          category: 'bug',
          description: 'Test',
          images: [
            { data: Buffer.from('test').toString('base64'), type }
          ]
        };

        uploadFile.mockResolvedValue({ path: 'test.png' });
        createFeedback.mockResolvedValue({
          id: 'feedback123',
          status: 'pending'
        });

        await feedbackController.submitFeedback(req, res);

        expect(uploadFile).toHaveBeenCalled();
      }
    });

    it('should handle createFeedback database errors', async () => {
      req.body = {
        session_id: 'session123',
        category: 'bug',
        description: 'Test'
      };

      createFeedback.mockRejectedValue(new Error('Database error'));

      await feedbackController.submitFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to submit feedback'
      });
    });

    it('should trigger background Jira processing after feedback creation', async () => {
      req.body = {
        session_id: 'session123',
        category: 'bug',
        description: 'Test'
      };

      createFeedback.mockResolvedValue({
        id: 'feedback123',
        status: 'pending'
      });

      processAndCreateJiraTicket.mockResolvedValue();

      await feedbackController.submitFeedback(req, res);

      expect(processAndCreateJiraTicket).toHaveBeenCalledWith(
        'feedback123',
        'cloud123',
        'token'
      );
    });

    it('should handle Jira processing errors without failing submission', async () => {
      req.body = {
        session_id: 'session123',
        category: 'bug',
        description: 'Test'
      };

      createFeedback.mockResolvedValue({
        id: 'feedback123',
        status: 'pending'
      });

      processAndCreateJiraTicket.mockRejectedValue(new Error('Jira error'));

      await feedbackController.submitFeedback(req, res);

      expect(logger.error).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        feedback_id: 'feedback123'
      });
    });

    it('should handle images without data field', async () => {
      req.body = {
        session_id: 'session123',
        category: 'bug',
        description: 'Test',
        images: [
          { type: 'image/png' } // Missing data field
        ]
      };

      createFeedback.mockResolvedValue({
        id: 'feedback123',
        status: 'pending'
      });

      await feedbackController.submitFeedback(req, res);

      expect(createFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          image_paths: []
        })
      );
    });

    it('should handle images without type field', async () => {
      req.body = {
        session_id: 'session123',
        category: 'bug',
        description: 'Test',
        images: [
          { data: Buffer.from('test').toString('base64') } // Missing type field
        ]
      };

      createFeedback.mockResolvedValue({
        id: 'feedback123',
        status: 'pending'
      });

      await feedbackController.submitFeedback(req, res);

      expect(createFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          image_paths: []
        })
      );
    });

    it('should handle non-array images field', async () => {
      req.body = {
        session_id: 'session123',
        category: 'bug',
        description: 'Test',
        images: 'not-an-array'
      };

      createFeedback.mockResolvedValue({
        id: 'feedback123',
        status: 'pending'
      });

      await feedbackController.submitFeedback(req, res);

      expect(createFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          image_paths: []
        })
      );
    });

    it('should handle optional title field', async () => {
      req.body = {
        session_id: 'session123',
        category: 'improvement',
        description: 'Test improvement'
        // No title provided
      };

      createFeedback.mockResolvedValue({
        id: 'feedback123',
        status: 'pending'
      });

      await feedbackController.submitFeedback(req, res);

      expect(createFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          title: undefined
        })
      );
    });
  });

  describe('getFeedbackStatus', () => {
    it('should return feedback status successfully', async () => {
      req.params.id = 'feedback123';

      getFeedbackById.mockResolvedValue({
        id: 'feedback123',
        status: 'completed',
        jira_ticket_key: 'PROJ-123'
      });

      await feedbackController.getFeedbackStatus(req, res);

      expect(getFeedbackById).toHaveBeenCalledWith('feedback123');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        feedback: {
          id: 'feedback123',
          status: 'completed',
          jira_ticket_key: 'PROJ-123'
        }
      });
    });

    it('should return 404 if feedback not found', async () => {
      req.params.id = 'nonexistent';

      getFeedbackById.mockResolvedValue(null);

      await feedbackController.getFeedbackStatus(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Feedback not found'
      });
    });

    it('should handle database errors', async () => {
      req.params.id = 'feedback123';

      getFeedbackById.mockRejectedValue(new Error('Database error'));

      await feedbackController.getFeedbackStatus(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to retrieve feedback status'
      });
    });
  });

  describe('serveFeedbackForm', () => {
    it('should serve feedback form for valid session', async () => {
      req.query.session = 'session123';

      sessionStore.getSession.mockReturnValue({
        userInfo: { name: 'Test User' }
      });

      await feedbackController.serveFeedbackForm(req, res);

      expect(sessionStore.getSession).toHaveBeenCalledWith('session123');
      expect(res.sendFile).toHaveBeenCalled();
    });

    it('should return 401 for missing session', async () => {
      req.query = {};

      await feedbackController.serveFeedbackForm(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Session ID is required'
      });
    });

    it('should return 401 for invalid session', async () => {
      req.query.session = 'invalid_session';

      sessionStore.getSession.mockReturnValue(null);

      await feedbackController.serveFeedbackForm(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid or expired session'
      });
    });

    it('should return 401 for empty session string', async () => {
      req.query.session = '';

      await feedbackController.serveFeedbackForm(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('getFeedbackPage (covers getErrorPage and escapeHtml with replaceAll)', () => {
    beforeEach(() => {
      res.send = jest.fn().mockReturnThis();
    });

    it('should return error page with 400 when session is missing', () => {
      req.query = {};

      feedbackController.getFeedbackPage(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Session Error'));
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Missing session parameter'));
    });

    it('should return error page with 401 for invalid session', () => {
      req.query.session = 'invalid123';
      sessionStore.getSession.mockReturnValue(null);

      feedbackController.getFeedbackPage(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Session Error'));
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Invalid or expired session'));
    });

    it('should serve feedback form HTML for valid session', () => {
      req.query.session = 'valid123';
      sessionStore.getSession.mockReturnValue({
        userInfo: { account_id: 'user123' }
      });

      feedbackController.getFeedbackPage(req, res);

      expect(res.sendFile).toHaveBeenCalled();
      // Verify path contains feedback-form.html
      const calledPath = res.sendFile.mock.calls[0][0];
      expect(calledPath).toContain('feedback-form.html');
    });

    it('should escape HTML entities in error messages via escapeHtml replaceAll', () => {
      // This test ensures the replaceAll calls in escapeHtml are executed
      // The error page contains the message which goes through escapeHtml
      req.query = {}; // Missing session triggers error page

      feedbackController.getFeedbackPage(req, res);

      // The error page HTML should be properly escaped
      const htmlOutput = res.send.mock.calls[0][0];
      expect(htmlOutput).toContain('&lt;'); // Should NOT contain unescaped <
      expect(htmlOutput).not.toMatch(/<script>/i); // No script injection possible
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle missing req.body gracefully', async () => {
      req.body = null;

      await feedbackController.submitFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should handle concurrent session creation', async () => {
      req.body = {
        atlassian_token: 'token',
        cloud_id: 'cloud123'
      };

      axios.get.mockResolvedValue({
        data: {
          account_id: 'user123',
          email: 'test@example.com',
          name: 'Test User'
        }
      });

      sessionStore.createSession
        .mockReturnValueOnce('session1')
        .mockReturnValueOnce('session2');

      await Promise.all([
        feedbackController.createSession(req, res),
        feedbackController.createSession({ ...req }, { ...res })
      ]);

      expect(sessionStore.createSession).toHaveBeenCalledTimes(2);
    });

    it('should handle very long description', async () => {
      req.body = {
        session_id: 'session123',
        category: 'bug',
        description: 'A'.repeat(10000) // Very long description
      };

      sessionStore.getSession.mockReturnValue({
        userInfo: { account_id: 'user123' },
        atlassianToken: 'token',
        cloudId: 'cloud123'
      });

      createFeedback.mockResolvedValue({
        id: 'feedback123',
        status: 'pending'
      });

      await feedbackController.submitFeedback(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        feedback_id: 'feedback123'
      });
    });

    it('should handle special characters in category', async () => {
      req.body = {
        session_id: 'session123',
        category: 'bug<script>alert(1)</script>',
        description: 'Test'
      };

      await feedbackController.submitFeedback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid category'
      });
    });

    it('should handle image with jpeg extension', async () => {
      req.body = {
        session_id: 'session123',
        category: 'bug',
        description: 'Test',
        images: [
          {
            data: Buffer.from('test').toString('base64'),
            type: 'image/jpeg'
          }
        ]
      };

      sessionStore.getSession.mockReturnValue({
        userInfo: { account_id: 'user123' },
        atlassianToken: 'token',
        cloudId: 'cloud123'
      });

      uploadFile.mockResolvedValue({ path: 'user123/123456_0.jpg' });
      createFeedback.mockResolvedValue({
        id: 'feedback123',
        status: 'pending'
      });

      await feedbackController.submitFeedback(req, res);

      expect(uploadFile).toHaveBeenCalledWith(
        'feedback-images',
        expect.stringContaining('.jpg'),
        expect.any(Buffer),
        expect.any(Object)
      );
    });
  });
});
