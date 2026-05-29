/**
 * Activity Service
 * Handles text-only AI analysis for the new event-based activity tracking pipeline.
 * - analyzeBatch(): Matches productive activity records to Jira issues (single LLM call)
 * - classifyUnknownApp(): Classifies unknown applications via LLM
 * - identifyAppByName(): Identifies apps by search term using LLM (for admin app classification)
 *
 * Uses the Portkey-backed AI client. No vision model needed — all analysis is text-only.
 */

const { chatCompletionWithFallback, isActivityAIEnabled } = require('./ai/ai-client');
const { formatAssignedIssues, APP_IDENTIFICATION_SYSTEM_PROMPT, buildAppIdentificationPrompt } = require('./ai/prompts');
const activityDbService = require('./db/activity-db-service');
const logger = require('../utils/logger');

// ============================================================================
// SERVER-SIDE OCR TEXT SANITIZATION (Defense-in-depth)
// ============================================================================
// Desktop app applies privacy filtering before upload, but we add a second
// layer here to catch anything that slipped through before sending to the LLM.

/**
 * Regex patterns for sensitive data that should never reach the LLM.
 * These match common formats for passwords, API keys, tokens, and PII.
 */
const SANITIZATION_PATTERNS = [
  // Passwords in URLs or config strings: password=xxx, pwd=xxx, passwd=xxx
  // Bug #3 FIX: Only match = separator (not : which appears in prose)
  { pattern: /(?:password|passwd|pwd|secret|token)\s*=\s*\S+/gi, replacement: '[REDACTED_CREDENTIAL]' },
  // AWS access keys (AKIA...)
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED_AWS_KEY]' },
  // AWS secret keys (40 char base64)
  { pattern: /\b[A-Za-z0-9/+=]{40}\b(?=\s|$|[,;])/g, replacement: '[REDACTED_SECRET]' },
  // GitHub tokens (ghp_, gho_, ghs_, ghr_)
  { pattern: /\bgh[posru]_[A-Za-z0-9_]{36,255}\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  // Generic API keys (api_key=..., apikey=...)
  { pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*\S+/gi, replacement: '[REDACTED_API_KEY]' },
  // Bearer tokens
  { pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi, replacement: 'Bearer [REDACTED_TOKEN]' },
  // Credit card numbers in standard format (XXXX-XXXX-XXXX-XXXX or XXXX XXXX XXXX XXXX)
  // Bug #9 FIX: Only match separator format, not arbitrary 13-19 digit sequences
  { pattern: /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4,7}\b/g, replacement: '[REDACTED_CARD]' },
  // SSN (US format: XXX-XX-XXXX)
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED_SSN]' },
  // Private keys
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  // Connection strings with embedded passwords
  { pattern: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s:]+:[^\s@]+@[^\s]+/gi, replacement: '[REDACTED_CONNECTION_STRING]' },
  // Email addresses (flattened to avoid nested quantifier backtracking / ReDoS)
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}/gi, replacement: '[REDACTED_EMAIL]' },
  // Atlassian Account IDs (format: 712020:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
  { pattern: /\b\d{6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replacement: '[REDACTED_ATLASSIAN_ID]' },
  // Atlassian ARIs (ari:cloud:<product>::<resource>/<uuid>)
  { pattern: /ari:cloud:[a-z]+::[a-z]+\/[a-f0-9-]+/gi, replacement: '[REDACTED_ARI]' },
  // UUIDs in sensitive contexts only (userId, accountId, sessionId, orgId)
  // Bug #5 FIX: Only redact when preceded by sensitive labels, preserve UUIDs in URLs
  { pattern: /(?:user|account|session|org)Id[=:]\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, replacement: '[REDACTED_UUID]' },
];

/**
 * Sanitize OCR text server-side before sending to LLM.
 * This is a defense-in-depth measure — the desktop app's privacy filter
 * should have already redacted sensitive data, but we catch stragglers here.
 *
 * @param {string} text - OCR text to sanitize
 * @returns {string} Sanitized text
 */
