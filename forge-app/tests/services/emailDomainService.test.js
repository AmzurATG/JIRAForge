'use strict';

/**
 * emailDomainService — non-Jira Google SSO company-domain allowlist (admin only).
 *
 * Covers the admin guard, domain validation/normalization, idempotent add,
 * duplicate-domain error mapping, and that writes go through the AI-server proxy.
 */

jest.mock('@forge/api', () => {
  const mockRequestJira = jest.fn();
  const api = { asUser: () => ({ requestJira: mockRequestJira }) };
  api.route = (strings, ...values) =>
    strings.reduce((acc, s, i) => acc + s + (values[i] || ''), '');
  return { __esModule: true, default: api, route: api.route, __mockRequestJira: mockRequestJira };
});

jest.mock('../../src/utils/remote.js', () => ({
  getOrCreateOrganization: jest.fn(),
  supabaseQuery: jest.fn(),
}));

jest.mock('../../src/utils/jira.js', () => ({
  isJiraAdmin: jest.fn(),
}));

const { getOrCreateOrganization, supabaseQuery } = require('../../src/utils/remote.js');
const { isJiraAdmin } = require('../../src/utils/jira.js');
const {
  getEmailDomains,
  addEmailDomain,
  removeEmailDomain,
} = require('../../src/services/emailDomainService.js');

describe('emailDomainService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getOrCreateOrganization.mockResolvedValue({ id: 'org-1' });
  });

  describe('getEmailDomains', () => {
    it('returns the org\'s domains sorted', async () => {
      supabaseQuery.mockResolvedValue([{ domain: 'zeta.com' }, { domain: 'amzur.com' }]);
      const domains = await getEmailDomains('cloud-1');
      expect(domains).toEqual(['amzur.com', 'zeta.com']);
      expect(supabaseQuery).toHaveBeenCalledWith('org_email_domains', {
        method: 'GET',
        query: { eq: { organization_id: 'org-1' } },
      });
    });

    it('returns [] when there are no rows', async () => {
      supabaseQuery.mockResolvedValue(null);
      expect(await getEmailDomains('cloud-1')).toEqual([]);
    });
  });

  describe('addEmailDomain', () => {
    it('rejects non-admins before any DB write', async () => {
      isJiraAdmin.mockResolvedValue(false);
      await expect(addEmailDomain('cloud-1', 'amzur.com')).rejects.toThrow(/Administrator/);
      expect(supabaseQuery).not.toHaveBeenCalled();
    });

    it('normalizes the domain (strips @, lowercases) and inserts it', async () => {
      isJiraAdmin.mockResolvedValue(true);
      supabaseQuery.mockResolvedValueOnce([]); // existing lookup -> none
      supabaseQuery.mockResolvedValueOnce({}); // insert
      const result = await addEmailDomain('cloud-1', '@Amzur.COM');
      expect(result).toBe('amzur.com');
      expect(supabaseQuery).toHaveBeenLastCalledWith('org_email_domains', {
        method: 'POST',
        body: { organization_id: 'org-1', domain: 'amzur.com' },
      });
    });

    it('rejects an invalid domain (no insert)', async () => {
      isJiraAdmin.mockResolvedValue(true);
      await expect(addEmailDomain('cloud-1', 'not a domain')).rejects.toThrow(/valid domain/);
      expect(supabaseQuery).not.toHaveBeenCalled();
    });

    it('is idempotent: skips insert when the org already has the domain', async () => {
      isJiraAdmin.mockResolvedValue(true);
      supabaseQuery.mockResolvedValueOnce([{ domain: 'amzur.com' }]); // existing lookup -> found
      const result = await addEmailDomain('cloud-1', 'amzur.com');
      expect(result).toBe('amzur.com');
      expect(supabaseQuery).toHaveBeenCalledTimes(1); // only the lookup, no POST
    });

    it('maps a global unique-constraint violation to a clear "already registered" error', async () => {
      isJiraAdmin.mockResolvedValue(true);
      supabaseQuery.mockResolvedValueOnce([]); // existing lookup -> none
      supabaseQuery.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
      await expect(addEmailDomain('cloud-1', 'amzur.com')).rejects.toThrow(/already registered/);
    });
  });

  describe('removeEmailDomain', () => {
    it('rejects non-admins', async () => {
      isJiraAdmin.mockResolvedValue(false);
      await expect(removeEmailDomain('cloud-1', 'amzur.com')).rejects.toThrow(/Administrator/);
      expect(supabaseQuery).not.toHaveBeenCalled();
    });

    it('deletes the normalized domain for the org', async () => {
      isJiraAdmin.mockResolvedValue(true);
      supabaseQuery.mockResolvedValue({});
      const result = await removeEmailDomain('cloud-1', '@Amzur.com');
      expect(result).toBe('amzur.com');
      expect(supabaseQuery).toHaveBeenCalledWith('org_email_domains', {
        method: 'DELETE',
        query: { eq: { organization_id: 'org-1', domain: 'amzur.com' } },
      });
    });
  });
});
