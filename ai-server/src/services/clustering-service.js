/**
 * Clustering Service
 * Groups unassigned work sessions using AI (via Portkey gateway).
 */

const { chatCompletionWithFallback, isActivityAIEnabled } = require('./ai/ai-client');
const logger = require('../utils/logger');
const { toUTCISOString } = require('../utils/datetime');

// Applications that should ALWAYS be grouped separately (system/idle apps)
const SYSTEM_APPS = [
  'lockapp', 'lock', 'screenlock',
  'idle', 'afk',
  'screensaver',
  'logonui',
  'shutdown'
];

// Applications that represent actual work and should be grouped by content
const WORK_APPS = [
  'code', 'vscode', 'cursor', 'sublime', 'atom', 'notepad++', 'vim', 'neovim', // Editors
  'chrome', 'firefox', 'edge', 'brave', 'safari', 'opera', // Browsers
  'terminal', 'windowsterminal', 'cmd', 'powershell', 'iterm', 'warp', // Terminals
  'slack', 'teams', 'discord', 'zoom', 'meet', // Communication
  'outlook', 'gmail', 'thunderbird', // Email
  'figma', 'sketch', 'photoshop', 'illustrator', // Design
  'excel', 'word', 'powerpoint', 'sheets', 'docs' // Office
];

/**
 * Normalize application name for comparison
 */
function normalizeAppName(appName) {
  if (!appName) return 'unknown';
  return appName.toLowerCase().replace('.exe', '').replace(/\s+/g, '').trim();
}

/**
 * Check if an application is a system/idle app
 */
function isSystemApp(appName) {
  const normalized = normalizeAppName(appName);
  return SYSTEM_APPS.some(sysApp => normalized.includes(sysApp));
}

/**
 * Infer project keys from session content (window titles, OCR text, reasoning)
 * Useful when sessions don't have explicit project_key set
 * 
 * Scoring system:
 * - Issue key match (PROJ-123): +10 points
 * - Project name mention: +5 points
 * - Issue summary keyword match (>4 chars): +2 points
 * 
 * @param {Array} sessions - Unassigned work sessions
 * @param {Array} userIssues - User's active issues with project info
 * @returns {Array<string>} Inferred project keys sorted by relevance score
 */
function inferProjectFromSessions(sessions, userIssues) {
  if (!sessions || sessions.length === 0 || !userIssues || userIssues.length === 0) {
    return [];
  }

  const projectHints = new Map(); // project -> score

  // Build searchable content from all sessions
  for (const session of sessions) {
    const content = [
      session.window_title || '',
      session.extracted_text || '',
      session.reasoning || '',
      session.application_name || ''
    ].join(' ').toLowerCase();

    if (!content.trim()) {
      continue; // Skip empty content
    }

    // Strategy 1: Look for explicit issue key patterns (PROJ-123)
    // This is the strongest signal - exact match to a project
    const issueKeyMatches = content.match(/\b([A-Z][A-Z0-9]+)-\d+\b/g) || [];
    for (const issueKey of issueKeyMatches) {
      const projectKey = issueKey.split('-')[0];
      
      // Only count if this project exists in user's issues
      const projectExists = userIssues.some(issue => issue.project === projectKey);
      if (projectExists) {
        projectHints.set(projectKey, (projectHints.get(projectKey) || 0) + 10);
        logger.debug(`[Inference] Found issue key ${issueKey} -> +10 for ${projectKey}`);
      }
    }

    // Strategy 2: Look for project names mentioned explicitly
    // e.g., "Working on SCRUM project" or "DEVOPS deployment"
    for (const issue of userIssues) {
      const projectKey = issue.project;
      if (!projectKey) continue;

      const projectNameLower = projectKey.toLowerCase();
      
      // Check for exact project key mention
      if (content.includes(projectNameLower)) {
        projectHints.set(projectKey, (projectHints.get(projectKey) || 0) + 5);
        logger.debug(`[Inference] Found project name "${projectKey}" -> +5`);
      }
    }

    // Strategy 3: Look for issue summary keywords
    // e.g., if user has issue "Fix authentication bug" and content mentions "authentication"
    for (const issue of userIssues) {
      const projectKey = issue.project;
      if (!projectKey || !issue.summary) continue;

      // Extract meaningful words from issue summary (>4 chars, not common words)
      const summaryWords = issue.summary
        .toLowerCase()
        .split(/[\s\-_\/\\,\.]+/)
        .filter(word => {
          // Filter out common/short words
          if (word.length <= 4) return false;
          const commonWords = ['with', 'from', 'that', 'this', 'have', 'been', 'were', 'their'];
          return !commonWords.includes(word);
        });

      for (const word of summaryWords) {
        if (content.includes(word)) {
          projectHints.set(projectKey, (projectHints.get(projectKey) || 0) + 2);
          logger.debug(`[Inference] Found keyword "${word}" from ${issue.issue_key} -> +2 for ${projectKey}`);
        }
      }
    }
  }

  // Filter and sort by score
  const MIN_SCORE_THRESHOLD = 5; // Require at least 5 points (1 project mention or 1 issue key match)
  const inferredProjects = Array.from(projectHints.entries())
    .filter(([_, score]) => score >= MIN_SCORE_THRESHOLD)
    .sort((a, b) => b[1] - a[1]) // Sort by score descending
    .map(([project, score]) => {
      logger.info(`[Inference] Project ${project} scored ${score} points`);
      return project;
    });

  return inferredProjects;
}

