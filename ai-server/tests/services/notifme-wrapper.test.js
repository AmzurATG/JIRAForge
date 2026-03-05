'use strict';

// ---------------------------------------------------------------------------
// Mock notifme-sdk and logger — required before requiring the module
// ---------------------------------------------------------------------------

jest.mock('notifme-sdk', () => {
  const send = jest.fn().mockResolvedValue({ status: 'success', id: 'msg-1' });
  const NotifmeSdkMock = jest.fn().mockImplementation(() => ({ send }));
  NotifmeSdkMock._send = send;
  return { default: NotifmeSdkMock };
});

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Import the wrapper AFTER mocks are set
// ---------------------------------------------------------------------------

const { NotifMeWrapper } = require('../../src/services/notifications/notifme-wrapper');
const NotifmeSdk = require('notifme-sdk').default;
const logger = require('../../src/utils/logger');

// ---------------------------------------------------------------------------
// _textToBasicHtml — the changed method
// ---------------------------------------------------------------------------

describe('NotifMeWrapper#_textToBasicHtml', () => {
  let wrapper;

  beforeEach(() => {
    wrapper = new NotifMeWrapper();
  });

  it('returns an empty string for falsy input (empty string)', () => {
    expect(wrapper._textToBasicHtml('')).toBe('');
  });

  it('returns an empty string for null input', () => {
    expect(wrapper._textToBasicHtml(null)).toBe('');
  });

  it('returns an empty string for undefined input', () => {
    expect(wrapper._textToBasicHtml(undefined)).toBe('');
  });

  it('wraps plain text in a div with inline styles', () => {
    const result = wrapper._textToBasicHtml('Hello World');
    expect(result).toContain('<div');
    expect(result).toContain('font-family: sans-serif');
    expect(result).toContain('white-space: pre-wrap');
    expect(result).toContain('Hello World');
    expect(result).toContain('</div>');
  });

  it('converts single newline to <br>', () => {
    const result = wrapper._textToBasicHtml('line1\nline2');
    expect(result).toContain('line1<br>line2');
    expect(result).not.toContain('\n');
  });

  it('converts multiple newlines to multiple <br> tags', () => {
    const result = wrapper._textToBasicHtml('a\nb\nc');
    expect(result).toContain('a<br>b<br>c');
  });

  it('replaces ALL newlines not just the first (replaceAll fix)', () => {
    const input = 'L1\nL2\nL3\nL4\nL5';
    const result = wrapper._textToBasicHtml(input);
    // All 4 newlines should be replaced
    const brCount = (result.match(/<br>/g) || []).length;
    expect(brCount).toBe(4);
  });

  it('preserves text that has no newlines', () => {
    const result = wrapper._textToBasicHtml('No newlines here');
    expect(result).not.toContain('<br>');
    expect(result).toContain('No newlines here');
  });

  it('handles text with only newlines', () => {
    const result = wrapper._textToBasicHtml('\n\n\n');
    expect(result).toContain('<br><br><br>');
    expect(result).not.toContain('\n');
  });

  it('handles text with Windows-style \\r\\n line endings (only \\n replaced)', () => {
    // \r\n — only \n is replaced by this method
    const result = wrapper._textToBasicHtml('line1\r\nline2');
    expect(result).toContain('<br>');
  });
});

// ---------------------------------------------------------------------------
// initialize() — verifies class wiring
// ---------------------------------------------------------------------------

describe('NotifMeWrapper#initialize', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default to sendgrid so _buildConfig has a valid path
    process.env.EMAIL_PROVIDER = 'sendgrid';
    process.env.SENDGRID_API_KEY = 'SG.test-key';
  });

  afterEach(() => {
    delete process.env.EMAIL_PROVIDER;
    delete process.env.SENDGRID_API_KEY;
  });

  it('returns the instance for method chaining', () => {
    const w = new NotifMeWrapper();
    const result = w.initialize();
    expect(result).toBe(w);
  });

  it('marks the instance as initialized after first call', () => {
    const w = new NotifMeWrapper();
    w.initialize();
    expect(w.initialized).toBe(true);
  });

  it('is idempotent — second call is a no-op', () => {
    const w = new NotifMeWrapper();
    w.initialize();
    w.initialize(); // should not throw or re-initialise
    expect(w.initialized).toBe(true);
  });

  it('instantiates NotifmeSdk with channels.email config', () => {
    const w = new NotifMeWrapper();
    w.initialize();
    expect(NotifmeSdk).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: expect.objectContaining({ email: expect.any(Object) }),
      }),
    );
  });

  it('sets the provider name after initialization', () => {
    const w = new NotifMeWrapper();
    w.initialize();
    expect(w.provider).toBe('sendgrid');
  });

  it('throws when provider configuration is invalid (unknown provider)', () => {
    process.env.EMAIL_PROVIDER = 'nonexistent';
    const w = new NotifMeWrapper();
    expect(() => w.initialize()).toThrow('Unsupported email provider');
  });
});

