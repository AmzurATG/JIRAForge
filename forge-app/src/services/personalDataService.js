import { remoteRequest } from '../utils/remote.js';

/**
 * Handle Atlassian's Personal Data Reporting API requests.
 *
 * Atlassian polls this handler every ~7 days (up to 6 weeks) after a user
 * requests account deletion or data export. The handler must return one of:
 *   { status: 'PENDING' }   — still processing
 *   { status: 'COMPLETED' } — done (with optional summary)
 *   { status: 'FAILED', error: '...' }
 */
export async function handlePersonalDataRequest(event) {
  const { accountId, cloudId, requestType } = event?.payload ?? {};

  console.log('[PersonalData] Request received', {
    accountId: accountId ? accountId.substring(0, 10) + '...' : 'missing',
    cloudId,
    requestType
  });

  if (!accountId || !cloudId || !requestType) {
    console.error('[PersonalData] Missing required fields');
    return { status: 'FAILED', error: 'Missing required fields: accountId, cloudId, requestType' };
  }

  if (!['export', 'delete'].includes(requestType)) {
    console.error('[PersonalData] Invalid requestType:', requestType);
    return { status: 'FAILED', error: 'Invalid requestType. Must be "export" or "delete"' };
  }

  try {
    // Check if a request already exists in the DB
    const existing = await checkRequestStatus(accountId, cloudId, requestType);

    if (existing) {
      // Subsequent poll — return current status
      if (existing.status === 'completed') {
        console.log('[PersonalData] Request already completed', { requestType });
        return formatCompletedResponse(existing, requestType);
      }
      if (existing.status === 'failed') {
        console.warn('[PersonalData] Previous request failed, retrying');
        await triggerProcessing(existing.id, accountId, cloudId, requestType);
        return { status: 'PENDING' };
      }
      // pending or processing
      return { status: 'PENDING' };
    }

    // First poll — create a new request and kick off processing
    const newRequest = await createNewRequest(accountId, cloudId, requestType);
    await triggerProcessing(newRequest.id, accountId, cloudId, requestType);

    return { status: 'PENDING' };
  } catch (error) {
    console.error('[PersonalData] Handler error:', error);
    return { status: 'FAILED', error: 'Internal processing error' };
  }
}

/**
 * Check if a request already exists for this user + cloud + type
 */
async function checkRequestStatus(accountId, cloudId, requestType) {
  try {
    const data = await remoteRequest('/api/v1/user-data/status', {
      body: { accountId, cloudId, requestType }
    });
    return data?.request ?? null;
  } catch (error) {
    console.error('[PersonalData] Failed to check request status:', error.message);
    return null;
  }
}

/**
 * Create a new data request record in the DB
 */
async function createNewRequest(accountId, cloudId, requestType) {
  const data = await remoteRequest('/api/v1/user-data/create-request', {
    body: { accountId, cloudId, requestType }
  });
  console.log('[PersonalData] Created new request', { requestId: data.request?.id, requestType });
  return data.request;
}

/**
 * Trigger async processing (export or delete) on the AI server.
 * This is non-blocking — we return PENDING immediately and
 * Atlassian will poll again later to check completion.
 */
async function triggerProcessing(requestId, accountId, cloudId, requestType) {
  const endpoint = requestType === 'export'
    ? '/api/v1/user-data/export'
    : '/api/v1/user-data/delete';

  try {
    await remoteRequest(endpoint, {
      body: { requestId, accountId, cloudId }
    });
    console.log('[PersonalData] Processing triggered', { requestId, endpoint });
  } catch (error) {
    // Log but don't throw — the request is already created.
    // The AI server may still be processing; Atlassian will poll again.
    console.error('[PersonalData] Failed to trigger processing:', error.message);
  }
}

/**
 * Format a completed response for Atlassian
 */
function formatCompletedResponse(request, requestType) {
  const response = { status: 'COMPLETED' };

  if (request.result_data) {
    if (requestType === 'delete') {
      response.summary = {
        recordsDeleted: request.result_data.records_deleted,
        filesDeleted: request.result_data.files_deleted,
        deletedAt: request.result_data.deleted_at
      };
    } else if (requestType === 'export') {
      response.summary = {
        recordsExported: request.result_data.records_exported,
        exportUrl: request.result_data.export_url,
        expiresAt: request.result_data.expires_at
      };
    }
  }

  return response;
}
