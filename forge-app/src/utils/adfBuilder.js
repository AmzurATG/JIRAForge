/**
 * ADF (Atlassian Document Format) Builder
 *
 * Converts a small markdown subset to ADF (the JSON document format used by
 * the Jira Cloud REST v3 API), and converts ADF back to plain text so the
 * description can be sent to the AI server.
 *
 * Supported markdown:
 *   - Headings: # / ## / ###  → heading (level 1..3)
 *   - Bullet lists: lines starting with `- ` or `* `  → bulletList
 *   - Ordered lists: lines starting with `1. ` (any digits)  → orderedList
 *   - Blank-line-separated paragraphs
 *
 * Anything outside the subset is rendered as a plain paragraph. The builder
 * deliberately ignores inline marks (bold/italic/code) for v1 — those can be
 * added later without breaking the API surface.
 */

const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const BULLET_RE = /^\s*[-*]\s+(.+)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.+)$/;

function textNode(text) {
  return { type: 'text', text };
}

function paragraphNode(text) {
  return {
    type: 'paragraph',
    content: text.length > 0 ? [textNode(text)] : []
  };
}

function headingNode(level, text) {
  return {
    type: 'heading',
    attrs: { level },
    content: text.length > 0 ? [textNode(text)] : []
  };
}

function listItemNode(text) {
  return {
    type: 'listItem',
    content: [paragraphNode(text)]
  };
}

function bulletListNode(items) {
  return { type: 'bulletList', content: items.map(listItemNode) };
}

function orderedListNode(items) {
  return { type: 'orderedList', content: items.map(listItemNode) };
}

function pushParagraphBuffer(buffer, content) {
  if (buffer.length === 0) return;
  const text = buffer.join(' ').trim();
  if (text.length > 0) content.push(paragraphNode(text));
  buffer.length = 0;
}

function flushBulletList(items, content) {
  if (items.length === 0) return;
  content.push(bulletListNode(items));
  items.length = 0;
}

function flushOrderedList(items, content) {
  if (items.length === 0) return;
  content.push(orderedListNode(items));
  items.length = 0;
}

/**
 * Convert markdown text to a valid ADF document.
 * Always returns a document with at least one content node (an empty paragraph
 * if the input is blank), because Jira rejects empty ADF documents.
 *
 * @param {string} markdown
 * @returns {{version: 1, type: 'doc', content: Array}}
 */
export function markdownToADF(markdown) {
  const content = [];
  const text = typeof markdown === 'string' ? markdown : '';
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  let paraBuffer = [];
  let bulletBuffer = [];
  let orderedBuffer = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.trim() === '') {
      pushParagraphBuffer(paraBuffer, content);
      flushBulletList(bulletBuffer, content);
      flushOrderedList(orderedBuffer, content);
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      pushParagraphBuffer(paraBuffer, content);
      flushBulletList(bulletBuffer, content);
      flushOrderedList(orderedBuffer, content);
      content.push(headingNode(headingMatch[1].length, headingMatch[2].trim()));
      continue;
    }

    const orderedMatch = ORDERED_RE.exec(line);
    if (orderedMatch) {
      pushParagraphBuffer(paraBuffer, content);
      flushBulletList(bulletBuffer, content);
      orderedBuffer.push(orderedMatch[1].trim());
      continue;
    }

    const bulletMatch = BULLET_RE.exec(line);
    if (bulletMatch) {
      pushParagraphBuffer(paraBuffer, content);
      flushOrderedList(orderedBuffer, content);
      bulletBuffer.push(bulletMatch[1].trim());
      continue;
    }

    pushParagraphBuffer(paraBuffer, content); // safe no-op when empty
    flushBulletList(bulletBuffer, content);
    flushOrderedList(orderedBuffer, content);
    paraBuffer.push(line.trim());
  }

  pushParagraphBuffer(paraBuffer, content);
  flushBulletList(bulletBuffer, content);
  flushOrderedList(orderedBuffer, content);

  if (content.length === 0) {
    content.push(paragraphNode(''));
  }

  return { version: 1, type: 'doc', content };
}

/**
 * Best-effort validation of an ADF document. Returns true if the basic
 * shape is correct; this is intended as a sanity check before sending the
 * document to Jira, not a full schema validator.
 *
 * @param {*} adf
 * @returns {boolean}
 */
export function validateADF(adf) {
  if (!adf || typeof adf !== 'object') return false;
  if (adf.type !== 'doc') return false;
  if (adf.version !== 1) return false;
  if (!Array.isArray(adf.content) || adf.content.length === 0) return false;
  return adf.content.every(node => node && typeof node.type === 'string');
}

/**
 * Extract all top-level media nodes (mediaSingle, mediaGroup) from an ADF
 * document. These nodes contain inline image/file references that must be
 * preserved when the description text is rewritten by AI.
 *
 * @param {*} adf - The original ADF document
 * @returns {Array} Array of mediaSingle/mediaGroup nodes (empty if none found)
 */
export function extractMediaNodes(adf) {
  if (!adf || !Array.isArray(adf.content)) return [];
  return adf.content.filter(
    node => node && (node.type === 'mediaSingle' || node.type === 'mediaGroup')
  );
}

/**
 * Extract plain text from an ADF document. Used to convert a Jira
 * description back to text so the AI server can analyze it.
 *
 * @param {*} adf
 * @returns {string}
 */
export function adfToText(adf) {
  if (!adf || typeof adf !== 'object') return '';

  const lines = [];

  function walk(node, listPrefix) {
    if (!node) return;
    switch (node.type) {
      case 'doc':
      case 'blockquote':
        (node.content || []).forEach(child => walk(child, listPrefix));
        break;
      case 'heading': {
        const level = (node.attrs && node.attrs.level) || 1;
        const t = extractInline(node);
        lines.push(`${'#'.repeat(Math.min(3, Math.max(1, level)))} ${t}`);
        lines.push('');
        break;
      }
      case 'paragraph': {
        const t = extractInline(node);
        if (listPrefix) {
          lines.push(`${listPrefix}${t}`);
        } else {
          if (t.length > 0) lines.push(t);
          lines.push('');
        }
        break;
      }
      case 'bulletList':
        (node.content || []).forEach(item => walk(item, '- '));
        lines.push('');
        break;
      case 'orderedList':
        (node.content || []).forEach((item, idx) => walk(item, `${idx + 1}. `));
        lines.push('');
        break;
      case 'listItem':
        (node.content || []).forEach(child => walk(child, listPrefix));
        break;
      case 'codeBlock': {
        const t = extractInline(node);
        lines.push('```');
        lines.push(t);
        lines.push('```');
        break;
      }
      default:
        if (Array.isArray(node.content)) {
          node.content.forEach(child => walk(child, listPrefix));
        }
    }
  }

  function extractInline(node) {
    if (!node || !Array.isArray(node.content)) return '';
    return node.content.map(child => {
      if (child.type === 'text') return child.text || '';
      if (child.type === 'hardBreak') return '\n';
      if (Array.isArray(child.content)) return extractInline(child);
      return '';
    }).join('');
  }

  walk(adf, null);

  // Collapse 3+ consecutive blank lines into one.
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