// ---------------------------------------------------------------------------
// _buildConfig — all provider paths
// ---------------------------------------------------------------------------

describe('NotifMeWrapper#_buildConfig', () => {
  let wrapper;

  beforeEach(() => {
    jest.clearAllMocks();
    wrapper = new NotifMeWrapper();
  });

  it('builds sendgrid config from env', () => {
    process.env.SENDGRID_API_KEY = 'SG.abc';
    const config = wrapper._buildConfig('sendgrid');
    expect(config.providers[0].type).toBe('sendgrid');
    expect(config.providers[0].apiKey).toBe('SG.abc');
    delete process.env.SENDGRID_API_KEY;
  });

  it('builds mailgun config from env', () => {
    process.env.MAILGUN_API_KEY = 'mg-key';
    process.env.MAILGUN_DOMAIN = 'mg.example.com';
    const config = wrapper._buildConfig('mailgun');
    expect(config.providers[0].type).toBe('mailgun');
    expect(config.providers[0].apiKey).toBe('mg-key');
    expect(config.providers[0].domainName).toBe('mg.example.com');
    delete process.env.MAILGUN_API_KEY;
    delete process.env.MAILGUN_DOMAIN;
  });

  it('builds smtp config from env with defaults', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'user@example.com';
    process.env.SMTP_PASSWORD = 'pass123';
    const config = wrapper._buildConfig('smtp');
    const p = config.providers[0];
    expect(p.type).toBe('smtp');
    expect(p.host).toBe('smtp.example.com');
    expect(p.port).toBe(587); // default
    expect(p.secure).toBe(false); // default
    expect(p.auth.user).toBe('user@example.com');
    expect(p.auth.pass).toBe('pass123');
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
  });

  it('builds smtp config with SMTP_SECURE=true', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASSWORD = 'p';
    process.env.SMTP_SECURE = 'true';
    process.env.SMTP_PORT = '465';
    const config = wrapper._buildConfig('smtp');
    expect(config.providers[0].secure).toBe(true);
    expect(config.providers[0].port).toBe(465);
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    delete process.env.SMTP_SECURE;
    delete process.env.SMTP_PORT;
  });

  it('builds ses config from env', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIATEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    process.env.AWS_SES_REGION = 'eu-west-1';
    const config = wrapper._buildConfig('ses');
    const p = config.providers[0];
    expect(p.type).toBe('ses');
    expect(p.region).toBe('eu-west-1');
    expect(p.accessKeyId).toBe('AKIATEST');
    expect(p.secretAccessKey).toBe('secret');
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SES_REGION;
  });

  it('ses defaults region to us-east-1 when neither env is set', () => {
    delete process.env.AWS_SES_REGION;
    delete process.env.AWS_REGION;
    const config = wrapper._buildConfig('ses');
    expect(config.providers[0].region).toBe('us-east-1');
  });

  it('builds sparkpost config from env', () => {
    process.env.SPARKPOST_API_KEY = 'sp-key';
    const config = wrapper._buildConfig('sparkpost');
    expect(config.providers[0].type).toBe('sparkpost');
    expect(config.providers[0].apiKey).toBe('sp-key');
    delete process.env.SPARKPOST_API_KEY;
  });

  it('throws for unknown provider', () => {
    expect(() => wrapper._buildConfig('pigeon')).toThrow('Unsupported email provider: pigeon');
  });

  it('logs warning when required fields are missing', () => {
    delete process.env.SENDGRID_API_KEY;
    wrapper._buildConfig('sendgrid'); // missing apiKey → warn
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Missing configuration for sendgrid'),
    );
  });
});

// ---------------------------------------------------------------------------
// send() — email send path
// ---------------------------------------------------------------------------

