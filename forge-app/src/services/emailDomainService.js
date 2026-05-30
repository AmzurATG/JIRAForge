/**
 * Email Domain Service
 *
 * Manages the org_email_domains allowlist that maps a company email domain
 * (e.g. amzur.com) to an organization. This is what lets non-Jira employees
 * self-sign-up to the desktop app via Google SSO and land in the correct org —
 * and it enforces "company email only" signup.
 *
 * Admin-only (Jira Administrator). Writes go through the AI-server proxy
 * (service role), same as all other Forge DB traffic.
 */

import api, { route } from '@forge/api';
import { getOrCreateOrganization, supabaseQuery } from '../utils/remote.js';
import { isJiraAdmin } from '../utils/jira.js';

function normalizeDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^@/, '');
}

// Basic hostname validation (labels + a TLD). Rejects emails, spaces, schemes.
function isValidDomain(d) {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d);
}

/**
 * Suggest the company domain from the current admin's Atlassian email so the UI
 * can pre-fill it (the admin just confirms). Returns null if unavailable.
 */
export async function getSuggestedDomain() {
  try {
    const res = await api.asUser().requestJira(route`/rest/api/3/myself`, { method: 'GET' });
    if (!res.ok) return null;
    const me = await res.json();
    const email = me.emailAddress || '';
    return email.includes('@') ? normalizeDomain(email.split('@')[1]) : null;
  } catch (err) {
    console.warn('[EmailDomains] Could not derive suggested domain:', err.message);
    return null;
  }
}

/**
 * List the domains registered for this org.
 */
export async function getEmailDomains(cloudId) {
  const org = await getOrCreateOrganization(cloudId);
  if (!org?.id) throw new Error('Organization not found');
  const rows = await supabaseQuery('org_email_domains', {
    method: 'GET',
    query: { eq: { organization_id: org.id } }
  });
  return (rows || []).map(r => r.domain).sort();
}

/**
 * Register a company domain for this org (admin only).
 * Domains are globally unique; surfacing a clear error if already taken.
 */
export async function addEmailDomain(cloudId, domain) {
  if (!(await isJiraAdmin())) throw new Error('Access denied: Jira Administrator required');

  const normalized = normalizeDomain(domain);
  if (!isValidDomain(normalized)) {
    throw new Error('Enter a valid domain like "amzur.com" (no @, no spaces).');
  }

  const org = await getOrCreateOrganization(cloudId);
  if (!org?.id) throw new Error('Organization not found');

  // Idempotent: skip if this org already has it.
  const existing = await supabaseQuery('org_email_domains', {
    method: 'GET',
    query: { eq: { organization_id: org.id, domain: normalized } }
  });
  if (existing && existing.length > 0) return normalized;

  try {
    await supabaseQuery('org_email_domains', {
      method: 'POST',
      body: { organization_id: org.id, domain: normalized }
    });
  } catch (err) {
    // Global unique index → a duplicate means another org already claimed it.
    if (/duplicate|unique/i.test(err.message || '')) {
      throw new Error(`Domain "${normalized}" is already registered (possibly to another organization).`);
    }
    throw err;
  }
  return normalized;
}

/**
 * Remove a registered domain for this org (admin only).
 */
export async function removeEmailDomain(cloudId, domain) {
  if (!(await isJiraAdmin())) throw new Error('Access denied: Jira Administrator required');
  const normalized = normalizeDomain(domain);
  const org = await getOrCreateOrganization(cloudId);
  if (!org?.id) throw new Error('Organization not found');

  await supabaseQuery('org_email_domains', {
    method: 'DELETE',
    query: { eq: { organization_id: org.id, domain: normalized } }
  });
  return normalized;
}
