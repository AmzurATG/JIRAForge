/**
 * Tests for MailService (Manager with fallback logic)
 */

const { MailService, resetInstance } = require('../../../src/services/mail/MailService');
const SendGridAdapter = require('../../../src/services/mail/SendGridAdapter');
const ResendAdapter = require('../../../src/services/mail/ResendAdapter');

jest.mock('../../../src/services/mail/SendGridAdapter');
jest.mock('../../../src/services/mail/ResendAdapter');

describe('MailService', () => {
  let mailService;
  let mockSendGridAdapter;
  let mockResendAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    resetInstance();

    // Mock adapters
    mockSendGridAdapter = {
      send: jest.fn(),
      sendBatch: jest.fn(),
      verifyConnection: jest.fn(),
      getProviderName: jest.fn(() => 'SendGrid'),
      isConfigured: jest.fn(() => true),
    };

    mockResendAdapter = {
      send: jest.fn(),
      sendBatch: jest.fn(),
      verifyConnection: jest.fn(),
      getProviderName: jest.fn(() => 'Resend'),
      isConfigured: jest.fn(() => true),
    };

    SendGridAdapter.mockImplementation(() => mockSendGridAdapter);
    ResendAdapter.mockImplementation(() => mockResendAdapter);

    process.env.MAIL_PRIMARY_PROVIDER = 'sendgrid';
    process.env.MAIL_FALLBACK_PROVIDER = 'resend';

    mailService = new MailService();
  });

  afterEach(() => {
    delete process.env.MAIL_PRIMARY_PROVIDER;
    delete process.env.MAIL_FALLBACK_PROVIDER;
  });

  describe('Configuration', () => {
    test('should initialize with environment configuration', () => {
      expect(mailService.config.primaryProvider).toBe('sendgrid');
      expect(mailService.config.fallbackProvider).toBe('resend');
      expect(mailService.config.enableFallback).toBe(true);
    });

    test('should accept config overrides', () => {
      const customService = new MailService({
        primaryProvider: 'resend',
        fallbackProvider: 'sendgrid',
        enableFallback: false,
      });

      expect(customService.config.primaryProvider).toBe('resend');
      expect(customService.config.fallbackProvider).toBe('sendgrid');
      expect(customService.config.enableFallback).toBe(false);
    });

    test('should use defaults if environment not set', () => {
      delete process.env.MAIL_PRIMARY_PROVIDER;
      delete process.env.MAIL_FALLBACK_PROVIDER;

      const defaultService = new MailService();
      expect(defaultService.config.primaryProvider).toBe('sendgrid');
      expect(defaultService.config.fallbackProvider).toBe('resend');
    });
  });

  describe('send() - Basic Functionality', () => {
    test('should send email via primary provider successfully', async () => {
      mockSendGridAdapter.send.mockResolvedValue({
        success: true,
        messageId: 'sg-123',
        provider: 'SendGrid',
      });

      const result = await mailService.send({
        to: 'user@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
      });

      expect(result.success).toBe(true);
      expect(result.provider).toBe('SendGrid');
      expect(mockSendGridAdapter.send).toHaveBeenCalledTimes(1);
      expect(mockResendAdapter.send).not.toHaveBeenCalled();
    });

    test('should validate email options before sending', async () => {
      const invalidOptions = [
        { subject: 'Test', html: '<p>Test</p>' }, // Missing 'to'
        { to: 'user@example.com', html: '<p>Test</p>' }, // Missing 'subject'
        { to: 'user@example.com', subject: 'Test' }, // Missing 'html' or 'text'
        { to: 'invalid-email', subject: 'Test', html: '<p>Test</p>' }, // Invalid email format
      ];

      for (const options of invalidOptions) {
        const result = await mailService.send(options);
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
      }
    });

    test('should accept valid email formats', async () => {
      mockSendGridAdapter.send.mockResolvedValue({
        success: true,
        provider: 'SendGrid',
      });

      const validEmails = [
        'user@example.com',
        'user.name@example.com',
        'user+tag@example.co.uk',
        'user123@sub.example.com',
      ];

      for (const email of validEmails) {
        const result = await mailService.send({
          to: email,
          subject: 'Test',
          html: '<p>Test</p>',
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('send() - Fallback Logic', () => {
    test('should fallback to secondary provider when primary fails', async () => {
      mockSendGridAdapter.send.mockResolvedValue({
        success: false,
        error: 'SendGrid error',
        provider: 'SendGrid',
      });

      mockResendAdapter.send.mockResolvedValue({
        success: true,
        messageId: 'resend-123',
        provider: 'Resend',
      });

      const result = await mailService.send({
        to: 'user@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
      });

      expect(result.success).toBe(true);
      expect(result.provider).toBe('Resend');
      expect(mockSendGridAdapter.send).toHaveBeenCalledTimes(1);
      expect(mockResendAdapter.send).toHaveBeenCalledTimes(1);
    });

    test('should not fallback if fallback is disabled', async () => {
      const noFallbackService = new MailService({ enableFallback: false });

      mockSendGridAdapter.send.mockResolvedValue({
        success: false,
        error: 'SendGrid error',
        provider: 'SendGrid',
      });

      const result = await noFallbackService.send({
        to: 'user@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
      });

      expect(result.success).toBe(false);
      expect(mockResendAdapter.send).not.toHaveBeenCalled();
    });

    test('should fail if both providers fail', async () => {
      mockSendGridAdapter.send.mockResolvedValue({
        success: false,
        error: 'SendGrid error',
        provider: 'SendGrid',
      });

      mockResendAdapter.send.mockResolvedValue({
        success: false,
        error: 'Resend error',
        provider: 'Resend',
      });

      const result = await mailService.send({
        to: 'user@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('All mail providers failed');
      expect(mockSendGridAdapter.send).toHaveBeenCalledTimes(1);
      expect(mockResendAdapter.send).toHaveBeenCalledTimes(1);
    });

    test('should skip unconfigured primary provider', async () => {
      mockSendGridAdapter.isConfigured.mockReturnValue(false);
      mockResendAdapter.send.mockResolvedValue({
        success: true,
        provider: 'Resend',
      });

      const result = await mailService.send({
        to: 'user@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
      });

      expect(result.success).toBe(true);
      expect(result.provider).toBe('Resend');
      expect(mockSendGridAdapter.send).not.toHaveBeenCalled();
      expect(mockResendAdapter.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('send() - Circuit Breaker', () => {
    test('should track provider failures', async () => {
      mockSendGridAdapter.send.mockResolvedValue({
        success: false,
        error: 'Error',
        provider: 'SendGrid',
      });

      mockResendAdapter.send.mockResolvedValue({
        success: true,
        provider: 'Resend',
      });

      // Make 3 failed requests to trip the circuit breaker
      await mailService.send({ to: 'user@example.com', subject: 'Test', html: '<p>1</p>' });
      await mailService.send({ to: 'user@example.com', subject: 'Test', html: '<p>2</p>' });
      await mailService.send({ to: 'user@example.com', subject: 'Test', html: '<p>3</p>' });

      expect(mailService.providerHealth.sendgrid.failures).toBe(3);
    });

    test('should skip unhealthy provider after max failures', async () => {
      mockSendGridAdapter.send.mockResolvedValue({
        success: false,
        error: 'Error',
        provider: 'SendGrid',
      });

      mockResendAdapter.send.mockResolvedValue({
        success: true,
        provider: 'Resend',
      });

      // Trip circuit breaker (3 failures)
      for (let i = 0; i < 3; i++) {
        await mailService.send({ to: 'user@example.com', subject: 'Test', html: '<p>Test</p>' });
      }

      // Reset mock call count
      mockSendGridAdapter.send.mockClear();
      mockResendAdapter.send.mockClear();

      // Next request should skip SendGrid entirely
      const result = await mailService.send({
        to: 'user@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
      });

      expect(result.success).toBe(true);
      expect(result.provider).toBe('Resend');
      expect(mockSendGridAdapter.send).not.toHaveBeenCalled();
      expect(mockResendAdapter.send).toHaveBeenCalledTimes(1);
    });

    test('should reset failure count on successful send', async () => {
      // One failure
      mockSendGridAdapter.send.mockResolvedValueOnce({
        success: false,
        error: 'Error',
        provider: 'SendGrid',
      });

      mockResendAdapter.send.mockResolvedValue({
        success: true,
        provider: 'Resend',
      });

      await mailService.send({ to: 'user@example.com', subject: 'Test', html: '<p>Test</p>' });
      expect(mailService.providerHealth.sendgrid.failures).toBe(1);

      // Success on retry
      mockSendGridAdapter.send.mockResolvedValueOnce({
        success: true,
        provider: 'SendGrid',
      });

      await mailService.send({ to: 'user@example.com', subject: 'Test', html: '<p>Test</p>' });
      expect(mailService.providerHealth.sendgrid.failures).toBe(0);
    });
  });

  describe('sendBatch()', () => {
    test('should send multiple emails', async () => {
      mockSendGridAdapter.send.mockResolvedValue({
        success: true,
        provider: 'SendGrid',
      });

      const mailList = [
        { to: 'user1@example.com', subject: 'Email 1', html: '<p>1</p>' },
        { to: 'user2@example.com', subject: 'Email 2', html: '<p>2</p>' },
      ];

      const results = await mailService.sendBatch(mailList);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(mockSendGridAdapter.send).toHaveBeenCalledTimes(2);
    });

    test('should handle mixed success/failure in batch', async () => {
      mockSendGridAdapter.send
        .mockResolvedValueOnce({ success: true, provider: 'SendGrid' })
        .mockResolvedValueOnce({ success: false, error: 'Error', provider: 'SendGrid' });

      mockResendAdapter.send.mockResolvedValue({ success: true, provider: 'Resend' });

      const mailList = [
        { to: 'user1@example.com', subject: 'Email 1', html: '<p>1</p>' },
        { to: 'user2@example.com', subject: 'Email 2', html: '<p>2</p>' },
      ];

      const results = await mailService.sendBatch(mailList);

      expect(results[0].success).toBe(true);
      expect(results[0].provider).toBe('SendGrid');
      expect(results[1].success).toBe(true);
      expect(results[1].provider).toBe('Resend'); // Fallback worked
    });
  });

  describe('verifyProviders()', () => {
    test('should check all providers status', async () => {
      mockSendGridAdapter.verifyConnection.mockResolvedValue(true);
      mockResendAdapter.verifyConnection.mockResolvedValue(true);

      const status = await mailService.verifyProviders();

      expect(status.primary).toBe('sendgrid');
      expect(status.fallback).toBe('resend');
      expect(status.providers.sendgrid.configured).toBe(true);
      expect(status.providers.sendgrid.healthy).toBe(true);
      expect(status.providers.sendgrid.available).toBe(true);
      expect(status.providers.resend.configured).toBe(true);
      expect(status.providers.resend.healthy).toBe(true);
      expect(status.providers.resend.available).toBe(true);
    });

    test('should detect unconfigured providers', async () => {
      mockSendGridAdapter.isConfigured.mockReturnValue(false);
      mockSendGridAdapter.verifyConnection.mockResolvedValue(false);

      const status = await mailService.verifyProviders();

      expect(status.providers.sendgrid.configured).toBe(false);
      expect(status.providers.sendgrid.available).toBe(false);
    });
  });

  describe('getHealthStatus()', () => {
    test('should return current health status', () => {
      const status = mailService.getHealthStatus();

      expect(status).toHaveProperty('providers');
      expect(status).toHaveProperty('config');
      expect(status.providers).toHaveProperty('sendgrid');
      expect(status.providers).toHaveProperty('resend');
      expect(status.config.primaryProvider).toBe('sendgrid');
    });
  });
});
