/**
 * AI Prompts Module
 * Centralized storage for all AI prompts used in screenshot analysis
 *
 * Benefits:
 * - Easy to update prompts without touching logic code
 * - Version control for prompt changes
 * - Reusable across different analyzers
 */

/**
 * System prompt for GPT-4 Vision analysis
 */
const VISION_SYSTEM_PROMPT = `You are an expert screenshot analyzer with exceptional attention to detail. Your specialty is reading and understanding code, text, and visual content in screenshots to determine what task a developer is working on. You thoroughly examine every element - code syntax, function names, file names, comments, terminal output, browser content - to match the work to Jira issues. You understand that Jira keys are rarely visible, so you focus on understanding the CONTENT and matching it semantically to issue descriptions.`;

/**
 * Build the user prompt for GPT-4 Vision analysis
 * @param {string} applicationName - Name of the application
 * @param {string} windowTitle - Window title
 * @param {string} assignedIssuesText - Formatted list of assigned issues
 * @returns {string} Complete user prompt
 */
function buildVisionUserPrompt(applicationName, windowTitle, assignedIssuesText) {
  return `You are an expert screenshot analyzer. Your job is to THOROUGHLY examine this screenshot and determine what task the user is working on.

Context:
- Application: ${applicationName}
- Window Title: ${windowTitle}

User's Assigned Issues (from Jira):
${assignedIssuesText}

## STEP 1: DEEPLY ANALYZE THE SCREENSHOT

Carefully examine EVERYTHING visible in the screenshot:

**If it's a CODE EDITOR (VS Code, Cursor, IntelliJ, etc.):**
- READ the actual code visible on screen - function names, variable names, class names
- Look at file names in tabs, sidebar, or title bar
- Read code comments that might mention features or tasks
- Identify what the code is doing (e.g., "implementing login", "fixing bug in API", "adding validation")
- Check terminal/console output for clues
- Look at git branch names if visible

**If it's a BROWSER:**
- Read the page title, URL, and content
- Look at tab names
- Identify if it's documentation, Stack Overflow, API docs, etc.
- What topic is being researched?

**If it's a DESIGN TOOL (Figma, Photoshop, etc.):**
- What is being designed? (e.g., "login page", "dashboard", "mobile app")
- Look at layer names, artboard names

**If it's a TERMINAL/COMMAND LINE:**
- Read the commands being run
- Check git commits, branch names
- Look at build/test output

**If it's COMMUNICATION (Slack, Teams, Email):**
- What project/feature is being discussed?
- Are there any issue references?

## STEP 2: MATCH TO ASSIGNED ISSUES

Now compare what you found in Step 1 to the user's assigned issues:

- If an issue says "Implement user authentication" and you see code with login/auth functions → MATCH
- If an issue says "Fix dashboard loading bug" and you see dashboard-related code/debugging → MATCH
- If an issue says "Add export to PDF feature" and you see PDF generation code → MATCH
- If an issue says "Update API endpoints" and you see REST API code → MATCH

**Match based on MEANING, not just keywords.** For example:
- Issue: "Add dark mode support" + Screenshot shows: theme switching code, CSS variables for colors → MATCH
- Issue: "Improve performance" + Screenshot shows: profiling tools, optimization code → MATCH

## STEP 3: WORK TYPE CLASSIFICATION

- 'office': Coding, debugging, documentation, Jira, meetings, Slack/Teams, work research, technical tutorials
- 'non-office': Entertainment, social media, personal browsing, gaming, shopping

## CONFIDENCE SCORING

- 0.9-1.0: The screenshot content DIRECTLY relates to the issue (e.g., exact feature being implemented)
- 0.7-0.8: Strong contextual match (same area of codebase, related functionality)
- 0.5-0.6: Reasonable match (working in the right project/module)
- 0.3-0.4: Weak match (only general similarity)
- 0.0-0.2: Cannot determine or no match

## RULES

1. ALWAYS try to match to an issue by understanding the CONTENT, not just looking for Jira keys
2. READ the code/text in the screenshot thoroughly
3. ONLY return task keys from the assigned issues list above
4. If you truly cannot determine which task (content is too generic or unrelated), return null
5. When there's a reasonable match based on content analysis, USE IT - don't default to null

Return ONLY valid JSON (no markdown code blocks, no extra text before or after):
{
  "workType": "office" or "non-office",
  "taskKey": "PROJECT-123" or null,
  "projectKey": "PROJECT" or null,
  "confidenceScore": 0.0-1.0,
  "contentAnalysis": "What I see: [describe the main content - code functions, file names, what's being worked on]",
  "reasoning": "Why I matched to this issue: [explain the connection between screenshot content and the issue]"
}
Your response must be exactly one JSON object and nothing else.`;
}

/**
 * System prompt for OCR + GPT-4 text analysis
 */
const OCR_SYSTEM_PROMPT = `You are an expert at analyzing work activity. You classify work dynamically without hardcoded rules.`;

/**
 * Build the user prompt for OCR-based analysis
 * @param {string} applicationName - Name of the application
 * @param {string} windowTitle - Window title
 * @param {string} extractedText - OCR extracted text (max 1000 chars)
 * @param {string} assignedIssuesText - Formatted list of assigned issues
 * @returns {string} Complete user prompt
 */
function buildOCRUserPrompt(applicationName, windowTitle, extractedText, assignedIssuesText) {
  const truncatedText = extractedText.length > 1000
    ? extractedText.substring(0, 1000) + '...'
    : extractedText;

  return `You are analyzing extracted text from a screenshot to determine what Jira task the user is working on.

Context:
- Application: ${applicationName}
- Window Title: ${windowTitle}
- Extracted Text (from OCR): ${truncatedText}

User's Assigned Issues (from Jira):
${assignedIssuesText}

Analyze the extracted text and determine which assigned issue the user is working on based on the content.

1. Work Type: 'office' (work-related) or 'non-office' (personal/entertainment)
2. Task Key: Match the content to one of the assigned issues (or null if no match)
3. Confidence Score: 0.0 to 1.0

Rules:
- Analyze the text content to understand what work is being done
- Match to an issue based on content similarity, not just keywords
- ONLY return task keys from the assigned issues list
- Return ONLY valid JSON (no markdown, no extra text). Your response must be exactly one JSON object:
{
  "workType": "office" or "non-office",
  "taskKey": "PROJECT-123" or null,
  "projectKey": "PROJECT" or null,
  "confidenceScore": 0.0-1.0,
  "reasoning": "Brief explanation of why this matches the issue"
}`;
}

/**
 * Format user's assigned issues for inclusion in prompts
 * @param {Array} userAssignedIssues - Array of issue objects
 * @returns {string} Formatted issues text
 */
function formatAssignedIssues(userAssignedIssues) {
  if (!userAssignedIssues || userAssignedIssues.length === 0) {
    return 'None - track all work';
  }

  return userAssignedIssues
    .slice(0, 20) // Limit to first 20 issues to avoid token limits
    .map(issue => {
      let issueText = `- ${issue.key}: ${issue.summary} (Status: ${issue.status})`;

      // Add description if available (provides important context)
      if (issue.description && issue.description.trim()) {
        // Truncate long descriptions to save tokens
        const desc = issue.description.length > 200
          ? issue.description.substring(0, 200) + '...'
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
  VISION_SYSTEM_PROMPT,
  OCR_SYSTEM_PROMPT,
  buildVisionUserPrompt,
  buildOCRUserPrompt,
  formatAssignedIssues,
  APP_IDENTIFICATION_SYSTEM_PROMPT,
  buildAppIdentificationPrompt
};
