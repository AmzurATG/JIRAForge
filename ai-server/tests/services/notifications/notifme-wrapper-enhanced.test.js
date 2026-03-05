/**
 * NotifMe Wrapper Enhanced Unit Tests
 */

const NotifmeSdk = require('notifme-sdk').default;
const logger = require('../../../src/utils/logger');
const { NotifMeWrapperEnhanced } = require('../../../src/services/notifications/notifme-wrapper-enhanced');

// Mock dependencies
jest.mock('notifme-sdk');
jest.mock('../../../src/utils/logger');

describe('NotifMeWrapperEnhanced', () => {
  let wrapper;
  let mockSdk;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset environment variables
    delete process.env.EMAIL_PROVIDERS;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.MAILGUN_API_KEY;
    delete process.env.MAILGUN_DOMAIN;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.SPARKPOST_API_KEY;
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_FROM_NAME;
    delete process.env.EMAIL_MULTI_PROVIDER_STRATEGY;
    
    // Create mock SDK
    mockSdk = {
      send: jest.fn()
    };
    NotifmeSdk.mockImplementation(() => mockSdk);
    
    // Create new instance for each test
    wrapper = new NotifMeWrapperEnhanced();
  });

  describe('Initialization', () => {
    it('should initialize with SendGrid by default', () => {
      process.env.SENDGRID_API_KEY = 'sg-test-key';
      
      wrapper.initialize();
      
      expect(wrapper.initialized).toBe(true);
      expect(wrapper.providers).toEqual(['sendgrid']);
      expect(NotifmeSdk).toHaveBeenCalled();
    });

    it('should initialize with single provider from EMAIL_PROVIDER', () => {
      process.env.EMAIL_PROVIDER = 'mailgun';
      process.env.MAILGUN_API_KEY = 'mg-key';
      process.env.MAILGUN_DOMAIN = 'test.com';
      
      wrapper.initialize();
      
      expect(wrapper.providers).toEqual(['mailgun']);
    });

    it('should initialize with multiple providers from EMAIL_PROVIDERS', () => {
      process.env.EMAIL_PROVIDERS = 'sendgrid,mailgun,smtp';
      process.env.SENDGRID_API_KEY = 'sg-key';
      process.env.MAILGUN_API_KEY = 'mg-key';
      process.env.MAILGUN_DOMAIN = 'test.com';
      process.env.SMTP_HOST = 'smtp.test.com';
      process.env.SMTP_PORT = '587';
      
      wrapper.initialize();
      
      expect(wrapper.providers).toEqual(['sendgrid', 'mailgun', 'smtp']);
    });

    it('should skip already initialized wrapper', () => {
      process.env.SENDGRID_API_KEY = 'sg-key';
      
      wrapper.initialize();
      const firstSdk = wrapper.sdk;
      
      wrapper.initialize();
      
      expect(wrapper.sdk).toBe(firstSdk);
      expect(NotifmeSdk).toHaveBeenCalledTimes(1);
    });

    it('should throw error if no valid providers configured', () => {
      expect(() => wrapper.initialize()).toThrow('No valid email providers configured');
    });

    it('should log warning for skipped providers', () => {
      process.env.EMAIL_PROVIDERS = 'sendgrid,mailgun';
      process.env.SENDGRID_API_KEY = 'sg-key';
      // mailgun credentials missing
      
      wrapper.initialize();
      
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipped providers')
      );
    });

    it('should sort providers by priority', () => {
      process.env.EMAIL_PROVIDERS = 'sendgrid,mailgun,smtp';
      process.env.SENDGRID_API_KEY = 'sg-key';
      process.env.SENDGRID_PRIORITY = '50';
      process.env.MAILGUN_API_KEY = 'mg-key';
      process.env.MAILGUN_DOMAIN = 'test.com';
      process.env.MAILGUN_PRIORITY = '1';
      process.env.SMTP_HOST = 'smtp.test.com';
      process.env.SMTP_PORT = '587';
      process.env.SMTP_PRIORITY = '99';
      
      wrapper.initialize();
      
      const config = NotifmeSdk.mock.calls[0][0];
      expect(config.channels.email.providers[0].type).toBe('mailgun');
      expect(config.channels.email.providers[1].type).toBe('sendgrid');
      expect(config.channels.email.providers[2].type).toBe('smtp');
    });

    it('should use fallback strategy by default', () => {
      process.env.SENDGRID_API_KEY = 'sg-key';
      
      wrapper.initialize();
      
      const config = NotifmeSdk.mock.calls[0][0];
      expect(config.channels.email.multiProviderStrategy).toBe('fallback');
    });

    it('should use custom multi-provider strategy', () => {
      process.env.SENDGRID_API_KEY = 'sg-key';
      process.env.EMAIL_MULTI_PROVIDER_STRATEGY = 'roundrobin';
      
      wrapper.initialize();
      
      const config = NotifmeSdk.mock.calls[0][0];
      expect(config.channels.email.multiProviderStrategy).toBe('roundrobin');
    });
  });

  describe('Provider Configuration', () => {
    describe('SendGrid', () => {
      it('should build SendGrid config with API key', () => {
        process.env.SENDGRID_API_KEY = 'sg-test-key';
        
        const config = wrapper._buildSendGridConfig();
        
        expect(config).toEqual({
          type: 'sendgrid',
          apiKey: 'sg-test-key'
        });
      });

      it('should return null if API key missing', () => {
        const config = wrapper._buildSendGridConfig();
        expect(config).toBeNull();
      });
    });

    describe('Mailgun', () => {
      it('should build Mailgun config with credentials', () => {
        process.env.MAILGUN_API_KEY = 'mg-test-key';
        process.env.MAILGUN_DOMAIN = 'test.mailgun.org';
        
        const config = wrapper._buildMailgunConfig();
        
        expect(config).toEqual({
          type: 'mailgun',
          apiKey: 'mg-test-key',
          domainName: 'test.mailgun.org'
        });
      });

      it('should return null if API key missing', () => {
        process.env.MAILGUN_DOMAIN = 'test.com';
        const config = wrapper._buildMailgunConfig();
        expect(config).toBeNull();
      });

      it('should return null if domain missing', () => {
        process.env.MAILGUN_API_KEY = 'mg-key';
        const config = wrapper._buildMailgunConfig();
        expect(config).toBeNull();
      });
    });

    describe('SMTP', () => {
      it('should build SMTP config with all options', () => {
        process.env.SMTP_HOST = 'smtp.test.com';
        process.env.SMTP_PORT = '587';
        process.env.SMTP_SECURE = 'true';
        process.env.SMTP_USER = 'user@test.com';
        process.env.SMTP_PASSWORD = 'password123';
        
        const config = wrapper._buildSmtpConfig();
        
        expect(config).toEqual({
          type: 'smtp',
          host: 'smtp.test.com',
          port: 587,
          secure: true,
          auth: {
            user: 'user@test.com',
            pass: 'password123'
          }
        });
      });

      it('should use default port 587', () => {
        process.env.SMTP_HOST = 'smtp.test.com';
        
        const config = wrapper._buildSmtpConfig();
        
        expect(config.port).toBe(587);
      });

      it('should parse secure as false by default', () => {
        process.env.SMTP_HOST = 'smtp.test.com';
        process.env.SMTP_PORT = '25';
        
        const config = wrapper._buildSmtpConfig();
        
        expect(config.secure).toBe(false);
      });

      it('should return null if host missing', () => {
        process.env.SMTP_PORT = '587';
        const config = wrapper._buildSmtpConfig();
        expect(config).toBeNull();
      });
    });

    describe('AWS SES', () => {
      it('should build SES config with credentials', () => {
        process.env.AWS_ACCESS_KEY_ID = 'aws-key-id';
        process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
        process.env.AWS_SES_REGION = 'us-west-2';
        
        const config = wrapper._buildSesConfig();
        
        expect(config).toEqual({
          type: 'ses',
          region: 'us-west-2',
          accessKeyId: 'aws-key-id',
          secretAccessKey: 'aws-secret'
        });
      });

      it('should use default region us-east-1', () => {
        process.env.AWS_ACCESS_KEY_ID = 'aws-key-id';
        process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
        
        const config = wrapper._buildSesConfig();
        
        expect(config.region).toBe('us-east-1');
      });

      it('should fallback to AWS_REGION', () => {
        process.env.AWS_ACCESS_KEY_ID = 'aws-key-id';
        process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
        process.env.AWS_REGION = 'eu-west-1';
        
        const config = wrapper._buildSesConfig();
        
        expect(config.region).toBe('eu-west-1');
      });

      it('should include session token if provided', () => {
        process.env.AWS_ACCESS_KEY_ID = 'aws-key-id';
        process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
        process.env.AWS_SESSION_TOKEN = 'session-token';
        
        const config = wrapper._buildSesConfig();
        
        expect(config.sessionToken).toBe('session-token');
      });

      it('should return null if credentials missing', () => {
        process.env.AWS_ACCESS_KEY_ID = 'aws-key-id';
        const config = wrapper._buildSesConfig();
        expect(config).toBeNull();
      });
    });

    describe('SparkPost', () => {
      it('should build SparkPost config with API key', () => {
        process.env.SPARKPOST_API_KEY = 'sp-test-key';
        
        const config = wrapper._buildSparkPostConfig();
        
        expect(config).toEqual({
          type: 'sparkpost',
          apiKey: 'sp-test-key'
        });
      });

      it('should return null if API key missing', () => {
        const config = wrapper._buildSparkPostConfig();
        expect(config).toBeNull();
      });
    });

    it('should add priority to config if specified', () => {
      process.env.SENDGRID_API_KEY = 'sg-key';
      process.env.SENDGRID_PRIORITY = '10';
      
      const config = wrapper._getProviderConfig('sendgrid');
      
      expect(config.priority).toBe(10);
    });

    it('should return null for unknown provider', () => {
      const config = wrapper._getProviderConfig('unknown');
      expect(config).toBeNull();
    });
  });

  describe('Sending Emails', () => {
    beforeEach(() => {
      process.env.SENDGRID_API_KEY = 'sg-key';
      process.env.EMAIL_FROM = 'noreply@test.com';
      process.env.EMAIL_FROM_NAME = 'Test App';
    });

    it('should send email successfully', async () => {
      mockSdk.send.mockResolvedValue({
        status: 'success',
        channels: {
          email: {
            id: 'msg-123',
            provider: 'sendgrid'
          }
        }
      });
      
      const result = await wrapper.send({
        to: 'user@test.com',
        subject: 'Test Subject',
        text: 'Test body'
      });
      
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-123');
      expect(result.provider).toBe('sendgrid');
      expect(mockSdk.send).toHaveBeenCalledWith({
        email: expect.objectContaining({
          to: 'user@test.com',
          subject: 'Test Subject',
          text: 'Test body'
        })
      });
    });

    it('should initialize if not already initialized', async () => {
      mockSdk.send.mockResolvedValue({
        status: 'success',
        channels: { email: { id: 'msg-123' } }
      });
      
      await wrapper.send({
        to: 'user@test.com',
        subject: 'Test',
        text: 'Test'
      });
      
      expect(wrapper.initialized).toBe(true);
    });

    it('should use custom from email and name', async () => {
      mockSdk.send.mockResolvedValue({
        status: 'success',
        channels: { email: { id: 'msg-123' } }
      });
      
      await wrapper.send({
        to: 'user@test.com',
        from: 'custom@test.com',
        fromName: 'Custom Name',
        subject: 'Test',
        text: 'Test'
      });
      
      expect(mockSdk.send).toHaveBeenCalledWith({
        email: expect.objectContaining({
          from: 'Custom Name <custom@test.com>'
        })
      });
    });

    it('should convert text to HTML if html not provided', async () => {
      mockSdk.send.mockResolvedValue({
        status: 'success',
        channels: { email: { id: 'msg-123' } }
      });
      
      await wrapper.send({
        to: 'user@test.com',
        subject: 'Test',
        text: 'Line 1\n\nLine 2'
      });
      
      const emailPayload = mockSdk.send.mock.calls[0][0].email;
      expect(emailPayload.html).toContain('<p>');
      expect(emailPayload.html).toContain('Line 1</p>');
    });

    it('should use provided HTML', async () => {
      mockSdk.send.mockResolvedValue({
        status: 'success',
        channels: { email: { id: 'msg-123' } }
      });
      
      await wrapper.send({
        to: 'user@test.com',
        subject: 'Test',
        text: 'Text',
        html: '<h1>Custom HTML</h1>'
      });
      
      const emailPayload = mockSdk.send.mock.calls[0][0].email;
      expect(emailPayload.html).toBe('<h1>Custom HTML</h1>');
    });

    it('should include CC recipients as array', async () => {
      mockSdk.send.mockResolvedValue({
        status: 'success',
        channels: { email: { id: 'msg-123' } }
      });
      
      await wrapper.send({
        to: 'user@test.com',
        subject: 'Test',
        text: 'Test',
        cc: ['cc1@test.com', 'cc2@test.com']
      });
      
      const emailPayload = mockSdk.send.mock.calls[0][0].email;
      expect(emailPayload.cc).toEqual(['cc1@test.com', 'cc2@test.com']);
    });

    it('should convert single CC to array', async () => {
      mockSdk.send.mockResolvedValue({
        status: 'success',
        channels: { email: { id: 'msg-123' } }
      });
      
      await wrapper.send({
        to: 'user@test.com',
        subject: 'Test',
        text: 'Test',
        cc: 'cc@test.com'
      });
      
      const emailPayload = mockSdk.send.mock.calls[0][0].email;
      expect(emailPayload.cc).toEqual(['cc@test.com']);
    });

    it('should include BCC recipients', async () => {
      mockSdk.send.mockResolvedValue({
        status: 'success',
        channels: { email: { id: 'msg-123' } }
      });
      
      await wrapper.send({
        to: 'user@test.com',
        subject: 'Test',
        text: 'Test',
        bcc: 'bcc@test.com'
      });
      
      const emailPayload = mockSdk.send.mock.calls[0][0].email;
      expect(emailPayload.bcc).toEqual(['bcc@test.com']);
    });

    it('should handle send failures', async () => {
      mockSdk.send.mockResolvedValue({
        status: 'error',
        info: {
          error: 'Send failed'
        }
      });
      
      const result = await wrapper.send({
        to: 'user@test.com',
        subject: 'Test',
        text: 'Test'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Send failed');
    });

    it('should handle exceptions', async () => {
      mockSdk.send.mockRejectedValue(new Error('Network error'));
      
      const result = await wrapper.send({
        to: 'user@test.com',
        subject: 'Test',
        text: 'Test'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('should use first provider if provider not in response', async () => {
      mockSdk.send.mockResolvedValue({
        status: 'success',
        channels: {
          email: { id: 'msg-123' }
        }
      });
      
      wrapper.initialize();
      const result = await wrapper.send({
        to: 'user@test.com',
        subject: 'Test',
        text: 'Test'
      });
      
      expect(result.provider).toBe('sendgrid');
    });
  });

  describe('Text to HTML Conversion', () => {
    it('should convert empty string to empty string', () => {
      const html = wrapper._textToBasicHtml('');
      expect(html).toBe('');
    });

    it('should convert null to empty string', () => {
      const html = wrapper._textToBasicHtml(null);
      expect(html).toBe('');
    });

    it('should wrap single line in paragraph', () => {
      const html = wrapper._textToBasicHtml('Hello world');
      expect(html).toBe('<p>Hello world</p>');
    });

    it('should convert newlines to br tags', () => {
      const html = wrapper._textToBasicHtml('Line 1\nLine 2');
      expect(html).toContain('<br>');
    });

    it('should create separate paragraphs for double newlines', () => {
      const html = wrapper._textToBasicHtml('Para 1\n\nPara 2');
      expect(html).toBe('<p>Para 1</p><p>Para 2</p>');
    });

    it('should handle mixed newlines', () => {
      const html = wrapper._textToBasicHtml('Line 1\nLine 2\n\nPara 2');
      expect(html).toBe('<p>Line 1<br>Line 2</p><p>Para 2</p>');
    });
  });

  describe('Status', () => {
    it('should return status with default values', () => {
      const status = wrapper.getStatus();
      
      expect(status).toEqual({
        initialized: false,
        providers: [],
        multiProviderStrategy: 'fallback',
        fromEmail: 'noreply@jiraforge.io',
        fromName: 'JIRAForge'
      });
    });

    it('should return status with custom values', () => {
      process.env.SENDGRID_API_KEY = 'sg-key';
      process.env.EMAIL_FROM = 'custom@test.com';
      process.env.EMAIL_FROM_NAME = 'Custom';
      process.env.EMAIL_MULTI_PROVIDER_STRATEGY = 'roundrobin';
      
      wrapper.initialize();
      const status = wrapper.getStatus();
      
      expect(status).toEqual({
        initialized: true,
        providers: ['sendgrid'],
        multiProviderStrategy: 'roundrobin',
        fromEmail: 'custom@test.com',
        fromName: 'Custom'
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle trimmed provider names from env', () => {
      process.env.EMAIL_PROVIDERS = ' sendgrid , mailgun ';
      process.env.SENDGRID_API_KEY = 'sg-key';
      process.env.MAILGUN_API_KEY = 'mg-key';
      process.env.MAILGUN_DOMAIN = 'test.com';
      
      wrapper.initialize();
      
      expect(wrapper.providers).toEqual(['sendgrid', 'mailgun']);
    });

    it('should handle uppercase provider names', () => {
      process.env.EMAIL_PROVIDERS = 'SENDGRID';
      process.env.SENDGRID_API_KEY = 'sg-key';
      
      wrapper.initialize();
      
      expect(wrapper.providers).toEqual(['sendgrid']);
    });

    it('should handle providers without priority gracefully', () => {
      process.env.EMAIL_PROVIDERS = 'sendgrid,mailgun';
      process.env.SENDGRID_API_KEY = 'sg-key';
      process.env.MAILGUN_API_KEY = 'mg-key';
      process.env.MAILGUN_DOMAIN = 'test.com';
      process.env.SENDGRID_PRIORITY = '10';
      // mailgun has no priority
      
      wrapper.initialize();
      
      const config = NotifmeSdk.mock.calls[0][0];
      expect(config.channels.email.providers.length).toBe(2);
    });

    it('should use default from values if env not set', async () => {
      delete process.env.EMAIL_FROM;
      delete process.env.EMAIL_FROM_NAME;
      process.env.SENDGRID_API_KEY = 'sg-key';
      
      mockSdk.send.mockResolvedValue({
        status: 'success',
        channels: { email: { id: 'msg-123' } }
      });
      
      await wrapper.send({
        to: 'user@test.com',
        subject: 'Test',
        text: 'Test'
      });
      
      const emailPayload = mockSdk.send.mock.calls[0][0].email;
      expect(emailPayload.from).toContain('JIRAForge');
      expect(emailPayload.from).toContain('noreply@jiraforge.io');
    });

    it('should handle SMTP without SMTP_PORT env returning null', () => {
      process.env.SMTP_HOST = 'smtp.test.com';
      delete process.env.SMTP_PORT;
      
      const config = wrapper._buildSmtpConfig();
      expect(config).toBeNull();
    });

    it('should handle AWS_REGION fallback before default', () => {
      process.env.AWS_ACCESS_KEY_ID = 'key';
      process.env.AWS_SECRET_ACCESS_KEY = 'secret';
      delete process.env.AWS_SES_REGION;
      process.env.AWS_REGION = 'ap-southeast-1';
      
      const config = wrapper._buildSesConfig();
      expect(config.region).toBe('ap-southeast-1');
      
      delete process.env.AWS_REGION;
    });

    it('should directly test _getProviderConfig returns null for unknown', () => {
      const config = wrapper._getProviderConfig('nonexistent_provider');
      expect(config).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Unknown email provider'));
    });

    it('should handle class field initialization correctly', () => {
      const freshWrapper = new NotifMeWrapperEnhanced();
      expect(freshWrapper.sdk).toBeNull();
      expect(freshWrapper.providers).toEqual([]);
      expect(freshWrapper.initialized).toBe(false);
    });

    it('should handle provider config builder returning null', () => {
      // No env vars set - all builders should return null
      const sendgrid = wrapper._buildSendGridConfig();
      const mailgun = wrapper._buildMailgunConfig();
      const smtp = wrapper._buildSmtpConfig();
      const ses = wrapper._buildSesConfig();
      const sparkpost = wrapper._buildSparkPostConfig();
      
      expect(sendgrid).toBeNull();
      expect(mailgun).toBeNull();
      expect(smtp).toBeNull();
      expect(ses).toBeNull();
      expect(sparkpost).toBeNull();
    });

    it('should correctly parse priority from environment variable', () => {
      process.env.SENDGRID_API_KEY = 'sg-key';
      process.env.SENDGRID_PRIORITY = '25';
      
      const config = wrapper._getProviderConfig('sendgrid');
      expect(config.priority).toBe(25);
    });

    it('should handle _textToBasicHtml with undefined', () => {
      const result = wrapper._textToBasicHtml(undefined);
      expect(result).toBe('');
    });

    it('should return chained instance from initialize', () => {
      process.env.SENDGRID_API_KEY = 'sg-key';
      
      const result = wrapper.initialize();
      expect(result).toBe(wrapper);
    });
  });
});