/**
 * Create clustering input text from session data
 * Includes as much context as possible for better AI grouping
 */
function createClusteringInput(session) {
  const reasoning = session.reasoning || session.analysis_metadata?.reasoning || 'No description available';
  const app = session.application_name?.replace('.exe', '') || 'Unknown';
  const windowTitle = session.window_title || 'Unknown';
  const isSystem = isSystemApp(app);
  const extractedText = session.extracted_text || '';

  // Extract useful context from extracted_text (file paths, URLs, etc.)
  let additionalContext = '';
  if (extractedText && extractedText.length > 0) {
    // Limit to first 200 chars to avoid token bloat
    const truncatedText = extractedText.substring(0, 200);
    additionalContext = `\nScreen Content: ${truncatedText}${extractedText.length > 200 ? '...' : ''}`;
  }

  return `
Application: ${app}${isSystem ? ' [SYSTEM/IDLE - DO NOT MIX WITH WORK]' : ''}
Window Title: ${windowTitle}
Activity Description: ${reasoning}
Duration: ${Math.round((session.time_spent_seconds || 0) / 60)} minutes${additionalContext}
  `.trim();
}

/**
 * Cluster unassigned work sessions using AI (via Portkey gateway).
 *
 * @param {Array} sessions - Array of unassigned work sessions
 * @param {Array} userIssues - User's assigned Jira issues for suggestion
 * @returns {Promise<Object>} Clustered groups
 */
