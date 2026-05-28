/**
 * Tests for SendGridAdapter
 */

const SendGridAdapter = require('../../../src/services/mail/SendGridAdapter');

// Mock @sendgrid/mail
jest.mock('@sendgrid/mail');
const sgMail = require('@sendgrid/mail');

describe('SendGridAdapter', () => {
  let adapter;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SENDGRID_API_KEY = 'SG.test_api_key';
    process.env.MAIL_FROM_ADDRESS = 'test@example.com';
    process.env.MAIL_FROM_NAME = 'Test Sender';
    adapter = new SendGridAdapter();
  });

  afterEach(() => {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.MAIL_FROM_ADDRESS;
    delete process.env.MAIL_FROM_NAME;
  });

  describe('Constructor', () => {
    test('should initialize with environment variables', () => {
      expect(adapter.apiKey).toBe('SG.test_api_key');
      expect(adapter.defaultFrom).toBe('test@example.com');
      expect(adapter.defaultFromName).toBe('Test Sender');
    });

    test('should accept config overrides', () => {
      const customAdapter = new SendGridAdapter({
        apiKey: 'SG.custom_key',
        defaultFrom: 'custom@example.com',
        defaultFromName: 'Custom Sender',
      });

      expect(customAdapter.apiKey).toBe('SG.custom_key');
      expect(customAdapter.defaultFrom).toBe('custom@example.com');
      expect(customAdapter.defaultFromName).toBe('Custom Sender');
    });

    test('should set SendGrid API key on initialization', () => {
      expect(sgMail.setApiKey).toHaveBeenCalledWith('SG.test_api_key');
    });
  });

  describe('send()', () => {
    test('should send email successfully', async () => {
      sgMail.send.mockResolvedValue([{ headers: { 'x-message-id': 'test-message-id' } }]);

      const result = await adapter.send({
        to: 'recipient@example.com',
        subject: 'Test Email',
        html: '<p>Test content</p>',
        text: 'Test content',
      });

      expect(result.success).toBe(true);
      expect(result.provider).toBe('SendGrid');
      expect(sgMail.send).toHaveBeenCalledWith({
        to: 'recipient@example.com',
        from: {
          email: 'test@example.com',
          name: 'Test Sender',
        },
        subject: 'Test Email',
        html: '<p>Test content</p>',
        text: 'Test content',
      });
    });

    test('should use custom from address if provided', async () => {
      sgMail.send.mockResolvedValue([{ headers: {} }]);

      await adapter.send({
        to: 'recipient@example.com',
        subject: 'Test Email',
        html: '<p>Test</p>',
        from: 'custom@example.com',
        fromName: 'Custom Name',
      });

      expect(sgMail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          from: {
            email: 'custom@example.com',
            name: 'Custom Name',
          },
        })
      );
    });

    test('should include replyTo if provided', async () => {
      sgMail.send.mockResolvedValue([{ headers: {} }]);

      await adapter.send({
        to: 'recipient@example.com',
        subject: 'Test Email',
        html: '<p>Test</p>',
        replyTo: 'reply@example.com',
      });

      expect(sgMail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          replyTo: 'reply@example.com',
        })
      );
    });

    test('should handle send failure', async () => {
      sgMail.send.mockRejectedValue(new Error('SendGrid API error'));

      const result = await adapter.send({
        to: 'recipient@example.com',
        subject: 'Test Email',
        html: '<p>Test</p>',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('SendGrid API error');
      expect(result.provider).toBe('SendGrid');
    });

    test('should fail if not configured', async () => {
      const unconfiguredAdapter = new SendGridAdapter({ apiKey: null });

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
      sgMail.send.mockResolvedValue([{ headers: {} }]);

      const mailList = [
        { to: 'user1@example.com', subject: 'Email 1', html: '<p>1</p>' },
        { to: 'user2@example.com', subject: 'Email 2', html: '<p>2</p>' },
      ];

      const results = await adapter.sendBatch(mailList);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(sgMail.send).toHaveBeenCalledTimes(2);
    });

    test('should handle partial failures in batch', async () => {
      sgMail.send
        .mockResolvedValueOnce([{ headers: {} }])
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
      const unconfiguredAdapter = new SendGridAdapter({ apiKey: null });
      const result = await unconfiguredAdapter.verifyConnection();
      expect(result).toBe(false);
    });

    test('should fail verification with invalid API key format', async () => {
      const invalidAdapter = new SendGridAdapter({ apiKey: 'invalid_key' });
      const result = await invalidAdapter.verifyConnection();
      expect(result).toBe(false);
    });
  });

  describe('getProviderName()', () => {
    test('should return provider name', () => {
      expect(adapter.getProviderName()).toBe('SendGrid');
    });
  });

  describe('isConfigured()', () => {
    test('should return true when API key is set', () => {
      expect(adapter.isConfigured()).toBe(true);
    });

    test('should return false when API key is missing', () => {
      const unconfiguredAdapter = new SendGridAdapter({ apiKey: null });
      expect(unconfiguredAdapter.isConfigured()).toBe(false);
    });
  });
});
