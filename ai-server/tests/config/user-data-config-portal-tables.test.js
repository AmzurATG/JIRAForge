'use strict';

/**
 * GDPR erasure covers the portal-owned per-user tables (plan AC10).
 * These tables have user_id but NO organization_id — deleteFromTable must
 * skip the org filter for them or PostgREST errors and rows survive erasure.
 * Plan: plan/2026-06-12_cross-component_automatic-employee-location-detection.md
 */

const userDataConfig = require('../../src/config/user-data-config');

describe('portal-owned tables in the erasure path (AC10)', () => {
  const portalTables = [
    'portal_employee_profiles',
    'portal_lob_employees',
    'portal_employee_work_locations',
  ];

  test.each(portalTables)('%s is flagged as having no org scope', (table) => {
    expect(userDataConfig.hasNoOrgScope(table)).toBe(true);
  });

  test.each(portalTables)('%s is ordered before the users table for deletion', (table) => {
    expect(userDataConfig.deletionOrder).toContain(table);
    expect(userDataConfig.getDeletionOrderIndex(table))
      .toBeLessThan(userDataConfig.getDeletionOrderIndex('users'));
  });

  test('org-scoped tables are not flagged', () => {
    expect(userDataConfig.hasNoOrgScope('screenshots')).toBe(false);
    expect(userDataConfig.hasNoOrgScope('activity_records')).toBe(false);
    expect(userDataConfig.hasNoOrgScope('users')).toBe(false);
  });
});