exports.clusterUnassignedWork = async (sessions, userIssues = []) => {
  try {
    if (!sessions || sessions.length === 0) {
      return { groups: [] };
    }

    if (!isActivityAIEnabled()) {
      throw new Error('AI client not available - check API keys');
    }

    logger.info('[AI] Clustering %d unassigned sessions', sessions.length);

    // If too many sessions, process in batches
    const MAX_SESSIONS_PER_BATCH = 30;
    if (sessions.length > MAX_SESSIONS_PER_BATCH) {
      logger.info('[AI] Large session count (%d), batching by %d', sessions.length, MAX_SESSIONS_PER_BATCH);
      return await clusterInBatches(sessions, userIssues, MAX_SESSIONS_PER_BATCH);
    }

    // Create input text for each session
    const sessionDescriptions = sessions.map((session, index) => {
      return `Session ${index + 1} (ID: ${session.id}, Time: ${session.time_spent_seconds}s):
${createClusteringInput(session)}`;
    }).join('\n\n');

    // Build project-grouped issues context for better AI scoping
    let issuesContext = '';
    if (userIssues.length > 0) {
      // Extract project keys present in the sessions for context
      let sessionProjectKeys = [...new Set(
        sessions.map(s => s.project_key).filter(Boolean)
      )];

      // NEW: If no explicit project keys, try to infer from content
      if (sessionProjectKeys.length === 0) {
        logger.info('[AI] No explicit project_key in sessions, attempting inference from content...');
        sessionProjectKeys = inferProjectFromSessions(sessions, userIssues);
        
        if (sessionProjectKeys.length > 0) {
          logger.info(`[AI] ✓ Inferred ${sessionProjectKeys.length} project(s) from content: ${sessionProjectKeys.join(', ')}`);
        } else {
          logger.warn('[AI] ✗ Could not infer any projects from session content');
        }
      } else {
        logger.info(`[AI] Using explicit project keys from sessions: ${sessionProjectKeys.join(', ')}`);
      }

      // Group issues by project
      const issuesByProject = {};
      for (const issue of userIssues) {
        const proj = issue.project || 'UNKNOWN';
        if (!issuesByProject[proj]) issuesByProject[proj] = [];
        issuesByProject[proj].push(issue);
      }

      // Build context string with project grouping
      let issueLines = '';
      for (const [project, issues] of Object.entries(issuesByProject)) {
        const marker = sessionProjectKeys.includes(project) ? ' [SAME PROJECT AS ACTIVITY]' : '';
        issueLines += `\n  Project ${project}${marker}:\n`;
        issueLines += issues.map(issue => {
          const descSuffix = issue.description
            ? ` — ${issue.description.substring(0, 200)}`
            : '';
          return `    - ${issue.issue_key}: ${issue.summary}${descSuffix}`;
        }).join('\n');
      }

      issuesContext = `\n\nUser's assigned Jira issues (grouped by project):\n${issueLines}`;

      // Add explicit project constraint instruction
      if (sessionProjectKeys.length > 0) {
        issuesContext += `\n\nPROJECT MATCHING RULE: The unassigned activities belong to project(s): ${sessionProjectKeys.join(', ')}. ` +
          `You MUST ONLY suggest issue keys from these same project(s) that the user has access to. ` +
          `If no issue from these projects matches the work, recommend "create_new_issue" instead of forcing a match from another project. ` +
          `NEVER suggest an issue from a different project the user does not have access to or that is unrelated to the activity.`;
      } else {
        // NEW: No project hints found - use multi-project mode
        issuesContext += `\n\nMULTI-PROJECT MATCHING MODE: The activities could relate to any of the user's projects. ` +
          `Carefully analyze the session content (window titles, screen text, activity descriptions) to determine which project is most relevant. ` +
          `Only suggest an issue if there is CLEAR evidence in the content that matches a specific issue. ` +
          `Consider all projects EQUALLY - do not favor one project over another without evidence. ` +
          `If no strong match exists in ANY project, recommend "create_new_issue". ` +
          `When you find a match, explain WHAT content evidence led you to that specific project and issue.`;
      }
    }

    // Pre-categorize sessions by application type for better context
    const systemSessions = sessions.filter(s => isSystemApp(s.application_name));
    const workSessions = sessions.filter(s => !isSystemApp(s.application_name));

    // Clustering prompt with smart rules
    const userPrompt = `You are an AI assistant helping to group similar work sessions together for time tracking.

GROUPING RULES:

1. **NEVER mix system/idle apps with work apps**
   - System/Idle apps: LockApp, ScreenSaver, LogonUI, etc. (marked with [SYSTEM/IDLE])
   - These represent breaks/idle time and must be in their own separate group
   - Example: "Idle Time" or "Screen Lock Sessions"

2. **Group by PROJECT/TASK CONTEXT, not just application**
   - If someone works on the SAME project using VS Code, Cursor, Claude Code, and Terminal → GROUP THEM TOGETHER
   - Look at window titles, file paths, and activity descriptions to identify the project
   - Example: All sessions showing the same project folder or repository name in the path = same project group

3. **Similar code editors working on same project = SAME GROUP**
   - VS Code + Cursor + Claude Code + Sublime working on the same project → one group: "[Project Name] Development"
   - Terminal commands related to the same project → include in same group

4. **Different projects = DIFFERENT GROUPS**
   - VS Code on "ProjectA" vs VS Code on "ProjectB" = SEPARATE groups
   - Browser researching "React docs" vs Browser on "YouTube" = SEPARATE groups

5. **AVOID SINGLE-ACTIVITY GROUPS** (CRITICAL!)
   - NEVER create a group with only 1 session unless it's truly unique
   - If an activity seems standalone, try harder to find a related group
   - Prefer FEWER, LARGER groups over MANY small groups
   - It's better to have a slightly broader group than many 1-2 session groups

6. **BE AGGRESSIVE WITH MERGING**
   - If two activities are even loosely related (same project, same type of work), group them
   - Email about Project X + Coding on Project X = SAME GROUP
   - Research for a feature + Implementing that feature = SAME GROUP

7. **Examples of GOOD grouping:**
   - ✅ VS Code (project-x) + Cursor (project-x) + Terminal (npm start for project-x) + Chrome (localhost:3000) → "Project X - Frontend Development"
   - ✅ Chrome (project board) + Chrome (issue tracker) + Outlook (project emails) → "Project X - Planning & Coordination"
   - ✅ LockApp + ScreenSaver → "Idle/Break Time"
   - ✅ Research + Implementation + Testing for same feature → ONE group

8. **Examples of BAD grouping:**
   - ❌ LockApp + VS Code → NEVER mix idle with work
   - ❌ Creating 10 groups with 1-2 sessions each → Too fragmented
   - ❌ "Email" as separate group when emails are about the project being worked on

Pre-analysis:
- System/Idle sessions: ${systemSessions.length} (LockApp, ScreenSaver, etc.)
- Work sessions: ${workSessions.length} (Editors, Browsers, Terminals, etc.)
${issuesContext}

Sessions to group:
${sessionDescriptions}

Output Requirements:
1. **Group label**: Specific project/task name (max 50 chars)
   - Good: "Time Tracker - Session Resolver Bug Fix"
   - Bad: "Development Work" (too vague)

2. **Description**: Detailed summary that answers WHAT, WHERE, and WHY (2-3 sentences)
   - Include specific file names, URLs, or features worked on
   - Mention the type of work (coding, debugging, reviewing, researching, etc.)
   - Good: "Fixed session duration calculation in sessionResolvers.js. Updated formatDuration function to show seconds. Tested time display in GroupAccordion component."
   - Bad: "Worked on code" (too vague)

3. **Confidence**: high (clearly same project/task), medium (likely related), low (loosely connected)

4. **Recommendation**: Suggest matching Jira issue based on content. Explain WHY it matches.

Return ONLY valid JSON in this exact format (no markdown, no backticks):
{
  "groups": [
    {
      "label": "Specific Project - Task Name",
      "description": "Detailed description including: what files/URLs were accessed, what type of work was done (coding/debugging/researching/reviewing), and what was accomplished or attempted.",
      "session_indices": [1, 3, 5],
      "confidence": "high|medium|low",
      "recommendation": {
        "action": "assign_to_existing|create_new_issue",
        "suggested_issue_key": "SCRUM-X or null",
        "reason": "Specific reason why this issue matches the work done"
      }
    }
  ]
}`;

    const systemPrompt = `You are a work activity clustering assistant that groups time tracking sessions for accurate time reporting.

KEY RULES:
1. NEVER mix system/idle apps (LockApp, ScreenSaver) with work apps - they must be in separate groups
2. Group by PROJECT/TASK CONTEXT - if VS Code, Cursor, Terminal all show "jira1" project, group them TOGETHER
3. Different code editors working on the SAME project = SAME GROUP
4. Look at window titles, file paths, and descriptions to identify which project/task the work belongs to
5. Always respond with valid JSON only, no markdown formatting.
6. ONLY suggest issue keys from the SAME project as the activity. If issues are grouped by project and marked with [SAME PROJECT AS ACTIVITY], prefer those issues. If no matching issue exists in the activity's project, recommend "create_new_issue" — NEVER force-match an issue from a different project.

CRITICAL - DESCRIPTIONS MUST BE SPECIFIC:
- Extract specific file names, component names, or URLs from the session data
- Describe the TYPE of work: coding, debugging, code review, research, documentation, etc.
- Mention what was accomplished or attempted
- NEVER use vague descriptions like "Development work" or "Coding activities"
- Good example: "Implemented user authentication in authController.js. Added login validation in validators/auth.js. Created LoginForm React component with error handling."
- Bad example: "Worked on the project"`;

    // Build messages array
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // Use unified request with automatic fallback
    // Note: userId not available in clustering context, cost tracking will log without user
    const { response, provider, model } = await chatCompletionWithFallback({
      messages,
      // temperature intentionally omitted — see ai-client.js:178-181 for rationale
      max_tokens: 30000,
      isVision: false,
      userId: null, // Clustering doesn't have user context
      organizationId: null,
      screenshotId: null,
      apiCallName: 'clustering'
    });

    const responseText = response.choices[0].message.content.trim();
    logger.info('[AI] Clustering done | %s (%s)', provider, model);

    // Remove markdown code blocks if present
    let cleanedResponse = responseText
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    // Try to extract JSON if response contains extra text
    // Use string operations instead of vulnerable regex to avoid ReDoS
    const firstBrace = cleanedResponse.indexOf('{');
    const lastBrace = cleanedResponse.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const potentialJson = cleanedResponse.slice(firstBrace, lastBrace + 1);
      // Verify it contains "groups" before using it
      if (potentialJson.includes('"groups"')) {
        cleanedResponse = potentialJson;
      }
    }

    // Try to parse JSON, with fallback for truncated responses
    let clusteringResult;
    try {
      clusteringResult = JSON.parse(cleanedResponse);
    } catch (parseError) {
      logger.warn('Initial JSON parse failed, attempting to fix truncated response');

      // Try to fix common issues with truncated JSON
      // 1. If truncated mid-array, try to close it
      let fixedResponse = cleanedResponse;

      // Count open brackets
      const openBrackets = (fixedResponse.match(/\[/g) || []).length;
      const closeBrackets = (fixedResponse.match(/\]/g) || []).length;
      const openBraces = (fixedResponse.match(/\{/g) || []).length;
      const closeBraces = (fixedResponse.match(/\}/g) || []).length;

      // Add missing closing brackets/braces
      for (let i = 0; i < openBrackets - closeBrackets; i++) {
        fixedResponse += ']';
      }
      for (let i = 0; i < openBraces - closeBraces; i++) {
        fixedResponse += '}';
      }

      // Remove trailing comma before closing bracket/brace
      fixedResponse = fixedResponse.replace(/,\s*\]/g, ']').replace(/,\s*\}/g, '}');

      try {
        clusteringResult = JSON.parse(fixedResponse);
        logger.info('Successfully parsed fixed JSON response');
      } catch (secondError) {
        logger.error('[AI] Failed to parse clustering response (len: %d)', cleanedResponse.length);
        throw new Error(`Invalid JSON in clustering response: ${parseError.message}`);
      }
    }

    // Map session indices back to actual session data and calculate totals
    const enrichedGroups = clusteringResult.groups.map(group => {
      const groupSessions = group.session_indices.map(idx => sessions[idx - 1]).filter(Boolean);
      const totalSeconds = groupSessions.reduce((sum, s) => sum + (s.time_spent_seconds || 0), 0);
      const sessionIds = groupSessions.map(s => s.id);

      return {
        ...group,
        sessions: groupSessions,
        session_ids: sessionIds,
        total_seconds: totalSeconds,
        total_time_formatted: formatDuration(totalSeconds),
        session_count: groupSessions.length,
        aiProvider: provider,
        aiModel: model
      };
    });

    logger.info('[AI] Created %d groups from %d sessions', enrichedGroups.length, sessions.length);

    // Log each group result
    enrichedGroups.forEach((group, idx) => {
      logger.info('[AI] Group %d: "%s" | %d sessions | %s | %s',
        idx + 1,
        group.label,
        group.session_count,
        group.total_time_formatted,
        group.recommendation?.suggested_issue_key || 'no suggestion'
      );
    });

    return {
      groups: enrichedGroups,
      total_sessions: sessions.length,
      total_groups: enrichedGroups.length,
      aiProvider: provider,
      aiModel: model
    };

  } catch (error) {
    logger.error('[AI] Clustering failed: %s', error.message);
    throw new Error(`Failed to cluster unassigned work: ${error.message}`);
  }
};

