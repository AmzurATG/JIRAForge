/**
 * Tests for ResendAdapter
 */

const ResendAdapter = require('../../../src/services/mail/ResendAdapter');

// Mock resend
jest.mock('resend');
const { Resend } = require('resend');

describe('ResendAdapter', () => {
  let adapter;
  let mockResendClient;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock Resend client
    mockResendClient = {
      emails: {
        send: jest.fn(),
      },
    };
    Resend.mockImplementation(() => mockResendClient);

    process.env.RESEND_API_KEY = 're_test_api_key';
    process.env.MAIL_FROM_ADDRESS = 'test@example.com';
    process.env.MAIL_FROM_NAME = 'Test Sender';
    
    adapter = new ResendAdapter();
  });

  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.MAIL_FROM_ADDRESS;
    delete process.env.MAIL_FROM_NAME;
  });

  describe('Constructor', () => {
    test('should initialize with environment variables', () => {
      expect(adapter.apiKey).toBe('re_test_api_key');
      expect(adapter.defaultFrom).toBe('test@example.com');
      expect(adapter.defaultFromName).toBe('Test Sender');
      expect(Resend).toHaveBeenCalledWith('re_test_api_key');
    });

    test('should accept config overrides', () => {
      const customAdapter = new ResendAdapter({
        apiKey: 're_custom_key',
        defaultFrom: 'custom@example.com',
        defaultFromName: 'Custom Sender',
      });

      expect(customAdapter.apiKey).toBe('re_custom_key');
      expect(customAdapter.defaultFrom).toBe('custom@example.com');
      expect(customAdapter.defaultFromName).toBe('Custom Sender');
    });
  });

  describe('send()', () => {
    test('should send email successfully', async () => {
      mockResendClient.emails.send.mockResolvedValue({ id: 'resend-message-id' });

      const result = await adapter.send({
        to: 'recipient@example.com',
        subject: 'Test Email',
        html: '<p>Test content</p>',
        text: 'Test content',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('resend-message-id');
      expect(result.provider).toBe('Resend');
      expect(mockResendClient.emails.send).toHaveBeenCalledWith({
        from: 'test@example.com',
        to: 'recipient@example.com',
        subject: 'Test Email',
        html: '<p>Test content</p>',
        text: 'Test content',
      });
    });

    test('should format from address with name', async () => {
      mockResendClient.emails.send.mockResolvedValue({ id: 'test-id' });

      await adapter.send({
        to: 'recipient@example.com',
        subject: 'Test Email',
        html: '<p>Test</p>',
        fromName: 'Custom Name',
      });

      expect(mockResendClient.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'Custom Name <test@example.com>',
        })
      );
    });

    test('should use custom from address if provided', async () => {
      mockResendClient.emails.send.mockResolvedValue({ id: 'test-id' });

      await adapter.send({
        to: 'recipient@example.com',
        subject: 'Test Email',
        html: '<p>Test</p>',
        from: 'custom@example.com',
      });

      expect(mockResendClient.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'custom@example.com',
        })
      );
    });

    test('should include reply_to if provided', async () => {
      mockResendClient.emails.send.mockResolvedValue({ id: 'test-id' });

      await adapter.send({
        to: 'recipient@example.com',
        subject: 'Test Email',
        html: '<p>Test</p>',
        replyTo: 'reply@example.com',
      });

      expect(mockResendClient.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          reply_to: 'reply@example.com',
        })
      );
    });

    test('should not include text field if not provided', async () => {
      mockResendClient.emails.send.mockResolvedValue({ id: 'test-id' });

      await adapter.send({
        to: 'recipient@example.com',
        subject: 'Test Email',
        html: '<p>Test</p>',
      });

      const callArgs = mockResendClient.emails.send.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('text');
    });

    test('should handle send failure', async () => {
      mockResendClient.emails.send.mockRejectedValue(new Error('Resend API error'));

      const result = await adapter.send({
        to: 'recipient@example.com',
        subject: 'Test Email',
        html: '<p>Test</p>',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Resend API error');
      expect(result.provider).toBe('Resend');
    });

    test('should fail if not configured', async () => {
      const unconfiguredAdapter = new ResendAdapter({ apiKey: null });

      const result = await unconfiguredAdapter.send({
        to: 'recipient@example.com',
        subject: 'Test Email',
        html: '<p>Test</p>',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });
  });

  describe('sendBatch()', () => {
    test('should send multiple emails', async () => {
      mockResendClient.emails.send.mockResolvedValue({ id: 'test-id' });

      const mailList = [
        { to: 'user1@example.com', subject: 'Email 1', html: '<p>1</p>' },
        { to: 'user2@example.com', subject: 'Email 2', html: '<p>2</p>' },
      ];

      const results = await adapter.sendBatch(mailList);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(mockResendClient.emails.send).toHaveBeenCalledTimes(2);
    });

    test('should handle partial failures in batch', async () => {
      mockResendClient.emails.send
        .mockResolvedValueOnce({ id: 'test-id' })
        .mockRejectedValueOnce(new Error('Failed'));

      const mailList = [
        { to: 'user1@example.com', subject: 'Email 1', html: '<p>1</p>' },
        { to: 'user2@example.com', subject: 'Email 2', html: '<p>2</p>' },
      ];

      const results = await adapter.sendBatch(mailList);

      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
    });
  });

  describe('verifyConnection()', () => {
    test('should verify connection with valid API key', async () => {
      const result = await adapter.verifyConnection();
      expect(result).toBe(true);
    });

    test('should fail verification without API key', async () => {
      const unconfiguredAdapter = new ResendAdapter({ apiKey: null });
      const result = await unconfiguredAdapter.verifyConnection();
      expect(result).toBe(false);
    });

    test('should fail verification with invalid API key format', async () => {
      const invalidAdapter = new ResendAdapter({ apiKey: 'invalid_key' });
      const result = await invalidAdapter.verifyConnection();
      expect(result).toBe(false);
    });
  });

  describe('getProviderName()', () => {
    test('should return provider name', () => {
      expect(adapter.getProviderName()).toBe('Resend');
    });
  });

  describe('isConfigured()', () => {
    test('should return true when API key is set and client exists', () => {
      expect(adapter.isConfigured()).toBe(true);
    });

    test('should return false when API key is missing', () => {
      const unconfiguredAdapter = new ResendAdapter({ apiKey: null });
      expect(unconfiguredAdapter.isConfigured()).toBe(false);
    });
  });
});
