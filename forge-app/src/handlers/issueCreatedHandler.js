import api, { route } from '@forge/api';

/**
 * Checks if the ADF content is effectively empty or missing.
 * @param {Object|string} content
 * @returns {boolean}
 */
function isDescriptionEmpty(content) {
  if (!content) return true;
  if (typeof content === 'string') return content.trim().length === 0;
  
  // Basic ADF validation: if it's an object, try to extract text
  let text = '';
  function extractText(node) {
    if (node.type === 'text') {
      text += node.text || '';
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        extractText(child);
      }
    }
  }
  
  extractText(content);
  return text.trim().length === 0;
}

export const handler = async (event, context) => {
  console.log('Received avi:jira:created:issue event', event);
  
  try {
    const issueId = event.issue.id;
    const creatorId = event.associatedUsers?.[0]?.accountId; // Usually the creator is the first associated user
    
    // Fetch full issue details to get the description properly
    const issueRes = await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}`);
    
    if (!issueRes.ok) {
      console.error(`Failed to fetch issue ${issueId}`, await issueRes.text());
      return;
    }
    
    const issueData = await issueRes.json();
    const description = issueData.fields?.description;
    
    if (isDescriptionEmpty(description)) {
      console.log(`Issue ${issueId} created without a description. Posting a warning comment.`);
      
      const mentionText = creatorId ? `[~accountId:${creatorId}]` : 'Hello';
      
      // Construct an ADF comment
      const commentBody = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '🔴 '
              },
              ...(creatorId ? [{
                type: 'mention',
                attrs: {
                  id: creatorId,
                  text: '@user',
                  accessLevel: ''
                }
              }] : [{
                type: 'text',
                text: 'Creator'
              }]),
              {
                type: 'text',
                text: ', this ticket was created without a description. Please add details to help the team understand the requirements!'
              }
            ]
          }
        ]
      };
      
      const commentRes = await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}/comment`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          body: commentBody
        })
      });
      
      if (!commentRes.ok) {
        console.error('Failed to post comment', await commentRes.text());
      } else {
        console.log('Successfully posted empty description warning comment.');
      }
    } else {
      console.log(`Issue ${issueId} has a description. No action needed.`);
    }
  } catch (err) {
    console.error('Error handling issue creation:', err);
  }
};