/**
 * Process large session counts in batches to avoid token limits
 * @param {Array} sessions - All sessions to cluster
 * @param {Array} userIssues - User's assigned Jira issues
 * @param {number} batchSize - Maximum sessions per batch
 * @returns {Promise<Object>} Combined clustered groups
 */
async function clusterInBatches(sessions, userIssues, batchSize) {
  const allGroups = [];
  const batches = [];

  // Split sessions into batches
  for (let i = 0; i < sessions.length; i += batchSize) {
    batches.push(sessions.slice(i, i + batchSize));
  }

  logger.info('[AI] Processing %d batches for %d sessions', batches.length, sessions.length);

  // Process each batch
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    logger.info('[AI] Processing batch %d/%d (%d sessions)', i + 1, batches.length, batch.length);

    try {
      // Re-index sessions for this batch (1-based for the batch)
      const batchResult = await exports.clusterUnassignedWork(batch, userIssues);

      if (batchResult.groups) {
        // The groups from clusterUnassignedWork already have session_ids populated
        allGroups.push(...batchResult.groups);
      }
    } catch (batchError) {
      logger.error('[AI] Batch %d failed: %s', i + 1, batchError.message);
      // Continue with other batches even if one fails
    }
  }

  // Merge similar groups across batches (by label)
  const mergedGroups = mergeGroups(allGroups);

  logger.info('[AI] Merged %d batch groups into %d groups', allGroups.length, mergedGroups.length);

  return {
    groups: mergedGroups,
    total_sessions: sessions.length,
    total_groups: mergedGroups.length
  };
}