describe('NotifMeWrapper#send', () => {
  let wrapper;
  let mockSend;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EMAIL_PROVIDER = 'sendgrid';
    process.env.SENDGRID_API_KEY = 'SG.test';
    mockSend = NotifmeSdk._send;
    mockSend.mockResolvedValue({ status: 'success', id: 'msg-1' });
    wrapper = new NotifMeWrapper();
    wrapper.initialize();
  });

  afterEach(() => {
    delete process.env.EMAIL_PROVIDER;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_FROM_NAME;
  });

  it('returns success: true when sdk.send resolves with status "success"', async () => {
    const result = await wrapper.send({
      to: 'user@example.com',
      subject: 'Hello',
      text: 'World',
    });
    expect(result.success).toBe(true);
    expect(result.status).toBe('success');
    expect(result.messageId).toBe('msg-1');
    expect(result.provider).toBe('sendgrid');
    expect(result.errors).toBeNull();
  });

  it('returns success: false when sdk.send resolves with non-success status', async () => {
    mockSend.mockResolvedValue({ status: 'error', errors: [{ message: 'rejected' }] });
    const result = await wrapper.send({
      to: 'user@example.com',
      subject: 'Hello',
      text: 'World',
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe('error');
    expect(result.errors).toEqual([{ message: 'rejected' }]);
  });

  it('returns success: false when sdk.send throws', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' }));
    const result = await wrapper.send({
      to: 'user@example.com',
      subject: 'Test',
      text: 'Body',
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe('error');
    expect(result.errors[0].message).toBe('Connection refused');
    expect(result.errors[0].code).toBe('ECONNREFUSED');
  });

  it('uses provided html when given', async () => {
    await wrapper.send({
      to: 'user@example.com',
      subject: 'S',
      text: 'plain',
      html: '<p>rich</p>',
    });
    const callArg = mockSend.mock.calls[0][0];
    expect(callArg.email.html).toBe('<p>rich</p>');
  });

  it('falls back to _textToBasicHtml when html is not provided', async () => {
    await wrapper.send({
      to: 'user@example.com',
      subject: 'S',
      text: 'plain text',
    });
    const callArg = mockSend.mock.calls[0][0];
    expect(callArg.email.html).toContain('plain text');
    expect(callArg.email.html).toContain('<div');
  });

  it('uses EMAIL_FROM env for the from address', async () => {
    process.env.EMAIL_FROM = 'custom@company.com';
    await wrapper.send({ to: 'user@example.com', subject: 'S', text: 't' });
    const callArg = mockSend.mock.calls[0][0];
    expect(callArg.email.from).toContain('custom@company.com');
  });

  it('uses EMAIL_FROM_NAME env for the from display name', async () => {
    process.env.EMAIL_FROM_NAME = 'My App';
    await wrapper.send({ to: 'user@example.com', subject: 'S', text: 't' });
    const callArg = mockSend.mock.calls[0][0];
    expect(callArg.email.from).toContain('My App');
  });

  it('uses default from address and name when env vars not set', async () => {
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_FROM_NAME;
    await wrapper.send({ to: 'u@e.com', subject: 'S', text: 't' });
    const callArg = mockSend.mock.calls[0][0];
    expect(callArg.email.from).toContain('noreply@jiraforge.io');
    expect(callArg.email.from).toContain('JIRAForge');
  });

  it('auto-initializes if not already initialized', async () => {
    const uninit = new NotifMeWrapper();
    // not calling initialize() — send() should do it
    await uninit.send({ to: 'u@e.com', subject: 'S', text: 't' });
    expect(uninit.initialized).toBe(true);
  });

  it('uses provided from address', async () => {
    await wrapper.send({ to: 'u@e.com', from: 'custom@from.com', subject: 'S', text: 't' });
    const callArg = mockSend.mock.calls[0][0];
    expect(callArg.email.from).toContain('custom@from.com');
  });
});

// ---------------------------------------------------------------------------
// sendBatch() — batch email sending
// ---------------------------------------------------------------------------

describe('NotifMeWrapper#sendBatch', () => {
  let wrapper;
  let mockSend;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EMAIL_PROVIDER = 'sendgrid';
    process.env.SENDGRID_API_KEY = 'SG.test';
    mockSend = NotifmeSdk._send;
    mockSend.mockResolvedValue({ status: 'success', id: 'msg-batch' });
    wrapper = new NotifMeWrapper();
    wrapper.initialize();
    // Make the 100ms inter-email delay a no-op so tests run quickly
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.EMAIL_PROVIDER;
    delete process.env.SENDGRID_API_KEY;
  });

  it('returns an array with one result per email', async () => {
    const emails = [
      { to: 'a@example.com', subject: 'A', text: 'a' },
      { to: 'b@example.com', subject: 'B', text: 'b' },
    ];
    const results = await wrapper.sendBatch(emails);
    expect(results).toHaveLength(2);
  });

  it('each result includes the "to" address', async () => {
    const emails = [{ to: 'x@example.com', subject: 'X', text: 'x' }];
    const results = await wrapper.sendBatch(emails);
    expect(results[0].to).toBe('x@example.com');
  });

  it('returns empty array for empty email list', async () => {
    const results = await wrapper.sendBatch([]);
    expect(results).toEqual([]);
  });

  it('each result includes success flag', async () => {
    const emails = [{ to: 'y@example.com', subject: 'Y', text: 'y' }];
    const results = await wrapper.sendBatch(emails);
    expect(results[0].success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getProvider(), isConfigured(), isEnabled(), reset()
// ---------------------------------------------------------------------------

describe('NotifMeWrapper accessors and lifecycle', () => {
  let wrapper;

  beforeEach(() => {
    jest.clearAllMocks();
    wrapper = new NotifMeWrapper();
  });

  afterEach(() => {
    delete process.env.EMAIL_PROVIDER;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.EMAIL_NOTIFICATIONS_ENABLED;
  });

  // ── getProvider ───────────────────────────────────────────────────────────

  it('getProvider returns null before initialization', () => {
    expect(wrapper.getProvider()).toBeNull();
  });

  it('getProvider returns provider name after initialization', () => {
    process.env.EMAIL_PROVIDER = 'sendgrid';
    process.env.SENDGRID_API_KEY = 'SG.x';
    wrapper.initialize();
    expect(wrapper.getProvider()).toBe('sendgrid');
  });

  // ── isConfigured ──────────────────────────────────────────────────────────

  it('isConfigured returns true when provider env is valid', () => {
    process.env.EMAIL_PROVIDER = 'sendgrid';
    process.env.SENDGRID_API_KEY = 'SG.valid';
    expect(wrapper.isConfigured()).toBe(true);
  });

  it('isConfigured returns false when provider is unknown', () => {
    process.env.EMAIL_PROVIDER = 'nonexistent-provider';
    expect(wrapper.isConfigured()).toBe(false);
  });

  // ── isEnabled ─────────────────────────────────────────────────────────────

  it('isEnabled returns true by default (env not set)', () => {
    delete process.env.EMAIL_NOTIFICATIONS_ENABLED;
    expect(wrapper.isEnabled()).toBe(true);
  });

  it('isEnabled returns false when EMAIL_NOTIFICATIONS_ENABLED is "false"', () => {
    process.env.EMAIL_NOTIFICATIONS_ENABLED = 'false';
    expect(wrapper.isEnabled()).toBe(false);
  });

  it('isEnabled returns true when EMAIL_NOTIFICATIONS_ENABLED is "true"', () => {
    process.env.EMAIL_NOTIFICATIONS_ENABLED = 'true';
    expect(wrapper.isEnabled()).toBe(true);
  });

  // ── reset ─────────────────────────────────────────────────────────────────

  it('reset sets sdk to null', () => {
    process.env.EMAIL_PROVIDER = 'sendgrid';
    process.env.SENDGRID_API_KEY = 'SG.x';
    wrapper.initialize();
    expect(wrapper.sdk).not.toBeNull();
    wrapper.reset();
    expect(wrapper.sdk).toBeNull();
  });

  it('reset sets provider to null', () => {
    process.env.EMAIL_PROVIDER = 'sendgrid';
    process.env.SENDGRID_API_KEY = 'SG.x';
    wrapper.initialize();
    wrapper.reset();
    expect(wrapper.provider).toBeNull();
  });

  it('reset sets initialized to false', () => {
    process.env.EMAIL_PROVIDER = 'sendgrid';
    process.env.SENDGRID_API_KEY = 'SG.x';
    wrapper.initialize();
    expect(wrapper.initialized).toBe(true);
    wrapper.reset();
    expect(wrapper.initialized).toBe(false);
  });

  it('allows re-initialization after reset', () => {
    process.env.EMAIL_PROVIDER = 'sendgrid';
    process.env.SENDGRID_API_KEY = 'SG.x';
    wrapper.initialize();
    wrapper.reset();
    wrapper.initialize();
    expect(wrapper.initialized).toBe(true);
  });
});
