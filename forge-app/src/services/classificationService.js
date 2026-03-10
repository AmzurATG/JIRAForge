/**
 * Classification Service
 * Business logic for managing application classifications (productive/non_productive/private).
 * Follows the same pattern as projectSettingsService.js.
 */

import { isJiraAdmin, checkUserPermissions } from '../utils/jira.js';
// eslint-disable-next-line deprecation/deprecation
import { getSupabaseConfig, supabaseRequest, getOrCreateOrganization, getOrCreateUser } from '../utils/supabase.js';
import { remoteRequest } from '../utils/remote.js';

function normalizeIdentifier(identifier) {
  return (identifier || '')
    .toLowerCase()
    .replace(/\.(exe|app|dmg|msi|deb|rpm|snap|flatpak)$/i, '')
    .replaceAll(/[\s\-_.]+/g, '');
}

/**
 * Deduplicate classification entries that refer to the same real-world application
 * @param {Map} merged - Map of merged classification entries
 * @returns {Map} Deduplicated map
 */
function deduplicateClassifications(merged) {
  const deduped = new Map();
  for (const entry of merged.values()) {
    const normalized = normalizeIdentifier(entry.identifier);
    const dedupeKey = `${normalized}|${entry.match_by}|${entry.classification}`;
    const existing = deduped.get(dedupeKey);
    
    if (existing) {
      // Prefer higher-priority source; if equal, prefer one with display_name
      const sourcePriority = { project: 3, organization: 2, default: 1 };
      const existingPriority = sourcePriority[existing.source] || 0;
      const newPriority = sourcePriority[entry.source] || 0;
      
      if (newPriority > existingPriority || (newPriority === existingPriority && entry.display_name && !existing.display_name)) {
        deduped.set(dedupeKey, entry);
      }
    } else {
      deduped.set(dedupeKey, entry);
    }
  }
  return deduped;
}

/**
 * Update unknown activity records with new classification
 * @param {Object} supabaseConfig - Supabase configuration
 * @param {string} organizationId - Organization ID
 * @param {string} projectKey - Project key (optional)
 * @param {Object} data - Classification data
 * @returns {Promise<number>} Number of updated records
 */
async function updateUnknownActivityRecords(supabaseConfig, organizationId, projectKey, data) {
  try {
    const statusForClassification = data.classification === 'productive' ? 'pending' : 'analyzed';
    let activityBaseQuery =
      `activity_records?organization_id=eq.${organizationId}` +
      `&classification=eq.unknown` +
      `&application_name=eq.${encodeURIComponent(data.identifier)}`;

    if (projectKey) {
      activityBaseQuery += `&project_key=eq.${projectKey}`;
    }

    // Count affected rows before PATCH so UI can show a useful result.
    // eslint-disable-next-line deprecation/deprecation
    const unknownRows = await supabaseRequest(
      supabaseConfig,
      `${activityBaseQuery}&select=id&limit=1000`
    );
    const updatedCount = Array.isArray(unknownRows) ? unknownRows.length : 0;

    // eslint-disable-next-line deprecation/deprecation
    await supabaseRequest(
      supabaseConfig,
      activityBaseQuery,
      {
        method: 'PATCH',
        body: {
          classification: data.classification,
          status: statusForClassification
        }
      }
    );
    console.log(`[Classification] Updated unknown activity_records for ${data.identifier} → ${data.classification}`);
    return updatedCount;
  } catch (updateErr) {
    // Don't fail the main save path if activity backfill update fails.
    console.warn(
      `[Classification] Saved classification but failed to update existing unknown activity records for ${data.identifier}:`,
      updateErr.message
    );
    return 0;
  }
}

/**
 * Try psutil detection via desktop app
 * @param {string} desktopAppUrl - Desktop app URL
 * @param {string} searchTerm - Search term
 * @returns {Promise<Object|null>} Detection result or null
 */