/**
 * Merge similar groups from different batches
 * Uses fuzzy matching to combine groups with similar labels
 */
function mergeGroups(groups) {
  if (groups.length === 0) return [];

  const mergedGroups = [];

  for (const group of groups) {
    // Find existing group with similar label
    const existingGroup = findSimilarGroup(mergedGroups, group.label);

    if (existingGroup) {
      // Merge with existing group
      existingGroup.sessions = [...existingGroup.sessions, ...group.sessions];
      existingGroup.session_ids = [...existingGroup.session_ids, ...group.session_ids];
      existingGroup.total_seconds += group.total_seconds;
      existingGroup.session_count += group.session_count;
      existingGroup.total_time_formatted = formatDuration(existingGroup.total_seconds);
      // Keep the longer/more descriptive label
      if (group.label.length > existingGroup.label.length) {
        existingGroup.label = group.label;
      }
      // Keep the longer/more descriptive description
      if (group.description && (!existingGroup.description || group.description.length > existingGroup.description.length)) {
        existingGroup.description = group.description;
      }
    } else {
      // Create new entry
      mergedGroups.push({ ...group });
    }
  }

  // Post-process: Merge very small groups (1-2 sessions) into related larger groups
  return consolidateSmallGroups(mergedGroups);
}

/**
 * Find a group with a similar label using fuzzy matching
 */
