/**
 * Extract plain text from a Jira ADF (Atlassian Document Format) description.
 * Returns null if no description is present.
 * @param {Object|string|null} description
 * @returns {string|null}
 */
export function extractDescriptionText(description) {
  if (!description) return null;
  if (typeof description === 'string') return description;
  // ADF format: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '...' }] }] }
  if (description.content) {
    const parts = [];
    for (const block of description.content) {
      for (const node of (block.content || [])) {
        if (node.type === 'text' && node.text) parts.push(node.text);
      }
    }
    return parts.join(' ').trim() || null;
  }
  return null;
}
