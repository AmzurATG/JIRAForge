/**
 * Description Scores Resolvers
 * Handlers for bulk description quality score retrieval and lazy filling
 */

import { initializeRequestContext, handleResolverError } from './unassigned/helpers.js';
import { remoteRequest, supabaseQuery } from '../utils/remote.js';
import { isValidIssueKey } from '../utils/validators.js';
import {
  fetchIssueForAnalysis,
  buildParentContext,
  fetchImageAttachments,
  fetchDocumentAttachments,
  fetchLinkedIssuesContext,
  normalizeIssueType
} from './descriptionResolvers.js';

function failure(message) {
  return { success: false, error: message };
}

/**
 * Register description scores resolvers
 * @param {Resolver} resolver - Forge resolver instance
 */
export function registerDescriptionScoresResolvers(resolver) {
  /**
   * Fast cache-only score lookup.
   * Gets scores for issueKeys that are already cached in Supabase.
   */
  resolver.define('getDescriptionScores', async (req) => {
    const { payload } = req;
    const issueKeys = payload?.issueKeys;

    if (!Array.isArray(issueKeys)) {
      return failure('issueKeys must be an array');
    }

    if (issueKeys.length > 50) {
      return failure('Cannot batch more than 50 issue keys');
    }

    const validKeys = issueKeys.filter(isValidIssueKey);
    if (validKeys.length === 0) {
      return { success: true, scores: {} };
    }

    try {
      const ctx = await initializeRequestContext(req);
      if (!ctx.success) return ctx;

      const { organization } = ctx;

      const data = await supabaseQuery('description_quality_cache', {
        method: 'GET',
        query: {
          eq: { org_id: organization.id },
          in: { issue_key: validKeys },
          _select: 'issue_key,score,source,updated_at'
        }
      });

      const scores = {};
      const rows = data?.data || data || [];
      for (const row of rows) {
        if (row && row.issue_key) {
          scores[row.issue_key] = {
            score: row.score,
            source: row.source,
            cached: true,
            cachedAt: row.updated_at
          };
        }
      }

      return {
        success: true,
        scores
      };
    } catch (err) {
      console.error('[descriptionScoresResolvers] getDescriptionScores failed:', err.message);
      return failure(err.message || 'Failed to get description scores');
    }
  });

  /**
   * Bulk-fills cache misses by querying Jira and running analysis on the AI server.
   */
  resolver.define('fillDescriptionScores', async (req) => {
    const { payload, context } = req;
    const issueKeys = payload?.issueKeys;

    if (!Array.isArray(issueKeys)) {
      return failure('issueKeys must be an array');
    }

    if (issueKeys.length > 50) {
      return failure('Cannot fill more than 50 issue keys at once');
    }

    const validKeys = issueKeys.filter(isValidIssueKey);
    if (validKeys.length === 0) {
      return { success: true, scores: {} };
    }

    try {
      const ctx = await initializeRequestContext(req);
      if (!ctx.success) return ctx;

      const { organization, accountId, cloudId } = ctx;

      console.log(`[descriptionScoresResolvers] fillDescriptionScores: fetching details for ${validKeys.length} issues`);

      // Fetch issue details from Jira in parallel
      const fetchedIssues = await Promise.all(
        validKeys.map(async (key) => {
          try {
            const { title, description, issueType, projectKey, parentKey, rawAttachments, rawIssueLinks } = await fetchIssueForAnalysis(key);

            // Fetch attachments, parent context, etc. in parallel
            const [parentContext, attachments, documents, linkedIssues] = await Promise.all([
              buildParentContext(parentKey),
              fetchImageAttachments(rawAttachments),
              fetchDocumentAttachments(rawAttachments),
              fetchLinkedIssuesContext(rawIssueLinks)
            ]);

            return {
              issueKey: key,
              title,
              description,
              issueType: normalizeIssueType(issueType),
              projectKey,
              parentContext,
              attachments,
              documents,
              linkedIssues
            };
          } catch (err) {
            console.warn(`[descriptionScoresResolvers] Skipping issue ${key} due to fetch error:`, err.message);
            return null;
          }
        })
      );

      const validIssues = fetchedIssues.filter(Boolean);
      if (validIssues.length === 0) {
        return { success: true, scores: {}, message: 'No issues could be fetched from Jira' };
      }

      console.log(`[descriptionScoresResolvers] Sending ${validIssues.length} issues to AI server for batch analysis`);

      const result = await remoteRequest('/api/forge/description/scores/batch', {
        method: 'POST',
        body: {
          issues: validIssues,
          accountId,
          cloudId
        }
      });

      return {
        success: true,
        scores: result?.scores || {},
        stats: result?.stats || {}
      };
    } catch (err) {
      console.error('[descriptionScoresResolvers] fillDescriptionScores failed:', err.message);
      return failure(err.message || 'Failed to fill description scores');
    }
  });
}