async function tryPsutilDetection(desktopAppUrl, searchTerm) {
  if (!desktopAppUrl) {
    return null;
  }

  try {
    console.log('[Classification] Trying psutil detection via desktop app');
    const response = await fetch(`${desktopAppUrl}/api/search-running-app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search_term: searchTerm })
    });

    if (response.ok) {
      const result = await response.json();
      if (result?.success && result?.found && result?.best_match) {
        console.log(`[Classification] psutil found match: ${result.best_match.identifier}`);
        return {
          success: true,
          found: true,
          source: 'psutil',
          matches: result.matches,
          best_match: result.best_match
        };
      }
    }
  } catch (err) {
    console.log('[Classification] Desktop app not available (continuing):', err.message);
  }
  
  return null;
}

/**
 * Try LLM identification via AI server
 * @param {string} searchTerm - Search term
 * @returns {Promise<Object>} Identification result
 */
async function tryLLMIdentification(searchTerm) {
  try {
    console.log('[Classification Service] STEP 3: Falling back to LLM identification via AI server');
    console.log('[Classification Service] Calling remoteRequest to /api/identify-app with search_term:', searchTerm);
    const llmResult = await remoteRequest('/api/identify-app', {
      body: { search_term: searchTerm }
    });
    console.log('[Classification Service] LLM response:', JSON.stringify(llmResult, null, 2));

    if (llmResult?.identified) {
      console.log('[Classification Service] LLM successfully identified app:', llmResult.identifier);
      console.log('[Classification Service] ========== searchAppIdentifier END (LLM success) ==========');
      return {
        success: true,
        found: true,
        source: 'llm',
        matches: [{
          identifier: llmResult.identifier,
          display_name: llmResult.display_name,
          confidence: llmResult.confidence,
          source: 'llm'
        }],
        best_match: {
          identifier: llmResult.identifier,
          display_name: llmResult.display_name,
          confidence: llmResult.confidence,
          source: 'llm'
        }
      };
    }
    
    console.log('[Classification Service] LLM could not identify app');
    console.log('[Classification Service] ========== searchAppIdentifier END (LLM no match) ==========');
    return {
      success: true,
      found: false,
      source: 'none',
      matches: [],
      message: `Could not identify application matching "${searchTerm}"`
    };
  } catch (err) {
    console.error('[Classification Service] LLM identification error:', err.message);
    console.error('[Classification Service] Full error:', err);
    console.log('[Classification Service] ========== searchAppIdentifier END (LLM error) ==========');
    return {
      success: false,
      found: false,
      error: `Failed to identify application: ${err.message}`
    };
  }
}

/**
 * Get all application classifications for an organization/project
 * Returns global defaults + org overrides + project overrides
 * @param {string} projectKey - Jira project key (optional — null for org-level)
 * @param {string} cloudId - Jira Cloud ID for multi-tenancy
 * @param {string} accountId - Atlassian account ID
 * @returns {Promise<Array>} Array of classification objects
 */
export async function getClassifications(projectKey, cloudId, accountId) {
  try {
    // eslint-disable-next-line deprecation/deprecation
    const supabaseConfig = await getSupabaseConfig(accountId);
    if (!supabaseConfig) {
      console.log('[Classification] Supabase not configured');
      return [];
    }

    let organizationId = null;
    if (cloudId) {
      try {
        const org = await getOrCreateOrganization(cloudId, supabaseConfig);
        organizationId = org?.id;
      } catch (err) {
        console.log('[Classification] Could not get organization:', err.message);
        return [];
      }
    }

    // Fetch global defaults (organization_id IS NULL, is_default = true)
    // eslint-disable-next-line deprecation/deprecation
    const defaults = await supabaseRequest(
      supabaseConfig,
      'application_classifications?is_default=eq.true&organization_id=is.null&order=identifier.asc'
    );

    // Fetch org-level overrides
    let orgOverrides = [];
    if (organizationId) {
      // eslint-disable-next-line deprecation/deprecation
      orgOverrides = await supabaseRequest(
        supabaseConfig,
        `application_classifications?organization_id=eq.${organizationId}&project_key=is.null&order=identifier.asc`
      );
    }

    // Fetch project-level overrides
    let projectOverrides = [];
    if (organizationId && projectKey) {
      // eslint-disable-next-line deprecation/deprecation
      projectOverrides = await supabaseRequest(
        supabaseConfig,
        `application_classifications?organization_id=eq.${organizationId}&project_key=eq.${projectKey}&order=identifier.asc`
      );
    }

    // Merge: project overrides > org overrides > defaults
    const merged = new Map();

    // Add defaults first
    for (const entry of (defaults || [])) {
      const key = `${entry.identifier}|${entry.match_by}`;
      merged.set(key, { ...entry, source: 'default' });
    }

    // Org overrides replace defaults
    for (const entry of (orgOverrides || [])) {
      const key = `${entry.identifier}|${entry.match_by}`;
      merged.set(key, { ...entry, source: 'organization' });
    }

    // Project overrides replace org
    for (const entry of (projectOverrides || [])) {
      const key = `${entry.identifier}|${entry.match_by}`;
      merged.set(key, { ...entry, source: 'project' });
    }

    // Deduplicate entries that refer to the same real-world application
    // (e.g., "code.exe", "vscode", "Visual Studio Code" are all VS Code)
    const deduped = deduplicateClassifications(merged);

    const result = Array.from(deduped.values());
    console.log(`[Classification] Fetched ${result.length} classifications (${(defaults || []).length} defaults, ${(orgOverrides || []).length} org, ${(projectOverrides || []).length} project)`);
    return result;
  } catch (error) {
    console.error('[Classification] Error fetching classifications:', error);
    return [];
  }
}

/**
 * Save (upsert) an application classification
 * @param {Object} classification - Classification data
 * @param {string} projectKey - Jira project key (optional)
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} accountId - Atlassian account ID
 * @returns {Promise<Object>} Result
 */
export async function saveClassification(classification, projectKey, cloudId, accountId) {
  // Permission check
  const isAdmin = await isJiraAdmin();
  const permissions = await checkUserPermissions(['ADMINISTER_PROJECTS']);
  const isProjectAdmin = permissions.permissions?.ADMINISTER_PROJECTS?.havePermission;

  if (!isAdmin && !isProjectAdmin) {
    throw new Error('Access denied: Only Jira Administrators or Project Administrators can manage classifications');
  }

  // eslint-disable-next-line deprecation/deprecation
  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    throw new Error('Supabase not configured');
  }

  let organizationId = null;
  if (cloudId) {
    const org = await getOrCreateOrganization(cloudId, supabaseConfig);
    organizationId = org?.id;
  }
  if (!organizationId) {
    throw new Error('Organization not found');
  }

  // Input validation
  if (!classification.identifier?.trim()) {
    throw new Error('Classification identifier is required');
  }
  if (!classification.classification || !['productive', 'non_productive', 'private'].includes(classification.classification)) {
    throw new Error('Classification must be one of: productive, non_productive, private');
  }

  // Resolve Supabase user ID for created_by
  let userId = null;
  if (accountId) {
    try {
      userId = await getOrCreateUser(accountId, supabaseConfig, organizationId);
    } catch (err) {
      console.log('[Classification] Could not resolve user ID:', err.message);
    }
  }

  const data = {
    organization_id: organizationId,
    project_key: projectKey || null,
    identifier: classification.identifier.trim(),
    display_name: classification.displayName || classification.identifier,
    classification: classification.classification,
    match_by: classification.matchBy || 'process',
    is_default: false,
    created_by: userId || accountId,
    updated_at: new Date().toISOString()
  };

  // Check if exists
  let query = `application_classifications?organization_id=eq.${organizationId}&identifier=eq.${encodeURIComponent(data.identifier)}&match_by=eq.${data.match_by}`;
  if (projectKey) {
    query += `&project_key=eq.${projectKey}`;
  } else {
    query += '&project_key=is.null';
  }

  // eslint-disable-next-line deprecation/deprecation
  const existing = await supabaseRequest(supabaseConfig, query);

  if (existing && existing.length > 0) {
    // Update
    // eslint-disable-next-line deprecation/deprecation
    await supabaseRequest(
      supabaseConfig,
      `application_classifications?id=eq.${existing[0].id}`,
      { method: 'PATCH', body: data }
    );
    console.log(`[Classification] Updated: ${data.identifier} → ${data.classification}`);
  } else {
    // Insert
    data.created_at = new Date().toISOString();
    // eslint-disable-next-line deprecation/deprecation
    await supabaseRequest(
      supabaseConfig,
      'application_classifications',
      { method: 'POST', body: data }
    );
    console.log(`[Classification] Created: ${data.identifier} → ${data.classification}`);
  }

  // Reflect manual admin classification in existing unknown activity rows too.
  const updatedUnknownRecords = await updateUnknownActivityRecords(
    supabaseConfig,
    organizationId,
    projectKey,
    data
  );

  return {
    success: true,
    message: `Classification saved for ${data.identifier}`,
    updatedUnknownRecords
  };
}

/**
 * Delete an application classification (org/project override only — cannot delete defaults)
 * @param {string} classificationId - UUID of the classification to delete
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} accountId - Atlassian account ID
 * @returns {Promise<Object>} Result
 */
export async function deleteClassification(classificationId, cloudId, accountId) {
  const isAdmin = await isJiraAdmin();
  const permissions = await checkUserPermissions(['ADMINISTER_PROJECTS']);
  const isProjectAdmin = permissions.permissions?.ADMINISTER_PROJECTS?.havePermission;

  if (!isAdmin && !isProjectAdmin) {
    throw new Error('Access denied: Only administrators can delete classifications');
  }

  // eslint-disable-next-line deprecation/deprecation
  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    throw new Error('Supabase not configured');
  }

  // Verify it's not a default
  // eslint-disable-next-line deprecation/deprecation
  const existing = await supabaseRequest(
    supabaseConfig,
    `application_classifications?id=eq.${classificationId}&limit=1`
  );

  if (!existing || existing.length === 0) {
    throw new Error('Classification not found');
  }

  if (existing[0].is_default) {
    throw new Error('Cannot delete system default classifications. Create an org/project override instead.');
  }

  // eslint-disable-next-line deprecation/deprecation
  await supabaseRequest(
    supabaseConfig,
    `application_classifications?id=eq.${classificationId}`,
    { method: 'DELETE' }
  );

  console.log(`[Classification] Deleted classification ${classificationId}`);
  return { success: true, message: 'Classification deleted' };
}

/**
 * Get unknown apps (apps that have been flagged by desktop clients but not yet classified by admin)
 * These show up as activity_records with classification = 'unknown'
 * @param {string} projectKey - Jira project key (optional)
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} accountId - Atlassian account ID
 * @returns {Promise<Array>} Array of unique unknown app entries
 */
export async function getUnknownApps(projectKey, cloudId, accountId) {
  try {
    // eslint-disable-next-line deprecation/deprecation
    const supabaseConfig = await getSupabaseConfig(accountId);
    if (!supabaseConfig) return [];

    let organizationId = null;
    if (cloudId) {
      const org = await getOrCreateOrganization(cloudId, supabaseConfig);
      organizationId = org?.id;
    }
    if (!organizationId) return [];

    // Build a set of already-classified process identifiers (defaults + org + project).
    // Unknown queue should only show apps that are still unclassified.
    const classifications = await getClassifications(projectKey, cloudId, accountId);
    const classifiedProcessKeys = new Set(
      (classifications || [])
        .filter(c => c.match_by === 'process')
        .map(c => normalizeIdentifier(c.identifier))
    );

    // Get distinct unknown apps from activity_records
    // eslint-disable-next-line deprecation/deprecation
    const records = await supabaseRequest(
      supabaseConfig,
      `activity_records?organization_id=eq.${organizationId}&classification=eq.unknown&select=application_name,window_title,metadata&order=created_at.desc&limit=100`
    );

    if (!records || records.length === 0) return [];

    // Deduplicate by application_name
    const seen = new Map();
    for (const record of records) {
      const appName = record.application_name || '';
      const normalizedApp = normalizeIdentifier(appName);
      if (!normalizedApp || classifiedProcessKeys.has(normalizedApp)) {
        continue;
      }
      if (!seen.has(appName)) {
        seen.set(record.application_name, {
          applicationName: appName,
          lastWindowTitle: record.window_title,
          suggestedClassification: record.metadata?.suggestedClassification || null,
          confidence: record.metadata?.classificationConfidence || null,
          reasoning: record.metadata?.classificationReasoning || null
        });
      }
    }

    return Array.from(seen.values());
  } catch (error) {
    console.error('[Classification] Error fetching unknown apps:', error);
    return [];
  }
}

/**
 * Bulk import classifications (e.g., from CSV or admin paste)
 * @param {Array} classifications - Array of {identifier, displayName, classification, matchBy}
 * @param {string} projectKey - Project key (optional)
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} accountId - Atlassian account ID
 * @returns {Promise<Object>} Import result
 */
export async function bulkImportClassifications(classifications, projectKey, cloudId, accountId) {
  const isAdmin = await isJiraAdmin();
  if (!isAdmin) {
    throw new Error('Access denied: Only Jira Administrators can bulk import classifications');
  }

  let successCount = 0;
  let errorCount = 0;

  for (const classification of classifications) {
    try {
      await saveClassification(classification, projectKey, cloudId, accountId);
      successCount++;
    } catch (err) {
      errorCount++;
      console.error(`[Classification] Bulk import error for ${classification.identifier}:`, err.message);
    }
  }

  return {
    success: true,
    message: `Imported ${successCount} classifications, ${errorCount} errors`,
    imported: successCount,
    errors: errorCount
  };
}

/**
 * Search for an application identifier using multiple strategies:
 * 1. First check DB for existing classification
 * 2. If not found and desktopAppAvailable, ask desktop psutil
 * 3. If still not found, fallback to LLM identification
 *
 * @param {string} searchTerm - App name to search for
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} accountId - Atlassian account ID
 * @param {Object} options - Optional: { desktopAppUrl, projectKey }
 * @returns {Promise<Object>} Search result with identifier, display_name, source, etc.
 */
export async function searchAppIdentifier(searchTerm, cloudId, accountId, options = {}) {
  console.log('[Classification Service] ========== searchAppIdentifier START ==========');
  console.log('[Classification Service] Input params:', { searchTerm, cloudId, accountId: accountId?.substring(0, 10) + '...', options });

  const isAdmin = await isJiraAdmin();
  console.log('[Classification Service] isAdmin check:', isAdmin);
  if (!isAdmin) {
    throw new Error('Access denied: Only Jira Administrators can search for applications');
  }

  const normalizedSearchTerm = (searchTerm || '').trim().toLowerCase();
  if (normalizedSearchTerm.length < 2) {
    throw new Error('Search term must be at least 2 characters');
  }

  console.log(`[Classification Service] Searching for: "${searchTerm}" (normalized: "${normalizedSearchTerm}")`);

  // STEP 1: Check DB for existing classification
  try {
    // eslint-disable-next-line deprecation/deprecation
    const supabaseConfig = await getSupabaseConfig(accountId);
    if (supabaseConfig) {
      let organizationId = null;
      if (cloudId) {
        try {
          const org = await getOrCreateOrganization(cloudId, supabaseConfig);
          organizationId = org?.id;
        } catch (err) {
          console.log('[Classification] Could not get organization for DB search:', err.message);
        }
      }

      // Search in application_classifications
      // Use ilike for case-insensitive partial matching
      // PostgREST uses * as wildcard, not %
      const searchPattern = `*${normalizedSearchTerm}*`;
      let endpoint = `application_classifications?or=(identifier.ilike.${searchPattern},display_name.ilike.${searchPattern})&limit=5`;

      // eslint-disable-next-line deprecation/deprecation
      const dbResults = await supabaseRequest(supabaseConfig, endpoint);

      if (dbResults && dbResults.length > 0) {
        console.log(`[Classification] Found ${dbResults.length} DB matches for "${searchTerm}"`);
        return {
          success: true,
          found: true,
          source: 'database',
          matches: dbResults.map(r => ({
            identifier: r.identifier,
            display_name: r.display_name,
            classification: r.classification,
            source: 'database',
            confidence: 'high'
          })),
          best_match: {
            identifier: dbResults[0].identifier,
            display_name: dbResults[0].display_name,
            classification: dbResults[0].classification,
            source: 'database',
            confidence: 'high'
          }
        };
      }
    }
  } catch (err) {
    console.log('[Classification] DB search error (continuing):', err.message);
  }

  // STEP 2: If desktop app URL provided, try psutil detection
  const psutilResult = await tryPsutilDetection(options.desktopAppUrl, searchTerm);
  if (psutilResult) {
    return psutilResult;
  }

  // STEP 3: Fallback to LLM identification via AI server
  return await tryLLMIdentification(searchTerm);
}
