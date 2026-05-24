/**
 * AI Prompts Module
 * Centralized storage for all AI prompts used in activity analysis
 *
 * Benefits:
 * - Easy to update prompts without touching logic code
 * - Version control for prompt changes
 * - Reusable across different analyzers
 */

/**
 * Format user's assigned issues for inclusion in prompts
 * @param {Array} userAssignedIssues - Array of issue objects
 * @returns {string} Formatted issues text
 */
function formatAssignedIssues(userAssignedIssues) {
  if (!userAssignedIssues || userAssignedIssues.length === 0) {
    return 'None - track all work';
  }

  // Sort by recency (newest first) then limit to 50 issues
  const sorted = [...userAssignedIssues].sort((a, b) => {
    const aDate = a.updated ? new Date(a.updated).getTime() : 0;
    const bDate = b.updated ? new Date(b.updated).getTime() : 0;
    return bDate - aDate;
  });

  return sorted
    .slice(0, 50)
    .map(issue => {
      let issueText = `- ${issue.key}: ${issue.summary} (Status: ${issue.status})`;

      // Add priority as a tiebreaker signal for the LLM
      if (issue.priority) {
        issueText += ` [Priority: ${issue.priority}]`;
      }

      // Add recency signal so LLM deprioritizes stale issues
      if (issue.updated) {
        const daysAgo = Math.floor((Date.now() - new Date(issue.updated).getTime()) / 86400000);
        if (daysAgo > 14) {
          issueText += ` [Last updated: ${daysAgo} days ago — likely inactive]`;
        }
      }

      // Add description if available (provides important context)
      if (issue.description && issue.description.trim()) {
        // Truncate long descriptions to save tokens
        const desc = issue.description.length > 600
          ? issue.description.substring(0, 600) + '...'
          : issue.description;
        issueText += `\n  Description: ${desc}`;
      }

      // Add labels if available (helps with categorization)
      if (issue.labels && issue.labels.length > 0) {
        issueText += `\n  Labels: ${issue.labels.join(', ')}`;
      }

      return issueText;
    })
    .join('\n');
}

/**
 * System prompt for app identification
 * Used when admin searches for an app and psutil can't find it,
 * LLM identifies the executable/process name.
 */
const APP_IDENTIFICATION_SYSTEM_PROMPT = `You are an expert at identifying software applications, developer tools, and web services used in professional work environments. You have comprehensive knowledge of:

1. **Desktop Applications**: Native apps like VS Code (code.exe), Slack (slack.exe), Zoom (zoom.exe), Microsoft Office apps, Adobe Creative Suite, etc.

2. **Developer Tools**: IDEs (IntelliJ, PyCharm, WebStorm), terminals (iTerm, Windows Terminal, Hyper), database tools (DBeaver, pgAdmin, MongoDB Compass), API clients (Postman, Insomnia), etc.

3. **Web-Based Platforms & SaaS Tools**: Modern development platforms (Lovable, Replit, CodeSandbox, StackBlitz), design tools (Figma, Canva), project management (Jira, Trello, Asana, Linear), documentation (Notion, Confluence), AI assistants (ChatGPT, Claude, Cursor), etc.

4. **Browser-Based Apps**: Tools accessed through browsers like Chrome, Firefox, Edge - identified by their domain name when they're primarily web-based.

Your task is to identify applications from partial names, common abbreviations, or informal references that users might search for.

IMPORTANT: Always try to identify the application. Users search for tools they know exist - your job is to figure out what they mean. Respond ONLY with valid JSON.`;

/**
 * Build prompt for app identification
 */
function buildAppIdentificationPrompt(searchTerm) {
  return `Identify the software application matching: "${searchTerm}"

Think about what application the user is likely referring to. Consider:
- Partial name matches (e.g., "notion" → Notion, "code" → VS Code)
- Common abbreviations (e.g., "vsc" → VS Code, "pycharm" → PyCharm)
- Product names (e.g., "lovable" → Lovable AI Dev Platform, "cursor" → Cursor IDE)
- Web services (e.g., "figma" → Figma, "chatgpt" → ChatGPT)

For the identifier field:
- Desktop apps (Windows): Use the executable name WITH .exe extension (e.g., "code.exe", "slack.exe", "notion.exe")
- Browser applications: Chrome, Firefox, Edge, Brave, etc. are desktop apps - use "chrome.exe", "firefox.exe", "msedge.exe", "brave.exe"
- Web-based SaaS apps: Apps accessed via browser (Figma, ChatGPT, Lovable) use lowercase service name without .exe (e.g., "figma", "chatgpt", "lovable")

IMPORTANT: When identifying a browser like Chrome, Firefox, or Edge, always return the executable name with .exe extension.

Examples:
- "chrome" → {"identified": true, "identifier": "chrome.exe", "display_name": "Google Chrome", "confidence": 0.95}
- "firefox" → {"identified": true, "identifier": "firefox.exe", "display_name": "Mozilla Firefox", "confidence": 0.95}
- "edge" → {"identified": true, "identifier": "msedge.exe", "display_name": "Microsoft Edge", "confidence": 0.95}
- "brave" → {"identified": true, "identifier": "brave.exe", "display_name": "Brave Browser", "confidence": 0.95}
- "slack" → {"identified": true, "identifier": "slack.exe", "display_name": "Slack", "confidence": 0.95}
- "vscode" → {"identified": true, "identifier": "code.exe", "display_name": "Visual Studio Code", "confidence": 0.95}
- "figma" → {"identified": true, "identifier": "figma", "display_name": "Figma", "confidence": 0.95}
- "lovable" → {"identified": true, "identifier": "lovable", "display_name": "Lovable", "confidence": 0.9}
- "chatgpt" → {"identified": true, "identifier": "chatgpt", "display_name": "ChatGPT", "confidence": 0.95}
- "cursor" → {"identified": true, "identifier": "cursor.exe", "display_name": "Cursor", "confidence": 0.95}
- "postman" → {"identified": true, "identifier": "postman.exe", "display_name": "Postman", "confidence": 0.95}

Return ONLY valid JSON:
{
  "identified": true or false,
  "identifier": "executable name OR service name (lowercase)",
  "display_name": "User-friendly display name",
  "confidence": 0.0-1.0
}

Only return {"identified": false, "identifier": null, "display_name": null, "confidence": 0} if the search term is completely unrecognizable or nonsensical.`;
}

module.exports = {
  formatAssignedIssues,
  APP_IDENTIFICATION_SYSTEM_PROMPT,
  buildAppIdentificationPrompt
};
