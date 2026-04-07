/**
 * Personal Data Service
 * Handles personal data export and deletion requests from Atlassian
 * Implements Atlassian's Personal Data Reporting API (GDPR compliance)
 * 
 * @module services/personalDataService
 */

import { invokeRemote } from '@forge/api';

// Remote key from manifest.yml - must match exactly
const REMOTE_KEY = 'ai-server';

/**
 * Main handler for personal data requests
 * Called by Atlassian when a user requests data export or deletion
 * Implements the 7-day polling cycle
 * 
 * @param {Object} event - Personal data request event
 * @param {Object} event.payload - Request payload
 * @param {string} event.payload.accountId - Atlassian account ID
 * @param {string} event.payload.cloudId - Jira cloud instance ID
 * @param {string} event.payload.requestType - 'export' or 'delete'
 * @returns {Promise<Object>} Response with status and data/error
 */
export async function handlePersonalDataRequest(event) {
  console.log('[PersonalData] Request received:', {
    accountId: event.payload?.accountId?.substring(0, 10) + '...',
    cloudId: event.payload?.cloudId,
    requestType: event.payload?.requestType,
    timestamp: new Date().toISOString()
  });

  const { accountId, cloudId, requestType } = event.payload || {};

  // Validate request
  if (!accountId || !cloudId || !requestType) {
    console.error('[PersonalData] Invalid request - missing required fields');
    return {
      status: 'FAILED',
      error: 'Missing required fields: accountId, cloudId, or requestType'
    };
  }

  if (!['export', 'delete'].includes(requestType)) {
    console.error('[PersonalData] Invalid request type:', requestType);
    return {
      status: 'FAILED',
      error: `Invalid request type: ${requestType}. Must be 'export' or 'delete'`
    };
  }

  try {
    // Check existing request status
    const existingRequest = await checkRequestStatus(accountId, cloudId, requestType);

    if (existingRequest) {
      // Subsequent poll - return current status
      console.log('[PersonalData] Found existing request:', {
        requestId: existingRequest.id,
        status: existingRequest.status,
        requestedAt: existingRequest.requested_at
      });

      if (existingRequest.status === 'completed') {
        return formatCompletedResponse(existingRequest, requestType);
      } else if (existingRequest.status === 'failed') {
        return formatFailedResponse(existingRequest);
      } else {
        // Still processing
        return {
          status: 'PENDING',
          message: `Request is being processed. Request ID: ${existingRequest.id}`
        };
      }
    } else {
      // First poll - create new request
      // The AI server will handle processing asynchronously server-side
      console.log('[PersonalData] Creating new request');
      const newRequest = await createNewRequest(accountId, cloudId, requestType);

      // Immediately trigger processing server-side (awaited to ensure it's scheduled)
      await triggerProcessing(newRequest.id, accountId, cloudId, requestType);

      return {
        status: 'PENDING',
        message: `Request created and processing started. Request ID: ${newRequest.id}`
      };
    }
  } catch (error) {
    console.error('[PersonalData] Handler error:', error);
    return {
      status: 'FAILED',
      error: `Internal error: ${error.message}`
    };
  }
}

/**
 * Check if request already exists in database
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira cloud instance ID
 * @param {string} requestType - 'export' or 'delete'
 * @returns {Promise<Object|null>} Request object or null
 */
async function checkRequestStatus(accountId, cloudId, requestType) {
  try {
    const response = await invokeRemote(REMOTE_KEY, {
      path: '/api/v1/user-data/status',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ accountId, cloudId, requestType })
    });

    if (!response.ok) {
      console.error('[PersonalData] Status check failed:', response.status);
      return null;
    }

    const data = await response.json();
    // Updated to match standardized response shape
    return data.data?.request || data.request || null;
  } catch (error) {
    console.error('[PersonalData] Error checking status:', error);
    return null;
  }
}

/**
 * Create new request record in database
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira cloud instance ID
 * @param {string} requestType - 'export' or 'delete'
 * @returns {Promise<Object>} Created request object
 */
async function createNewRequest(accountId, cloudId, requestType) {
  const response = await invokeRemote(REMOTE_KEY, {
    path: '/api/v1/user-data/create-request',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ accountId, cloudId, requestType })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create request: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  // Updated to match standardized response shape
  return data.data?.request || data.request;
}

/**
 * Trigger processing server-side (awaited to ensure job is scheduled)
 * The AI server will process the request asynchronously after this call returns
 * @param {string} requestId - Request UUID
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira cloud instance ID
 * @param {string} requestType - 'export' or 'delete'
 * @returns {Promise<void>}
 */
async function triggerProcessing(requestId, accountId, cloudId, requestType) {
  const endpoint = requestType === 'export' 
    ? '/api/v1/user-data/export'
    : '/api/v1/user-data/delete';

  console.log('[PersonalData] Triggering server-side processing:', { requestId, requestType });

  try {
    const response = await invokeRemote(REMOTE_KEY, {
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ requestId, accountId, cloudId })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[PersonalData] Failed to trigger processing:', errorText);
      // Don't throw - let the request stay pending and get picked up by polling
    } else {
      console.log('[PersonalData] Processing triggered successfully:', requestId);
    }
  } catch (error) {
    console.error('[PersonalData] Error triggering processing:', error);
    // Don't throw - let the request stay pending
  }
}

/**
 * Format completed response for export/deletion
 * @param {Object} request - Request object from database
 * @param {string} requestType - 'export' or 'delete'
 * @returns {Object} Formatted response
 */
function formatCompletedResponse(request, requestType) {
  if (requestType === 'export') {
    return {
      status: 'COMPLETED',
      data: {
        downloadUrl: request.result_url,
        expiresAt: calculateExpiry(request.completed_at, 24), // 24hr expiry
        format: 'application/json',
        sizeBytes: request.result_data?.size_bytes || 0,
        recordCounts: request.result_data?.record_counts || {}
      }
    };
  } else {
    // Deletion
    return {
      status: 'COMPLETED',
      summary: {
        deletedAt: request.completed_at,
        recordsDeleted: request.result_data?.records_deleted || {},
        filesDeleted: request.result_data?.files_deleted || 0
      }
    };
  }
}

/**
 * Format failed response
 * @param {Object} request - Request object from database
 * @returns {Object} Formatted error response
 */
function formatFailedResponse(request) {
  return {
    status: 'FAILED',
    error: request.error_message || 'Unknown error occurred',
    failedAt: request.updated_at,
    retryCount: request.retry_count
  };
}

/**
 * Calculate expiry timestamp
 * @param {string} completedAt - Completion timestamp
 * @param {number} hoursFromNow - Hours from completion
 * @returns {string} ISO timestamp
 */
function calculateExpiry(completedAt, hoursFromNow) {
  const expiry = new Date(completedAt);
  expiry.setHours(expiry.getHours() + hoursFromNow);
  return expiry.toISOString();
}
