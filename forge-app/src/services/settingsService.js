/**
 * Settings Service
 * Business logic for user settings management
 *
 * Note: AI server connection settings have been removed.
 * All connections are now managed automatically via Forge Remote (manifest.yml).
 */

import { isJiraAdmin, checkUserPermissions } from '../utils/jira.js';
// eslint-disable-next-line deprecation/deprecation
import { getSupabaseConfig, supabaseRequest, getOrCreateOrganization, getOrCreateUser } from '../utils/supabase.js';
import { DEFAULT_TRACKING_SETTINGS } from '../config/constants.js';

/**
 * Get user settings from Forge storage
 * Note: AI server settings have been removed - connections are now automatic via Forge Remote
 * @param {string} accountId - Atlassian account ID (ignored)
 * @returns {Promise<Object>} User settings
 */
export async function getUserSettings(accountId) {
  // All connections are now managed automatically via Forge Remote
  // No user-configurable settings required
  return {
    configured: true,
    connectionMode: 'forge-remote'
  };
}

/**
 * Save user settings to Forge storage
 * Note: AI server settings have been removed - connections are now automatic via Forge Remote
 * This function is kept for backward compatibility but no longer stores AI server settings
 * @param {string} accountId - Atlassian account ID (ignored)
 * @param {Object} settings - Settings object (ignored)
 * @returns {Promise<void>}
 */
export async function saveUserSettings(accountId, settings) {
  // Check if user is Jira Administrator
  const isAdmin = await isJiraAdmin();
  if (!isAdmin) {
    throw new Error('Access denied: Only Jira Administrators can access settings');
  }

  // No settings to save - AI server connection is managed via Forge Remote in manifest.yml
  // This function is kept for backward compatibility
}

/**
 * Fetch tracking settings from database with fallback hierarchy
 * @param {Object} supabaseConfig - Supabase configuration
 * @param {string} organizationId - Organization ID
 * @param {string} projectKey - Project key (optional)
 * @returns {Promise<{response: Array, settingsSource: string}>} Settings response and source
 */
async function fetchTrackingSettingsWithFallback(supabaseConfig, organizationId, projectKey) {
  let response;
  let settingsSource = 'global';

  // Priority: project-specific → org-level → global defaults
  if (organizationId && projectKey) {
    // Try project-specific settings first
    // eslint-disable-next-line deprecation/deprecation
    response = await supabaseRequest(
      supabaseConfig,
      `tracking_settings?organization_id=eq.${organizationId}&project_key=eq.${projectKey}&limit=1`
    );
    if (response && response.length > 0) {
      settingsSource = 'project';
      return { response, settingsSource };
    }
  }

  // Fall back to org-level settings
  if (organizationId) {
    // eslint-disable-next-line deprecation/deprecation
    response = await supabaseRequest(
      supabaseConfig,
      `tracking_settings?organization_id=eq.${organizationId}&project_key=is.null&limit=1`
    );
    if (response && response.length > 0) {
      settingsSource = 'organization';
      return { response, settingsSource };
    }
  }

  // Fall back to global defaults
  // eslint-disable-next-line deprecation/deprecation
  response = await supabaseRequest(
    supabaseConfig,
    'tracking_settings?organization_id=is.null&project_key=is.null&limit=1'
  );
  if (response && response.length > 0) {
    settingsSource = 'global';
  }

  return { response, settingsSource };
}

/**
 * Transform database settings to API format
 * @param {Object} settings - Raw database settings
 * @param {string} settingsSource - Source of settings (project/organization/global/default)
 * @returns {Object} Formatted settings
 */