function findSimilarGroup(groups, label) {
  const normalizedLabel = normalizeLabel(label);
  const labelWords = extractKeywords(label);

  for (const group of groups) {
    const existingNormalized = normalizeLabel(group.label);
    const existingWords = extractKeywords(group.label);

    // Check for exact match after normalization
    if (existingNormalized === normalizedLabel) {
      return group;
    }

    // Check if labels share significant keywords (at least 50% overlap)
    const commonWords = labelWords.filter(w => existingWords.includes(w));
    const similarity = commonWords.length / Math.max(labelWords.length, existingWords.length);

    if (similarity >= 0.5 && commonWords.length >= 2) {
      return group;
    }

    // Check if one label contains the other (substring match)
    if (existingNormalized.includes(normalizedLabel) || normalizedLabel.includes(existingNormalized)) {
      return group;
    }
  }

  return null;
}

/**
 * Normalize label for comparison
 */
function normalizeLabel(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')  // Remove special chars
    .replace(/\s+/g, ' ')          // Normalize spaces
    .trim();
}

/**
 * Extract meaningful keywords from a label
 */
function extractKeywords(label) {
  const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'];
  return normalizeLabel(label)
    .split(' ')
    .filter(word => word.length > 2 && !stopWords.includes(word));
}

/**
 * Consolidate very small groups (1-2 sessions) into related larger groups
 */
