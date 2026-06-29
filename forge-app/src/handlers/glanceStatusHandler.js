import api, { route } from '@forge/api';
import { remoteRequest } from '../utils/remote.js';
import { 
  fetchIssueForAnalysis, 
  buildParentContext, 
  fetchImageAttachments, 
  fetchDocumentAttachments, 
  fetchLinkedIssuesContext, 
  normalizeIssueType 
} from '../resolvers/descriptionResolvers.js';

export const glanceStatusHandler = async (req) => {
  try {
    const issueKey = req.context.extension.issue.key;
    if (!issueKey) return null;
    
    // Fetch exact same context as analyzeDescription to guarantee cache hit
    const { title, description, issueType, projectKey, parentKey, rawAttachments, rawIssueLinks } = await fetchIssueForAnalysis(issueKey);

    const [parentContext, attachments, documents, linkedIssues] = await Promise.all([
      buildParentContext(parentKey),
      fetchImageAttachments(rawAttachments),
      fetchDocumentAttachments(rawAttachments),
      fetchLinkedIssuesContext(rawIssueLinks)
    ]);

    const body = {
      issueKey,
      title,
      description,
      issueType: normalizeIssueType(issueType),
      projectKey,
      requestImprovement: false,
      parentContext,
      attachments,
      documents,
      linkedIssues,
      accountId: req.context.accountId,
      cloudId: req.context.cloudId
    };

    const data = await remoteRequest('/api/forge/description/analyze', {
      method: 'POST',
      body
    });

    const result = data || {};
    if (result.score !== undefined && result.score !== null) {
      let lozengeType = 'default';
      if (result.score >= 80) lozengeType = 'success';
      else if (result.score >= 50) lozengeType = 'moved';
      else lozengeType = 'removed';
      
      return {
        status: {
          type: 'lozenge',
          value: {
            label: `Score: ${result.score}`,
            type: lozengeType
          }
        }
      };
    }
    
    return null;
  } catch (e) {
    console.error('glanceStatusHandler error', e);
    return null;
  }
};