function transformSettingsToApiFormat(settings, settingsSource) {
  return {
    screenshotMonitoringEnabled: settings.screenshot_monitoring_enabled,
    screenshotIntervalSeconds: settings.screenshot_interval_seconds,
    intervalTrackingEnabled: settings.interval_tracking_enabled ?? (settings.tracking_mode === 'interval'),
    eventTrackingEnabled: settings.event_tracking_enabled,
    trackWindowChanges: settings.track_window_changes,
    trackIdleTime: settings.track_idle_time,
    idleThresholdSeconds: settings.idle_threshold_seconds,
    whitelistEnabled: settings.whitelist_enabled,
    whitelistedApps: settings.whitelisted_apps || [],
    blacklistEnabled: settings.blacklist_enabled,
    blacklistedApps: settings.blacklisted_apps || [],
    nonWorkThresholdPercent: settings.non_work_threshold_percent,
    flagExcessiveNonWork: settings.flag_excessive_non_work,
    privateSitesEnabled: settings.private_sites_enabled,
    privateSites: settings.private_sites || [],
    jiraWorklogSyncEnabled: settings.jira_worklog_sync_enabled ?? true,
    workHoursStart: (settings.work_hours_start || '09:00').slice(0, 5),
    workHoursEnd: (settings.work_hours_end || '18:00').slice(0, 5),
    workDays: settings.work_days || [1, 2, 3, 4, 5],
    desktopAdminPassword: settings.desktop_admin_password || '',
    projectKey: settings.project_key || null,
    settingsSource: settingsSource
  };
}

/**
 * Get tracking/timesheet settings from Supabase
 * These can be project-level or organization-level settings for screenshot monitoring, app lists, etc.
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for multi-tenancy
 * @param {string} projectKey - Optional Jira project key for project-specific settings
 * @returns {Promise<Object>} Tracking settings with settingsSource indicating level
 */
export async function getTrackingSettings(accountId, cloudId, projectKey = null) {
  try {
    // eslint-disable-next-line deprecation/deprecation
    const supabaseConfig = await getSupabaseConfig(accountId);
    if (!supabaseConfig) {
      console.log('[TrackingSettings] Supabase not configured, returning defaults');
      return { ...DEFAULT_TRACKING_SETTINGS, settingsSource: 'default' };
    }

    // Get organization for multi-tenancy
    let organizationId = null;
    if (cloudId) {
      try {
        const org = await getOrCreateOrganization(cloudId, supabaseConfig);
        organizationId = org?.id;
      } catch (err) {
        console.log('[TrackingSettings] Could not get organization, using global settings:', err.message);
      }
    }

    const { response, settingsSource } = await fetchTrackingSettingsWithFallback(
      supabaseConfig,
      organizationId,
      projectKey
    );

    if (response && response.length > 0) {
      return transformSettingsToApiFormat(response[0], settingsSource);
    }

    return { ...DEFAULT_TRACKING_SETTINGS, settingsSource: 'default' };
  } catch (error) {
    console.error('[TrackingSettings] Error fetching settings:', error);
    return { ...DEFAULT_TRACKING_SETTINGS, settingsSource: 'default' };
  }
}

function inferPrivateMatchBy(identifier) {
  const value = (identifier || '').toLowerCase();
  // Process-like values (desktop executables / binaries)
  if (/\.(exe|app|bin|msc)$/i.test(value)) return 'process';
  // Wildcard/domain/path-like values are treated as URL entries.
  if (value.includes('*') || value.includes('/') || value.includes('.')) return 'url';
  // Safe default for legacy plain names in private list.
  return 'process';
}

function buildTrackingClassificationEntries({
  whitelistedApps = [],
  blacklistedApps = [],
  privateSites = []
} = {}) {
  const entries = [
    ...(whitelistedApps || []).filter(Boolean).map((identifier) => ({
      identifier,
      display_name: identifier,
      classification: 'productive',
      match_by: 'process'
    })),
    ...(blacklistedApps || []).filter(Boolean).map((identifier) => ({
      identifier,
      display_name: identifier,
      classification: 'non_productive',
      match_by: 'process'
    })),
    ...(privateSites || []).filter(Boolean).map((identifier) => ({
      identifier,
      display_name: identifier,
      classification: 'private',
      match_by: inferPrivateMatchBy(identifier)
    }))
  ];

  const uniqueMap = new Map();
  for (const entry of entries) {
    const key = `${entry.identifier}|${entry.match_by}`;
    if (!uniqueMap.has(key)) uniqueMap.set(key, entry);
  }
  return Array.from(uniqueMap.values());
}