function consolidateSmallGroups(groups) {
  const MIN_GROUP_SIZE = 2;
  const smallGroups = groups.filter(g => g.session_count < MIN_GROUP_SIZE);
  const largeGroups = groups.filter(g => g.session_count >= MIN_GROUP_SIZE);

  // Try to merge each small group into a related large group
  for (const smallGroup of smallGroups) {
    const targetGroup = findSimilarGroup(largeGroups, smallGroup.label);

    if (targetGroup) {
      // Merge small group into large group
      targetGroup.sessions = [...targetGroup.sessions, ...smallGroup.sessions];
      targetGroup.session_ids = [...targetGroup.session_ids, ...smallGroup.session_ids];
      targetGroup.total_seconds += smallGroup.total_seconds;
      targetGroup.session_count += smallGroup.session_count;
      targetGroup.total_time_formatted = formatDuration(targetGroup.total_seconds);
      logger.info('[AI] Merged small group "%s" (%d sessions) into "%s"',
        smallGroup.label, smallGroup.session_count, targetGroup.label);
    } else {
      // No match found, keep as separate group
      largeGroups.push(smallGroup);
    }
  }

  // Sort by session count (largest first)
  return largeGroups.sort((a, b) => b.session_count - a.session_count);
}

/**
 * Format duration in seconds to human-readable format
 */
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  } else if (hours > 0) {
    return `${hours}h`;
  } else if (minutes > 0) {
    if (secs > 0) {
      return `${minutes}m ${secs}s`;
    }
    return `${minutes}m`;
  } else if (secs > 0) {
    return `${secs}s`;
  } else {
    return '0m';
  }
}

/**
 * Get unassigned work summary for a user
 */
exports.getUnassignedWorkSummary = async (sessions) => {
  const totalSeconds = sessions.reduce((sum, s) => sum + (s.time_spent_seconds || 0), 0);
  const applications = [...new Set(sessions.map(s => s.application_name))];

  return {
    total_sessions: sessions.length,
    total_seconds: totalSeconds,
    total_time_formatted: formatDuration(totalSeconds),
    applications: applications,
    date_range: {
      earliest: sessions.length > 0 ? toUTCISOString(new Date(Math.min(...sessions.map(s => new Date(s.timestamp))))) : null,
      latest: sessions.length > 0 ? toUTCISOString(new Date(Math.max(...sessions.map(s => new Date(s.timestamp))))) : null
    }
  };
};
