/**
 * Extract plain text from a Jira ADF (Atlassian Document Format) description.
 * Returns null if no description is present.
 *
 * Walks the ADF tree recursively so text inside lists, panels, table cells,
 * code blocks, etc. is extracted — not just text whose parent is a top-level
 * block. Without recursion this returns empty for the most common ADF shapes
 * (bulleted/numbered lists, tables, panels) and the matching improvements
 * that depend on description content silently don't apply.
 *
 * @param {Object|string|null} description
 * @returns {string|null}
 */
export function extractDescriptionText(description) {
  if (!description) return null;
  if (typeof description === 'string') return description;
  if (!description.content) return null;

  const parts = [];
  walk(description, parts);
  return parts.join(' ').trim() || null;
}

/**
 * Depth-first walk of an ADF node, pushing every leaf `text` value into `parts`.
 * Handles arbitrarily nested structures: paragraph → text, bulletList → listItem
 * → paragraph → text, table → tableRow → tableCell → paragraph → text, etc.
 */
function walk(node, parts) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'text' && typeof node.text === 'string' && node.text) {
    parts.push(node.text);
    return;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) walk(child, parts);
  }
}