async function deleteRemovedApplicationClassificationsFromTrackingSettings(
  supabaseConfig,
  {
    organizationId,
    projectKey,
    previousSettings = {},
    whitelistedApps = [],
    blacklistedApps = [],
    privateSites = []
  }
) {
  if (!organizationId) return;

  const previousEntries = buildTrackingClassificationEntries({
    whitelistedApps: previousSettings.whitelisted_apps || [],
    blacklistedApps: previousSettings.blacklisted_apps || [],
    privateSites: previousSettings.private_sites || []
  });
  const currentEntries = buildTrackingClassificationEntries({
    whitelistedApps,
    blacklistedApps,
    privateSites
  });
  const currentKeys = new Set(
    currentEntries.map((entry) => `${entry.identifier}|${entry.match_by}`)
  );
  const removedEntries = previousEntries.filter(
    (entry) => !currentKeys.has(`${entry.identifier}|${entry.match_by}`)
  );
  if (removedEntries.length === 0) return;

  const projectFilter = projectKey
    ? `project_key=eq.${encodeURIComponent(projectKey)}`
    : 'project_key=is.null';

  // Delete all removed entries in parallel to avoid sequential round-trips
  await Promise.allSettled(
    removedEntries.map((entry) =>
      // eslint-disable-next-line deprecation/deprecation
      supabaseRequest(
        supabaseConfig,
        `application_classifications?organization_id=eq.${organizationId}&${projectFilter}&identifier=eq.${encodeURIComponent(entry.identifier)}&match_by=eq.${entry.match_by}`,
        { method: 'DELETE' }
      )
    )
  );
}

/**
 * Fetch display name lookup from defaults and org-level classifications
 * @param {Object} supabaseConfig - Supabase configuration
 * @param {string} organizationId - Organization ID
 * @returns {Promise<Map>} Map of identifier|match_by -> display_name
 */
async function fetchDisplayNameLookup(supabaseConfig, organizationId) {
  const displayNameLookup = new Map();
  
  try {
    // Fetch defaults (is_default=true)
    // eslint-disable-next-line deprecation/deprecation
    const defaults = await supabaseRequest(
      supabaseConfig,
      `application_classifications?is_default=eq.true&select=identifier,display_name,match_by`
    );
    if (defaults && Array.isArray(defaults)) {
      for (const d of defaults) {
        const key = `${d.identifier}|${d.match_by || 'process'}`;
        displayNameLookup.set(key, d.display_name);
      }
    }
    // Also fetch org-level (project_key is null) which may have custom display names
    // eslint-disable-next-line deprecation/deprecation
    const orgLevel = await supabaseRequest(
      supabaseConfig,
      `application_classifications?organization_id=eq.${organizationId}&project_key=is.null&select=identifier,display_name,match_by`
    );
    if (orgLevel && Array.isArray(orgLevel)) {
      for (const o of orgLevel) {
        const key = `${o.identifier}|${o.match_by || 'process'}`;
        // Org-level overrides defaults if present
        displayNameLookup.set(key, o.display_name);
      }
    }
  } catch (lookupErr) {
    console.warn('[TrackingSettings] Could not pre-fetch display names:', lookupErr.message);
  }
  
  return displayNameLookup;
}


