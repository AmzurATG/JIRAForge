const fs = require('fs');

const filepath = 'src/resolvers/descriptionResolvers.js';
const content = fs.readFileSync(filepath, 'utf8');

const startStr = "  resolver.define('analyzeDescription', async (req) => {";
const endStr = "      return failure(`Analysis failed: ${err.message}`);\n    }\n  });";

const startIdx = content.indexOf(startStr);
const endIdx = content.indexOf(endStr) + endStr.length;

if (startIdx === -1 || content.indexOf(endStr) === -1) {
    console.log('Could not find boundaries');
    process.exit(1);
}

const newBlock = `  export const performDescriptionAnalysis = async (context, issueKey, requestImprovement) => {
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
      requestImprovement,
      parentContext,
      attachments,
      documents,
      linkedIssues,
      accountId: context?.accountId,
      cloudId: context?.cloudId
    };

    const data = await remoteRequest('/api/forge/description/analyze', {
      method: 'POST',
      body
    });

    const result = data || {};

    if (result.score !== undefined && result.score !== null) {
      try {
        const appId = process.env.FORGE_APP_ID || 'c8bab1dc-ae32-4e6f-9dbd-eb242cc6c14a';
        const appUuid = appId.split('/').pop();
        const propertyKey = \`com.atlassian.jira.issue:\${appUuid}:brd-dq-issue-glance:status\`;
        
        let lozengeType = 'default';
        if (result.score >= 80) lozengeType = 'success';
        else if (result.score >= 50) lozengeType = 'moved';
        else lozengeType = 'removed';
        
        const statusPayload = {
          type: 'lozenge',
          value: {
            label: \`Score: \${result.score}\`,
            type: lozengeType
          }
        };

        await api.asApp().requestJira(route\`/rest/api/3/issue/\${issueKey}/properties/\${propertyKey}\`, {
          method: 'PUT',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(statusPayload)
        });
      } catch (statusErr) {
        console.error('[descriptionResolvers] Failed to update glance status:', statusErr);
      }
    }

    return {
      success: true,
      issueKey,
      issueType: normalizeIssueType(issueType),
      originalTitle: title,
      originalDescription: description,
      score: result.score ?? null,
      source: result.source ?? null,
      cached: !!result.cached,
      issues: result.issues || [],
      suggestions: result.suggestions || [],
      improved_title: result.improved_title || null,
      improved_description: result.improved_description || null
    };
  };

  resolver.define('analyzeDescription', async (req) => {
    const { payload, context } = req;
    const issueKey = payload?.issueKey;
    const requestImprovement = !!payload?.requestImprovement;

    if (!issueKey || !isValidIssueKey(issueKey)) {
      return failure('Invalid or missing issueKey');
    }

    try {
      return await performDescriptionAnalysis(context, issueKey, requestImprovement);
    } catch (err) {
      console.error(\`[descriptionResolvers] Failed for \${issueKey}:\`, err);
      return failure(\`Analysis failed: \${err.message}\`);
    }
  });`;

const newContent = content.substring(0, startIdx) + newBlock + content.substring(endIdx);
fs.writeFileSync(filepath, newContent, 'utf8');
console.log('Successfully refactored descriptionResolvers.js');
