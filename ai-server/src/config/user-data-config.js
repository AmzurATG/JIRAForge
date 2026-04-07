/**
 * User Data Configuration
 * 
 * Configuration for GDPR-compliant user data export and deletion.
 * This file defines special handling rules for tables and storage buckets.
 * 
 * WHY THIS EXISTS:
 * While we dynamically discover tables with user_id, some tables need special handling:
 * - Deletion order (to avoid foreign key violations)
 * - Storage files associated with database records
 * - Anonymization instead of deletion (audit logs)
 * - Row limits for large tables
 * - Special query logic
 * 
 * MAINTENANCE:
 * - Add new tables to deletionOrder if they have foreign key dependencies
 * - Add to storageAssociations if table has files in storage buckets
 * - Add to specialHandling if table needs custom logic
 */

'use strict';

/**
 * Deletion order: Tables are deleted in this order to avoid FK violations
 * 
 * RULES:
 * - Child tables BEFORE parent tables
 * - Tables with FKs pointing TO other tables come FIRST
 * - Tables with FKs pointing FROM other tables come LAST
 * - 'users' table MUST be last (CASCADE handles stragglers)
 * 
 * When adding new tables:
 * 1. Check foreign key relationships
 * 2. Add table name to correct position in array
 * 3. Test deletion on a test user
 */
const deletionOrder = [
  // Level 1: Deep children (no other user tables depend on these)
  'activity_records',
  'unassigned_activity',
  'notification_logs',
  'notification_cooldowns',
  
  // Level 2: Mid-level children
  'analysis_results',      // FK to screenshots
  'worklogs',             // Independent
  'documents',            // Independent
  'feedback',             // Independent
  'user_jira_issues_cache', // Independent
  
  // Level 3: Primary data tables
  'screenshots',          // Referenced by analysis_results (already deleted)
  
  // Level 4: Settings and preferences
  'tracking_settings',
  'notification_preferences',
  'worklog_sync',
  
  // Level 5: Organization memberships
  'organization_members', // FK to users
  
  // LAST: Users table (CASCADE will clean up any missed FKs)
  'users'
];

/**
 * Tables that should be anonymized instead of deleted
 * These are typically audit logs where we need to keep records but remove PII
 */
const anonymizeTables = {
  'activity_log': {
    // Set these columns to null or redacted values
    anonymize: {
      user_id: null,
      ip_address: null,
      user_agent: 'REDACTED'
    },
    // Update event_data JSON to remove PII
    redactEventData: true
  }
};

/**
 * Storage buckets and their associated database tables
 * 
 * Format:
 * {
 *   bucketName: {
 *     paths: string[], // Path patterns to check (supports {user_id}, {org_id})
 *     associatedTable: string // Table name that references these files
 *   }
 * }
 */
const storageAssociations = {
  'screenshots': {
    paths: [
      '{org_id}/{user_id}/',     // New path format
      '{user_id}/',               // Legacy path format
      '{org_id}/{user_id}/thumbnails/',
      '{user_id}/thumbnails/'
    ],
    associatedTable: 'screenshots',
    description: 'Screenshot images and thumbnails'
  },
  'documents': {
    paths: [
      '{org_id}/{user_id}/',
      '{user_id}/'
    ],
    associatedTable: 'documents',
    description: 'BRD and analysis documents (PDF/DOCX)'
  },
  'feedback-images': {
    paths: [
      '{user_id}/'
    ],
    associatedTable: 'feedback',
    description: 'Feedback screenshot attachments'
  }
};

/**
 * Row limits for export (prevent memory issues with huge datasets)
 */
const exportRowLimits = {
  'screenshots': 10000,
  'analysis_results': 10000,
  'activity_records': 10000,
  'worklogs': 10000,
  'activity_log': 1000,       // Only recent logs
  'notification_logs': 1000,  // Only recent notifications
  'default': 50000            // Default limit for unlisted tables
};

/**
 * Tables that should be excluded from automatic discovery
 * (e.g., system tables, junction tables handled differently, etc.)
 */
const excludedTables = [
  // Add table names here if they have user_id but shouldn't be exported/deleted
  // Example: 'user_sessions' // Handled separately with different logic
];

/**
 * Special handling instructions for specific tables
 */
const specialHandling = {
  'activity_log': {
    export: 'limited',      // Only export last N rows
    delete: 'anonymize',    // Don't delete, just anonymize
    description: 'Audit trail - anonymize instead of deleting'
  },
  'users': {
    delete: 'last',         // MUST be deleted last
    cascade: true,          // Has CASCADE FKs
    description: 'User profile - delete last to allow CASCADE'
  },
  'screenshots': {
    hasStorageFiles: true,
    storageBucket: 'screenshots',
    description: 'Has associated image files in storage'
  },
  'documents': {
    hasStorageFiles: true,
    storageBucket: 'documents',
    description: 'Has associated PDF/DOCX files in storage'
  },
  'feedback': {
    hasStorageFiles: true,
    storageBucket: 'feedback-images',
    description: 'May have associated screenshot images'
  }
};

/**
 * Get deletion order for a specific table
 * @param {string} tableName 
 * @returns {number} Order index (lower = delete first)
 */
function getDeletionOrderIndex(tableName) {
  const index = deletionOrder.indexOf(tableName);
  return index !== -1 ? index : 9999; // Unknown tables go last
}

/**
 * Check if a table should be anonymized instead of deleted
 * @param {string} tableName 
 * @returns {boolean}
 */
function shouldAnonymize(tableName) {
  return tableName in anonymizeTables;
}

/**
 * Get row limit for export
 * @param {string} tableName 
 * @returns {number} Maximum rows to export
 */
function getExportRowLimit(tableName) {
  return exportRowLimits[tableName] || exportRowLimits.default;
}

/**
 * Check if table should be excluded from discovery
 * @param {string} tableName 
 * @returns {boolean}
 */
function isExcluded(tableName) {
  return excludedTables.includes(tableName);
}

module.exports = {
  deletionOrder,
  anonymizeTables,
  storageAssociations,
  exportRowLimits,
  excludedTables,
  specialHandling,
  getDeletionOrderIndex,
  shouldAnonymize,
  getExportRowLimit,
  isExcluded
};