async function upsertApplicationClassificationsFromTrackingSettings(
  supabaseConfig,
  {
    organizationId,
    projectKey,
    userId,
    whitelistedApps = [],
    blacklistedApps = [],
    privateSites = []
  }
) {
  if (!organizationId) {
    return;
  }

  const projectFilter = projectKey
    ? `project_key=eq.${encodeURIComponent(projectKey)}`
    : 'project_key=is.null';

  const uniqueEntries = buildTrackingClassificationEntries({
    whitelistedApps,
    blacklistedApps,
    privateSites
  });

  if (uniqueEntries.length === 0) return;

  // Pre-fetch display names AND all existing classifications for this scope in parallel
  // This replaces N per-entry GET calls with 1 batch query
  const [displayNameLookup, existingClassifications] = await Promise.all([
    fetchDisplayNameLookup(supabaseConfig, organizationId),
    // eslint-disable-next-line deprecation/deprecation
    supabaseRequest(
      supabaseConfig,
      `application_classifications?organization_id=eq.${organizationId}&${projectFilter}&select=id,identifier,match_by`
    ).then(res => res || []).catch(() => [])
  ]);

  // Build a lookup map from existing classifications: "identifier|match_by" → id
  const existingMap = new Map();
  for (const row of existingClassifications) {
    existingMap.set(`${row.identifier}|${row.match_by}`, row.id);
  }

  // Run all upserts in parallel — each entry does 1 write + 1 backfill instead of 1 read + 1 write + 1 backfill
  const results = await Promise.allSettled(
    uniqueEntries.map((entry) => {
      const lookupKey = `${entry.identifier}|${entry.match_by}`;
      const resolvedDisplayName = displayNameLookup.get(lookupKey) || entry.identifier;
      const existingId = existingMap.get(lookupKey);

      const payload = {
        organization_id: organizationId,
        project_key: projectKey || null,
        identifier: entry.identifier,
        display_name: resolvedDisplayName,
        classification: entry.classification,
        match_by: entry.match_by,
        is_default: false,
        updated_at: new Date().toISOString(),
        created_by: userId || null
      };

      // Upsert (PATCH existing or POST new) then backfill activity_records
      const upsertPromise = existingId
        // eslint-disable-next-line deprecation/deprecation
        ? supabaseRequest(
            supabaseConfig,
            `application_classifications?id=eq.${existingId}`,
            { method: 'PATCH', body: payload }
          )
        // eslint-disable-next-line deprecation/deprecation
        : supabaseRequest(
            supabaseConfig,
            'application_classifications',
            { method: 'POST', body: { ...payload, created_at: new Date().toISOString() } }
          );

      return upsertPromise.then(() => {
        // Backfill unknown activity rows for this app
        const newStatus = entry.classification === 'productive' ? 'pending' : 'analyzed';
        let updateQuery =
          `activity_records?organization_id=eq.${organizationId}` +
          `&classification=eq.unknown` +
          `&application_name=eq.${encodeURIComponent(entry.identifier)}`;
        if (projectKey) {
          updateQuery += `&project_key=eq.${encodeURIComponent(projectKey)}`;
        }
        // eslint-disable-next-line deprecation/deprecation
        return supabaseRequest(
          supabaseConfig,
          updateQuery,
          { method: 'PATCH', body: { classification: entry.classification, status: newStatus } }
        );
      });
    })
  );

  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    for (const f of failed) {
      console.warn(`[TrackingSettings] Classification upsert/backfill failed: ${f.reason?.message || f.reason}`);
    }
  }
}

/**
 * Validate tracking settings input
 * @param {Object} settings - Settings to validate
 * @throws {Error} If validation fails
 */