function sanitizeOcrText(text) {
  if (!text) return text;
  let sanitized = text;
  for (const { pattern, replacement } of SANITIZATION_PATTERNS) {
    // Reset lastIndex for global regexes reused across calls
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

// ============================================================================
// PROMPTS
// ============================================================================

const BATCH_ANALYSIS_SYSTEM_PROMPT = `You are an expert at analyzing work activity from text. You match activity records to Jira issues based on window titles, application names, and OCR-extracted text. You focus on understanding the CONTENT and matching it semantically to issue descriptions. You understand that Jira keys may appear in window titles or extracted text.

MATCHING GUIDELINES:
1. If a window title or OCR text contains a Jira key (like ABC-123), prioritize that match
2. If the user is in a development tool (VS Code, IntelliJ, PyCharm, etc.) working on code related to a project, match to the most relevant "In Progress" issue from that project
3. If the window title mentions specific features (login, auth, UI, API, etc.), match to issues with similar features
4. When OCR text is unavailable (shows "no text extracted"), rely heavily on window title context
5. Browser activity on documentation, Stack Overflow, or technical sites related to an issue topic should be matched
6. Code editors with file/folder names visible in title should be matched based on what the code likely relates to

WHEN TO RETURN null (no match):
- Generic system activities: Task Manager, File Explorer (browsing files), Windows Settings, Control Panel, system utilities
- Generic browsing: download history, general search, social media, news sites (unless content clearly relates to an issue)
- Activities with NO semantic connection to any assigned issue — do NOT force-match just because the user has issues assigned
- When the only connection is that both are "technical" or "work-related" — that is NOT enough for a match

CRITICAL RULES:
- ONLY use task keys from the user's assigned issues list. NEVER invent or fabricate issue keys from OCR text, window titles, or any other source.
- Return null for taskKey when there is no clear semantic connection between the activity and a specific issue
- A match requires a meaningful content relationship, not just both being work-related

WORK TYPE CLASSIFICATION — READ CAREFULLY:
- "office" = ANY activity connected to work, regardless of whether a Jira task can be matched
- "non-office" = ONLY genuinely personal/non-work activity (social media, entertainment, personal browsing, gaming, shopping)
- taskKey and workType are INDEPENDENT fields. A team standup has taskKey=null AND workType="office".
- Do NOT conflate "no Jira match" with "non-office activity".

MEETING APPLICATIONS ARE ALWAYS workType="office":
- Google Meet (meet.google.com in URL or window title, or process Hangouts/Meet)
- Microsoft Teams (Teams.exe, teams.microsoft.com)
- Zoom (Zoom.exe, zoom.us)
- Webex, Slack Huddles, Discord in work context, any video conferencing tool
- Calendar apps showing meeting blocks
- Even if taskKey=null, meetings are ALWAYS "office"

Examples:
- Teams standup → taskKey=null, workType="office"
- Google Meet call → taskKey=null, workType="office"
- Zoom sprint review → taskKey=null, workType="office"
- Facebook during work hours → taskKey=null, workType="non-office"
- Personal YouTube video → taskKey=null, workType="non-office"

PROJECT KEY: Do NOT return projectKey — it is automatically derived from the matched taskKey (e.g., PROJ-123 → PROJ). You may omit it or set it to null; it will be overwritten server-side.

CONFIDENCE SCORING:
- 0.8-1.0: Direct match (Jira key visible, explicit feature match)
- 0.6-0.7: Strong contextual match (same project area, related functionality)
- 0.4-0.5: Reasonable match (working in project, related to general area)
- 0.2-0.3: Weak match (only project matches, specific task unclear)
- 0.0-0.1: No match possible

REASONING FIELD RULES:
- Maximum 80 characters per record. Hard limit.
- Use fragments, not sentences. No narration of your thought process.
- Examples of good reasoning values:
  - "Window title shows ABC-123"
  - "VS Code on api/ folder, related to API epic"
  - "Slack DM, no semantic match"
  - "Generic file explorer, no task connection"
- Do NOT restate the matching rules. Do NOT explain confidence math.`;

const APP_CLASSIFICATION_SYSTEM_PROMPT = `You are an expert at classifying desktop applications and websites into work categories. You determine whether an application is productive (work-related), non_productive (entertainment/personal), or private (sensitive personal data like banking, healthcare, passwords). You base your classification on the application name, window title, and any visible text content.`;

/**
 * Build the batch analysis prompt for multiple activity records.
 * Sends all records in a single prompt for efficient LLM usage.
 *
 * @param {Array} records - Activity records with OCR text
 * @param {string} assignedIssuesText - Formatted list of user's Jira issues
 * @returns {string} Complete user prompt
 */
function buildBatchAnalysisPrompt(records, assignedIssuesText, previousMatchContext, correctionPatterns) {
  const recordDescriptions = records.map((record, index) => {
    const ocrSnippet = record.ocr_text
      ? sanitizeOcrText(record.ocr_text.substring(0, 1000))
      : '(no text extracted)';

    // Flag low-confidence OCR - Bug #7 FIX: Exclude entirely when <0.4
    const ocrLabel = !record.ocr_text ? '(no text extracted)'
      : record.ocr_confidence && record.ocr_confidence < 0.4
        ? '(low-confidence OCR omitted - rely on window title and app name)'
        : `OCR Text: ${ocrSnippet}`;

    // Include tracking_mode if present (for idle records sent to LLM)
    const trackingMode = record.metadata?.tracking_mode
      ? `\n  Tracking Mode: ${record.metadata.tracking_mode}`
      : '';

    return `Record ${index}: [${record.application_name}] ${record.window_title}
  Time: ${record.total_time_seconds}s | ${record.start_time} → ${record.end_time}
  ${ocrLabel}${trackingMode}`;
  }).join('\n\n');

  // Build previous session context hint for cross-batch continuity (RC5)
  // Bug #4 FIX: Add guards for confidence, staleness, and relevance
  let previousSessionHint = '';
  if (previousMatchContext && previousMatchContext.taskKey) {
    // Guard 1: Confidence threshold - only use high-confidence previous matches
    if (previousMatchContext.confidenceScore < 0.7) {
      logger.debug('[Activity] Skipping low-confidence previous match (confidence=%s)', 
        previousMatchContext.confidenceScore);
      previousMatchContext = null;
    }
    
    // Guard 2: Staleness check - only use recent previous matches
    if (previousMatchContext && previousMatchContext.minutesAgo > 15) {
      logger.debug('[Activity] Previous match too stale (%d min ago), skipping', 
        previousMatchContext.minutesAgo);
      previousMatchContext = null;
    }
    
    // Guard 3: Relevance to current batch - only apply if current batch mentions same project
    if (previousMatchContext) {
      const currentBatchProjects = records
        .map(r => r.window_title?.match(/([A-Z]+)-\d+/)?.[1])
        .filter(Boolean);
      
      const previousProject = previousMatchContext.taskKey.split('-')[0];
      const isRelevant = currentBatchProjects.some(p => p === previousProject);
      
      if (!isRelevant && currentBatchProjects.length > 0) {
        logger.debug('[Activity] Previous match not relevant to current batch (prev=%s, current=%s)', 
          previousProject, currentBatchProjects.join(','));
        previousMatchContext = null;
      }
    }
  }
  
  // Only add hint if previousMatchContext survived all guards
  if (previousMatchContext && previousMatchContext.taskKey) {
    previousSessionHint = `\nPrevious session context: The user's most recent activity (${previousMatchContext.minutesAgo} min ago) was matched to ${previousMatchContext.taskKey} (confidence ${previousMatchContext.confidenceScore}). Consider this when evaluating ambiguous records — the user may still be working on the same task.\n`;
  }
  
  // Bug #8 FIX: Filter correction patterns to only include currently assigned issues
  let validCorrectionPatterns = correctionPatterns;
  if (validCorrectionPatterns && validCorrectionPatterns.length > 0) {
    // Extract issue keys from assignedIssuesText (format: "PROJ-123: Summary\n")
    const issueKeyMatches = assignedIssuesText.match(/([A-Z][A-Z0-9]+-\d+):/g);
    const validKeys = new Set(issueKeyMatches ? issueKeyMatches.map(k => k.replace(':', '')) : []);
    
    const filtered = validCorrectionPatterns.filter(p => validKeys.has(p.corrected_to));
    
    if (filtered.length === 0) {
      logger.debug('[Activity] All %d correction patterns reference stale issues, skipping', 
        validCorrectionPatterns.length);
      validCorrectionPatterns = null;
    } else if (filtered.length < validCorrectionPatterns.length) {
      logger.info('[Activity] Filtered %d stale correction patterns (kept %d valid)', 
        validCorrectionPatterns.length - filtered.length, 
        filtered.length);
      validCorrectionPatterns = filtered;
    }
  }

  return `Analyze these activity records and match each to the most relevant Jira issue.
Match based on MEANING, not just keywords. If a window title contains a Jira key, use it. If OCR text references specific features or code related to an issue, match it.

IMPORTANT: When OCR text shows "(no text extracted)", you must rely on:
- The application name (Code.exe = VS Code, chrome.exe = browser, etc.)
- The window title (which often contains file names, project names, or page titles)
- Context from the project key and issue summaries

When OCR text is marked "low confidence - may be inaccurate", ignore its content entirely and rely on window_title and application_name only.

For development tools with project/file names in the title, match to relevant "In Progress" issues.
For browsers with technical sites in the title, match based on the topic being researched.

CRITICAL TASK KEY RULE: You must ONLY use task keys from the assigned issues list below. NEVER invent, fabricate, or extract issue keys from OCR text, window titles, or any other source. If no assigned issue is a clear semantic match, return taskKey as null. Generic activities (Task Manager, File Explorer, Windows Settings, system utilities, download history) should return null unless they clearly relate to a specific issue.

SESSION CONTINUITY: Records are shown in chronological order. If consecutive records show the same user in the same or related application (e.g., switching between VS Code and Chrome while working), and a previous record was confidently matched to an issue, subsequent records in the same work session should inherit that match at slightly lower confidence (0.5-0.6) unless the content clearly indicates a different task. Developers typically work on one issue for extended periods, switching between IDE, browser, and terminal.
${previousSessionHint}${validCorrectionPatterns && validCorrectionPatterns.length > 0 ? `\nUSER CORRECTION HISTORY: The user has previously corrected the following AI matches. Use these as guidance for similar future activity:\n${validCorrectionPatterns.map(p => `- [${p.application_name}] "${p.window_title}" → AI suggested ${p.ai_suggested || 'null'}, user corrected to ${p.corrected_to}`).join('\n')}\n` : ''}
IDLE REVIEW RECORDS: Records with tracking_mode "idle_for_llm_review" represent periods where the user had no keyboard/mouse input but an application was visible. Use the window title and application name to determine if this was likely productive activity (reading docs, attending a meeting, reviewing code) or genuine idle time (user walked away). For reading/meeting activities, match to the most relevant Jira issue. Assign LOWER confidence for longer idle durations — a 7-minute idle on Confluence is likely reading (confidence 0.5-0.6), while a 45-minute idle on Confluence is less certain (confidence 0.2-0.3). If the window title clearly indicates non-work content, classify as idle with no task match.

NOTE: projectKey is derived server-side from the matched taskKey. You do not need to detect it independently.

User's Assigned Issues (from Jira):
${assignedIssuesText}

Activity Records:
${recordDescriptions}

For EACH record, determine:
1. Which Jira issue is the user most likely working on? Return null if the activity has no clear connection to any specific issue.
2. Is this office work or non-office? Use "office" for ANY work-related activity (coding, meetings, email, documentation, research). Use "non-office" ONLY for personal/entertainment activity (social media, gaming, personal shopping). Meetings (Google Meet, Teams, Zoom, Webex, etc.) are ALWAYS "office" even when taskKey is null.
3. How confident are you in the match?

Return ONLY valid JSON (no markdown code blocks, no extra text). Your response must be exactly one JSON array:
[
  {
    "recordIndex": 0,
    "taskKey": "PROJECT-123" or null,
    "confidenceScore": 0.0-1.0,
    "workType": "office" or "non-office",
    "reasoning": "<= 80 chars, fragment is fine, no narration"
  }
]
Include one entry per record, in order.`;
}

// ============================================================================
// DESCRIBE MODE (non-Jira / Google SSO users)
// ============================================================================
// For users with NO assigned Jira issues (e.g. Google-SSO non-Jira employees),
// we do NOT match to a Jira issue. Instead the LLM reads the window title, app,
// and (privacy-redacted) OCR text and describes WHAT the person is working on.
// taskKey is always null in this mode — no issue keys are produced or invented.

const DESCRIBE_ANALYSIS_SYSTEM_PROMPT = `You are an expert at summarizing computer work activity from text. Given a window title, application name, and OCR-extracted on-screen text, you write a short, factual description of what the person is working on. You never invent project names, ticket numbers, or details that are not present in the input. You do NOT match activity to any issue tracker.`;

/**
 * Build the describe-mode prompt: summarize what the user is working on, no issue matching.
 * @param {Array} records - Activity records with OCR text
 * @returns {string} Complete user prompt
 */
function buildDescribeAnalysisPrompt(records) {
  const recordDescriptions = records.map((record, index) => {
    const ocrSnippet = record.ocr_text
      ? sanitizeOcrText(record.ocr_text.substring(0, 1000))
      : '(no text extracted)';
    const ocrLabel = !record.ocr_text ? '(no text extracted)'
      : record.ocr_confidence && record.ocr_confidence < 0.4
        ? '(low-confidence OCR omitted - rely on window title and app name)'
        : `OCR Text: ${ocrSnippet}`;
    return `Record ${index}: [${record.application_name}] ${record.window_title}
  Time: ${record.total_time_seconds}s | ${record.start_time} → ${record.end_time}
  ${ocrLabel}`;
  }).join('\n\n');

  return `For EACH activity record below, describe what the user is working on. Base the description ONLY on the window title, application name, and OCR text provided. Do NOT invent specifics.

When OCR text shows "(no text extracted)" or is marked low-confidence, rely on the application name and window title alone.

Do NOT produce any issue/ticket keys. This is a description task, not an issue-matching task.

Activity Records:
${recordDescriptions}

For EACH record return:
1. activitySummary: a concise (<= 140 chars) description of what the user is doing (e.g. "Editing onboarding slides in Google Slides", "Reading API docs in Chrome", "Replying to email in Outlook").
2. activityCategory: one of "development", "communication", "meeting", "documentation", "design", "research", "browsing", "other".
3. workType: "office" for any work-related activity (incl. meetings, email, docs, research); "non-office" only for clearly personal/entertainment activity.

Return ONLY valid JSON (no markdown, no extra text) — exactly one JSON array:
[
  {
    "recordIndex": 0,
    "activitySummary": "<= 140 chars",
    "activityCategory": "development",
    "workType": "office"
  }
]
Include one entry per record, in order.`;
}

/**
 * Build the app classification prompt for an unknown application.
 *
 * @param {string} appName - Application/process name
 * @param {string} windowTitle - Window title
 * @param {string} ocrText - OCR-extracted text from the app
 * @returns {string} Complete user prompt
 */
function buildClassificationPrompt(appName, windowTitle, ocrText) {
  const textSnippet = ocrText
    ? sanitizeOcrText(ocrText.substring(0, 800))
    : '(no text available)';

  return `Classify this application into one of three categories:

- **productive**: Work-related apps (IDEs, office suites, design tools, project management, communication tools, browsers on work sites, development tools, cloud consoles, documentation)
- **non_productive**: Entertainment and personal distractions (streaming, social media, gaming, shopping, music, news/memes)
- **private**: Sensitive personal apps where no data should be captured (banking, healthcare, personal finance, password managers, personal messaging, tax software, account management)

Application Details:
- Process Name: ${appName}
- Window Title: ${windowTitle}
- Screen Text: ${textSnippet}

Rules:
- If the app handles sensitive personal/financial/health data → classify as "private"
- If the app is clearly entertainment/personal → classify as "non_productive"
- If the app could be work-related or is ambiguous → classify as "productive"
- Consider the window title and text content for context (e.g., a browser on a banking site is "private")

Return ONLY valid JSON (no markdown, no extra text):
{
  "classification": "productive" or "non_productive" or "private",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of why this classification was chosen",
  "suggestedDisplayName": "Human-readable app name"
}`;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Parse and validate a single JSON object candidate from the salvage scan.
 * Returns the parsed object if it has a numeric recordIndex, otherwise null.
 * @param {string} objectStr - Candidate JSON object string
 * @returns {Object|null}
 */
function tryParseJsonObject(objectStr) {
  if (!objectStr.includes('"recordIndex"')) return null;
  try {
    const parsed = JSON.parse(objectStr);
    return typeof parsed.recordIndex === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Attempt to salvage a truncated JSON array by extracting complete objects.
 * When max_tokens cuts off the LLM response mid-JSON, this recovers
 * any fully-formed objects from the partial output.
 */
function salvageTruncatedJsonArray(truncatedJson) {
  // Iterate through string to find balanced {...} blocks (no regex).
  // String-aware so braces inside quoted reasoning text don't throw off the depth counter.
  const salvaged = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < truncatedJson.length; i++) {
    const char = truncatedJson[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (char !== '}') continue;

    depth--;
    if (depth === 0 && start !== -1) {
      const parsed = tryParseJsonObject(truncatedJson.slice(start, i + 1));
      if (parsed) salvaged.push(parsed);
      start = -1;
    }
  }

  if (salvaged.length === 0) {
    throw new Error('Failed to parse AI response — no complete records found in truncated JSON');
  }

  logger.warn(`[ActivityService] Salvaged ${salvaged.length} records from truncated JSON response`);
  return salvaged;
}

// ============================================================================
// SERVICE METHODS
// ============================================================================

/**
 * Parses the raw AI batch response into a JSON array.
 * Handles direct JSON, markdown code blocks, and truncated responses.
 */
function parseAnalysisResponse(content) {
  try {
    return JSON.parse(content);
  } catch (error) {
    logger.debug('[ActivityService] Direct JSON parse failed, trying markdown extraction: %s', error.message);
    const startIdx = content.indexOf('[');
    if (startIdx === -1) {
      logger.error('[ActivityService] Failed to parse batch analysis response: %s', content.substring(0, 200));
      throw new Error('Failed to parse AI response as JSON array');
    }
    const endIdx = content.lastIndexOf(']');
    if (endIdx <= startIdx) {
      logger.warn('[ActivityService] No closing bracket found, response truncated — attempting salvage');
      return salvageTruncatedJsonArray(content.substring(startIdx));
    }
    const jsonMatch = content.substring(startIdx, endIdx + 1);
    try {
      return JSON.parse(jsonMatch);
    } catch (error_) {
      // JSON may be truncated by max_tokens — try to salvage complete entries
      logger.debug('[ActivityService] Markdown JSON parse failed, salvaging truncated response: %s', error_.message);
      return salvageTruncatedJsonArray(jsonMatch);
    }
  }
}

/**
 * Validates task keys and derives project keys from matched task keys.
 * - Clears task keys hallucinated by the AI (not present in the user's assigned issues).
 * - Derives projectKey from taskKey (e.g., PROJ-123 → PROJ). If no task is matched,
 *   projectKey is set to null. This eliminates garbage project keys from AI hallucination.
 */
function validateAnalysisKeys(analyses, userAssignedIssues) {
  const validKeys = new Set(userAssignedIssues.map(i => i.key));
  for (const analysis of analyses) {
    if (analysis.taskKey && !validKeys.has(analysis.taskKey)) {
      logger.warn(`[ActivityService] AI returned invalid task key: ${analysis.taskKey}`);
      analysis.taskKey = null;
      analysis.confidenceScore = Math.min(analysis.confidenceScore || 0, 0.3);
    }

    // Derive projectKey from the validated taskKey (PROJ-123 → PROJ).
    // If no task matched, projectKey becomes null — the record shows as "unassigned".
    if (analysis.taskKey) {
      const match = analysis.taskKey.match(/^([A-Z][A-Z0-9]+)-\d+$/);
      analysis.projectKey = match ? match[1] : null;
    } else {
      analysis.projectKey = null;
    }
  }
}

/**
 * Persists each analysis result back to the database.
 * Logs individual update failures without stopping the rest of the batch.
 */
async function persistAnalysisResults(analyses, records, provider, model) {
  // Read the same env var the DB layer uses, so the log line and the actual
  // demotion never drift if AI_MATCH_MIN_CONFIDENCE is overridden in env.
  const MIN_CONFIDENCE_THRESHOLD = parseFloat(process.env.AI_MATCH_MIN_CONFIDENCE || '0.4');

  for (const analysis of analyses) {
    const recordIndex = analysis.recordIndex;
    if (recordIndex >= 0 && recordIndex < records.length && records[recordIndex].id) {
      // Log low-confidence matches for observability (threshold enforcement is in activity-db-service)
      if (analysis.taskKey && (analysis.confidenceScore || 0) < MIN_CONFIDENCE_THRESHOLD) {
        logger.info(
          `[ActivityService] Low-confidence match (will be demoted by DB layer) | ` +
          `record=${records[recordIndex].id} taskKey=${analysis.taskKey} ` +
          `confidence=${analysis.confidenceScore} threshold=${MIN_CONFIDENCE_THRESHOLD} ` +
          `reasoning="${analysis.reasoning}"`
        );
      }

      try {
        const metadata = {
          workType: analysis.workType || 'office',
          confidenceScore: analysis.confidenceScore,
          reasoning: analysis.reasoning,
          aiProvider: provider,
          aiModel: model
        };
        // Describe mode (non-Jira users): persist the activity description so the
        // Portal can show "what they're working on". No taskKey is produced.
        if (analysis.activitySummary) {
          metadata.activitySummary = analysis.activitySummary;
        }
        if (analysis.activityCategory) {
          metadata.activityCategory = analysis.activityCategory;
        }

        await activityDbService.updateActivityRecordAnalysis(records[recordIndex].id, {
          taskKey: analysis.taskKey,
          projectKey: analysis.projectKey,
          metadata
        });
      } catch (updateErr) {
        logger.error(`[ActivityService] Failed to update record ${records[recordIndex].id}:`, updateErr);
      }
    }
  }
}

/**
 * Analyze a batch of productive activity records using text-only LLM.
 * Sends a single API call with all records for efficiency.
 *
 * @param {Array} records - Activity records with OCR text
 * @param {Array} userAssignedIssues - User's assigned Jira issues
 * @param {string} userId - User ID
 * @param {string} organizationId - Organization ID
 * @returns {Promise<Object>} Analysis results
 */
async function analyzeBatch(records, userAssignedIssues, userId, organizationId, previousMatchContext, correctionPatterns) {
  if (!isActivityAIEnabled()) {
    throw new Error('AI client not initialized - check API keys');
  }

  // DESCRIBE MODE: when there are no assigned issues, the LLM describes what the
  // user is working on instead of matching to an issue. An empty issue list is
  // the trigger — this is always the case for Google-SSO non-Jira users, and is
  // also (intentionally, benignly) hit by a Jira user who currently has zero
  // assigned issues: there is nothing to match, so a description is the useful
  // output and `taskKey` stays null either way.
  const describeMode = !userAssignedIssues || userAssignedIssues.length === 0;

  let messages;
  if (describeMode) {
    messages = [
      { role: 'system', content: DESCRIBE_ANALYSIS_SYSTEM_PROMPT },
      { role: 'user', content: buildDescribeAnalysisPrompt(records) }
    ];
  } else {
    const assignedIssuesText = formatAssignedIssues(userAssignedIssues);
    const userPrompt = buildBatchAnalysisPrompt(records, assignedIssuesText, previousMatchContext, correctionPatterns);
    messages = [
      { role: 'system', content: BATCH_ANALYSIS_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ];
  }

  try {
    // 30000 fits a 20-record batch with the tightened reasoning field while
    // staying under Gemini 2.5 Flash's 65K cap and the bumped Portkey timeout.
    const { response, provider, model } = await chatCompletionWithFallback({
      messages,
      // temperature intentionally omitted — see ai-client.js:178-181 for rationale
      max_tokens: 30000,
      isVision: false,
      userId,
      organizationId,
      apiCallName: 'batch-analysis'
    });

    const content = response.choices[0].message.content.trim();
    const finishReason = response.choices[0].finish_reason;
    logger.info(`[ActivityService] Batch analysis done | ${provider} (${model}) | ${records.length} records`);

    const analyses = parseAnalysisResponse(content);
    if (!Array.isArray(analyses)) {
      throw new TypeError('AI response is not a JSON array');
    }

    validateAnalysisKeys(analyses, userAssignedIssues);
    await persistAnalysisResults(analyses, records, provider, model);

    // Treat any short return as truncated, regardless of finish_reason.
    // Two cases produce a short return:
    //   1. finish_reason === 'length' — model hit max_tokens cap.
    //   2. JSON parse error mid-stream → salvage recovers a subset with
    //      finish_reason === 'stop'.
    // Either way, the polling service must know so it can re-queue the rest.
    const truncated = finishReason === 'length' || analyses.length < records.length;

    if (truncated) {
      logger.warn(
        `[ActivityService] Response incomplete (finish_reason=${finishReason}): salvaged ${analyses.length} of ${records.length} records — ${records.length - analyses.length} record(s) will be re-queued`
      );
    }

    // recordsProcessed reflects what was actually analyzed, not what we sent.
    // The polling service uses this to identify unanalyzed records and release
    // them back to 'pending' for the next cycle.
    return {
      analyses,
      recordsProcessed: analyses.length,
      truncated,
      provider,
      model
    };

  } catch (error) {
    logger.error('[ActivityService] Batch analysis failed: %s', error.message);
    throw error;
  }
}

/**
 * Classify an unknown application using LLM.
 *
 * @param {string} appName - Application/process name
 * @param {string} windowTitle - Window title
 * @param {string} ocrText - OCR-extracted text
 * @param {string} userId - User ID for LiteLLM tracking (optional)
 * @param {string} organizationId - Organization ID for cost tracking (optional)
 * @returns {Promise<Object>} Classification result
 */
async function classifyUnknownApp(appName, windowTitle, ocrText, userId = null, organizationId = null) {
  if (!isActivityAIEnabled()) {
    throw new Error('AI client not initialized - check API keys');
  }

  const userPrompt = buildClassificationPrompt(appName, windowTitle, ocrText);

  const messages = [
    { role: 'system', content: APP_CLASSIFICATION_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ];

  try {
    const { response, provider, model } = await chatCompletionWithFallback({
      messages,
      // temperature intentionally omitted — see ai-client.js:178-181 for rationale
      max_tokens: 30000,
      isVision: false,
      userId,
      organizationId,
      apiCallName: 'app-classification'
    });

    const content = response.choices[0].message.content.trim();
    logger.info(`[ActivityService] App classification done | ${provider} (${model}) | ${appName}`);

    // Parse JSON response
    let result;
    try {
      result = JSON.parse(content);
    } catch (error) {
      logger.debug('[ActivityService] Direct JSON parse failed, trying substring extraction: %s', error.message);
      const startIdx = content.indexOf('{');
      const endIdx = content.lastIndexOf('}');
      if (startIdx !== -1 && endIdx > startIdx) {
        result = JSON.parse(content.substring(startIdx, endIdx + 1));
      } else {
        logger.error('[ActivityService] Failed to parse classification response: %s', content.substring(0, 200));
        throw new Error('Failed to parse AI classification response');
      }
    }

    // Validate classification value
    const validClassifications = ['productive', 'non_productive', 'private'];
    if (!validClassifications.includes(result.classification)) {
      logger.warn(`[ActivityService] Invalid classification: ${result.classification}, defaulting to productive`);
      result.classification = 'productive';
    }

    return {
      classification: result.classification,
      confidence: result.confidence || 0.5,
      reasoning: result.reasoning || '',
      suggestedDisplayName: result.suggestedDisplayName || appName,
      aiProvider: provider,
      aiModel: model
    };

  } catch (error) {
    logger.error('[ActivityService] App classification failed: %s', error.message);
    // Default to productive on failure (safest — will trigger OCR + AI analysis)
    return {
      classification: 'productive',
      confidence: 0,
      reasoning: 'Classification failed, defaulting to productive',
      suggestedDisplayName: appName,
      error: error.message
    };
  }
}

/**
 * Identify an application by name/search term using LLM.
 * Used when admin searches for an app that:
 * 1. Is not in the database
 * 2. Is not currently running (psutil can't find it)
 *
 * LLM identifies the executable name and display name only.
 * Classification is determined by which section the admin is searching in.
 *
 * @param {string} searchTerm - App name or search term from admin
 * @returns {Promise<Object>} Identification result with identifier, display_name
 */
async function identifyAppByName(searchTerm) {
  logger.info('[ActivityService] ========== identifyAppByName START ==========');
  logger.info(`[ActivityService] Search term: "${searchTerm}"`);
  
  const aiEnabled = isActivityAIEnabled();
  logger.info(`[ActivityService] AI enabled check: ${aiEnabled}`);
  
  if (!aiEnabled) {
    logger.error('[ActivityService] AI client not initialized - check API keys');
    throw new Error('AI client not initialized - check API keys');
  }

  const userPrompt = buildAppIdentificationPrompt(searchTerm);
  logger.info('[ActivityService] Built user prompt: %s', userPrompt);

  const messages = [
    { role: 'system', content: APP_IDENTIFICATION_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ];

  logger.info('[ActivityService] Calling chatCompletionWithFallback...');
  
  try {
    const { response, provider, model } = await chatCompletionWithFallback({
      messages,
      // temperature intentionally omitted — see ai-client.js:178-181 for rationale
      max_tokens: 30000,
      isVision: false,
      apiCallName: 'app-identification'
    });

    const content = response.choices[0].message.content.trim();
    logger.info(`[ActivityService] LLM Response received | Provider: ${provider} | Model: ${model}`);
    logger.info(`[ActivityService] Raw LLM content: ${content}`);

    // Parse JSON response
    let result;
    try {
      result = JSON.parse(content);
      logger.info('[ActivityService] Parsed JSON result: %s', JSON.stringify(result));
    } catch (error) {
      logger.warn('[ActivityService] Direct JSON parse failed, trying substring extraction: %s', error.message);
      const startIdx = content.indexOf('{');
      const endIdx = content.lastIndexOf('}');
      if (startIdx !== -1 && endIdx > startIdx) {
        result = JSON.parse(content.substring(startIdx, endIdx + 1));
        logger.info('[ActivityService] Extracted JSON: %s', JSON.stringify(result));
      } else {
        logger.error('[ActivityService] Failed to parse app identification response: %s', content.substring(0, 200));
        throw new Error('Failed to parse AI response');
      }
    }

    if (!result.identified) {
      logger.info('[ActivityService] LLM says app NOT identified');
      logger.info('[ActivityService] ========== identifyAppByName END (not identified) ==========');
      return {
        identified: false,
        source: 'llm',
        aiProvider: provider,
        aiModel: model
      };
    }

    logger.info(`[ActivityService] LLM identified app: identifier="${result.identifier}", display_name="${result.display_name}"`);
    logger.info('[ActivityService] ========== identifyAppByName END (success) ==========');
    
    return {
      identified: true,
      identifier: result.identifier,
      display_name: result.display_name,
      confidence: result.confidence || 0.7,
      source: 'llm',
      aiProvider: provider,
      aiModel: model
    };

  } catch (error) {
    logger.error('[ActivityService] App identification FAILED');
    logger.error('[ActivityService] Error message: %s', error.message);
    logger.error('[ActivityService] Stack trace: %s', error.stack);
    logger.info('[ActivityService] ========== identifyAppByName END (error) ==========');
    return {
      identified: false,
      source: 'llm',
      error: error.message
    };
  }
}

module.exports = {
  analyzeBatch,
  classifyUnknownApp,
  identifyAppByName,
  // Exported for testing
  sanitizeOcrText,
  _buildBatchAnalysisPrompt: buildBatchAnalysisPrompt,
  _buildClassificationPrompt: buildClassificationPrompt,
  _buildDescribeAnalysisPrompt: buildDescribeAnalysisPrompt,
};