function validateTrackingSettings(settings) {
  if (settings.screenshotIntervalSeconds < 60 || settings.screenshotIntervalSeconds > 3600) {
    throw new Error('Screenshot interval must be between 60 and 3600 seconds');
  }

  if (settings.nonWorkThresholdPercent < 0 || settings.nonWorkThresholdPercent > 100) {
    throw new Error('Non-work threshold must be between 0 and 100 percent');
  }

  // Validate work hours if provided (accept HH:MM or HH:MM:SS from database TIME columns)
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
  if (settings.workHoursStart && !timePattern.test(settings.workHoursStart)) {
    throw new Error('Work hours start must be in HH:MM format (00:00–23:59)');
  }
  if (settings.workHoursEnd && !timePattern.test(settings.workHoursEnd)) {
    throw new Error('Work hours end must be in HH:MM format (00:00–23:59)');
  }
  if (settings.workDays) {
    if (!Array.isArray(settings.workDays) || settings.workDays.some(d => d < 1 || d > 7)) {
      throw new Error('Work days must be an array of integers 1 (Mon) through 7 (Sun)');
    }
  }

  if (settings.desktopAdminPassword !== undefined) {
    if (typeof settings.desktopAdminPassword !== 'string' || settings.desktopAdminPassword.length < 6) {
      throw new Error('Desktop admin password must be at least 6 characters');
    }
    if (settings.desktopAdminPassword.length > 128) {
      throw new Error('Desktop admin password must be 128 characters or less');
    }
  }
}

/**
 * Resolve organization and user IDs for multi-tenancy
 * @param {Object} supabaseConfig - Supabase configuration
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} accountId - Atlassian account ID
 * @returns {Promise<{organizationId: string|null, userId: string|null}>}
 */
async function resolveOrganizationAndUser(supabaseConfig, cloudId, accountId) {
  let organizationId = null;
  let userId = null;
  
  if (cloudId) {
    try {
      const org = await getOrCreateOrganization(cloudId, supabaseConfig);
      organizationId = org?.id;
    } catch (err) {
      console.log('[TrackingSettings] Could not get organization:', err.message);
    }
  }

  if (accountId) {
    try {
      userId = await getOrCreateUser(accountId, supabaseConfig, organizationId);
    } catch (err) {
      console.log('[TrackingSettings] Could not get user:', err.message);
    }
  }

  return { organizationId, userId };
}

/**
 * Fetch existing tracking settings based on organization and project
 * @param {Object} supabaseConfig - Supabase configuration
 * @param {string} organizationId - Organization ID
 * @param {string} projectKey - Project key (optional)
 * @returns {Promise<Array>} Existing settings array
 */
async function fetchExistingTrackingSettings(supabaseConfig, organizationId, projectKey) {
  if (organizationId && projectKey) {
    // Project-specific settings
    // eslint-disable-next-line deprecation/deprecation
    return await supabaseRequest(
      supabaseConfig,
      `tracking_settings?organization_id=eq.${organizationId}&project_key=eq.${projectKey}&limit=1`
    );
  } else if (organizationId) {
    // Organization-level settings
    // eslint-disable-next-line deprecation/deprecation
    return await supabaseRequest(
      supabaseConfig,
      `tracking_settings?organization_id=eq.${organizationId}&project_key=is.null&limit=1`
    );
  } else {
    // eslint-disable-next-line deprecation/deprecation
    return await supabaseRequest(
      supabaseConfig,
      'tracking_settings?organization_id=is.null&limit=1'
    );
  }
}

/**
 * Save tracking/timesheet settings to Supabase
 * Can save at project-level or organization-level
 * Only admins/project admins can save these settings
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for multi-tenancy
 * @param {Object} settings - Tracking settings object
 * @param {string} projectKey - Optional Jira project key for project-specific settings
 * @returns {Promise<void>}
 */
export async function saveTrackingSettings(accountId, cloudId, settings, projectKey = null) {
  // Check if user is Jira Administrator or Project Admin
  const isAdmin = await isJiraAdmin();
  const permissions = await checkUserPermissions(['ADMINISTER_PROJECTS']);
  const isProjectAdmin = permissions.permissions?.ADMINISTER_PROJECTS?.havePermission;

  if (!isAdmin && !isProjectAdmin) {
    throw new Error('Access denied: Only Jira Administrators or Project Administrators can configure tracking settings');
  }

  // eslint-disable-next-line deprecation/deprecation
  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    throw new Error('Supabase not configured. Please configure in Settings first.');
  }

  // Validate settings
  validateTrackingSettings(settings);

  // Get organization and user IDs for multi-tenancy
  const { organizationId, userId } = await resolveOrganizationAndUser(supabaseConfig, cloudId, accountId);

  // Prepare data for Supabase
  const trackingData = {
    organization_id: organizationId,
    project_key: projectKey || null,  // NULL for org-wide settings
    screenshot_monitoring_enabled: settings.screenshotMonitoringEnabled,
    screenshot_interval_seconds: settings.screenshotIntervalSeconds,
    tracking_mode: settings.intervalTrackingEnabled ? 'interval' : 'event',
    event_tracking_enabled: settings.eventTrackingEnabled,
    track_window_changes: settings.trackWindowChanges,
    track_idle_time: settings.trackIdleTime,
    idle_threshold_seconds: settings.idleThresholdSeconds,
    whitelist_enabled: settings.whitelistEnabled,
    whitelisted_apps: settings.whitelistedApps || [],
    blacklist_enabled: settings.blacklistEnabled,
    blacklisted_apps: settings.blacklistedApps || [],
    non_work_threshold_percent: settings.nonWorkThresholdPercent,
    flag_excessive_non_work: settings.flagExcessiveNonWork,
    private_sites_enabled: settings.privateSitesEnabled,
    private_sites: settings.privateSites || [],
    jira_worklog_sync_enabled: settings.jiraWorklogSyncEnabled ?? true,
    work_hours_start: settings.workHoursStart || '09:00',
    work_hours_end: settings.workHoursEnd || '18:00',
    work_days: settings.workDays || [1, 2, 3, 4, 5],
    updated_by: userId,
    updated_at: new Date().toISOString()
  };

  // Desktop admin password is org-level only (not project-specific)
  if (!projectKey && settings.desktopAdminPassword !== undefined) {
    trackingData.desktop_admin_password = settings.desktopAdminPassword;
  }

  // Check if settings already exist for this organization/project
  const existingSettings = await fetchExistingTrackingSettings(supabaseConfig, organizationId, projectKey);

  if (existingSettings && existingSettings.length > 0) {
    // Update existing settings
    const settingsId = existingSettings[0].id;
    // eslint-disable-next-line deprecation/deprecation
    await supabaseRequest(
      supabaseConfig,
      `tracking_settings?id=eq.${settingsId}`,
      { method: 'PATCH', body: trackingData }
    );
  } else {
    // Insert new settings
    trackingData.created_by = userId;
    trackingData.created_at = new Date().toISOString();
    // eslint-disable-next-line deprecation/deprecation
    await supabaseRequest(
      supabaseConfig,
      'tracking_settings',
      { method: 'POST', body: trackingData }
    );
  }

  // Keep application_classifications in sync with project/org app selections
  // saved in tracking settings so desktop project-level classification has rows.
  // Delete removed + upsert current run in parallel (disjoint entry sets)
  await Promise.all([
    deleteRemovedApplicationClassificationsFromTrackingSettings(
      supabaseConfig,
      {
        organizationId,
        projectKey,
        previousSettings: existingSettings?.[0] || {},
        whitelistedApps: trackingData.whitelisted_apps,
        blacklistedApps: trackingData.blacklisted_apps,
        privateSites: trackingData.private_sites
      }
    ),
    upsertApplicationClassificationsFromTrackingSettings(
      supabaseConfig,
      {
        organizationId,
        projectKey,
        userId,
        whitelistedApps: trackingData.whitelisted_apps,
        blacklistedApps: trackingData.blacklisted_apps,
        privateSites: trackingData.private_sites
      }
    )
  ]);

  const settingsLevel = projectKey ? `project ${projectKey}` : `org ${organizationId}`;
  console.log(`[TrackingSettings] Settings saved successfully for ${settingsLevel}`);
}
