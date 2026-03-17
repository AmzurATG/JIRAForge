/**
 * Test Script: AI Issue Matching
 *
 * Simulates the exact same pipeline as activity-service.js:
 * 1. Fetches recent activity_records from Supabase
 * 2. Groups by user, extracts user_assigned_issues
 * 3. Builds the same prompts (BATCH_ANALYSIS_SYSTEM_PROMPT + buildBatchAnalysisPrompt)
 * 4. Calls AI via Portkey (same provider as production)
 * 5. Runs validateAnalysisKeys
 * 6. Prints results
 *
 * Usage: node test-matching.js [--limit N] [--status pending|analyzed|all] [--user USER_ID]
 */

require('dotenv').config();
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

// ============================================================================
// EXACT SAME PROMPTS FROM activity-service.js
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
- Return null when there is no clear semantic connection between the activity and a specific issue
- A match requires a meaningful content relationship, not just both being work-related

CONFIDENCE SCORING:
- 0.8-1.0: Direct match (Jira key visible, explicit feature match)
- 0.6-0.7: Strong contextual match (same project area, related functionality)
- 0.4-0.5: Reasonable match (working in project, related to general area)
- 0.2-0.3: Weak match (only project matches, specific task unclear)
- 0.0-0.1: No match possible`;

// EXACT SAME from prompts.js
function formatAssignedIssues(userAssignedIssues) {
  if (!userAssignedIssues || userAssignedIssues.length === 0) {
    return 'None - track all work';
  }

  return userAssignedIssues
    .slice(0, 20)
    .map(issue => {
      let issueText = `- ${issue.key}: ${issue.summary} (Status: ${issue.status})`;
      if (issue.description && issue.description.trim()) {
        const desc = issue.description.length > 200
          ? issue.description.substring(0, 200) + '...'
          : issue.description;
        issueText += `\n  Description: ${desc}`;
      }
      if (issue.labels && issue.labels.length > 0) {
        issueText += `\n  Labels: ${issue.labels.join(', ')}`;
      }
      return issueText;
    })
    .join('\n');
}

// EXACT SAME from activity-service.js
function buildBatchAnalysisPrompt(records, assignedIssuesText) {
  const recordDescriptions = records.map((record, index) => {
    const ocrSnippet = record.ocr_text
      ? record.ocr_text.substring(0, 500)
      : '(no text extracted)';

    return `Record ${index}: [${record.application_name}] ${record.window_title}
  Time: ${record.total_time_seconds}s | ${record.start_time} → ${record.end_time}
  OCR Text: ${ocrSnippet}`;
  }).join('\n\n');

  return `Analyze these activity records and match each to the most relevant Jira issue.
Match based on MEANING, not just keywords. If a window title contains a Jira key, use it. If OCR text references specific features or code related to an issue, match it.

IMPORTANT: When OCR text shows "(no text extracted)", you must rely on:
- The application name (Code.exe = VS Code, chrome.exe = browser, etc.)
- The window title (which often contains file names, project names, or page titles)
- Context from the project key and issue summaries

For development tools with project/file names in the title, match to relevant "In Progress" issues.
For browsers with technical sites in the title, match based on the topic being researched.

CRITICAL: You must ONLY use task keys from the assigned issues list below. NEVER invent, fabricate, or extract issue keys from OCR text, window titles, or any other source. If no assigned issue is a clear semantic match, return taskKey as null. Generic activities (Task Manager, File Explorer, Windows Settings, system utilities, download history) should return null unless they clearly relate to a specific issue.

User's Assigned Issues (from Jira):
${assignedIssuesText}

Activity Records:
${recordDescriptions}

For EACH record, determine:
1. Which Jira issue is the user most likely working on? Return null if the activity has no clear connection to any specific issue.
2. Is this office work or non-office?
3. How confident are you in the match?

Return ONLY valid JSON (no markdown code blocks, no extra text). Your response must be exactly one JSON array:
[
  {
    "recordIndex": 0,
    "taskKey": "PROJECT-123" or null,
    "projectKey": "PROJECT" or null,
    "confidenceScore": 0.0-1.0,
    "workType": "office" or "non-office",
    "reasoning": "Brief explanation"
  }
]
Include one entry per record, in order.`;
}

// EXACT SAME from activity-service.js
function validateAnalysisKeys(analyses, userAssignedIssues) {
  const validKeys = new Set(userAssignedIssues.map(i => i.key));
  for (const analysis of analyses) {
    if (analysis.taskKey && !validKeys.has(analysis.taskKey)) {
      console.log(`  ⚠ HALLUCINATED KEY CAUGHT: ${analysis.taskKey} (not in assigned issues)`);
      analysis.taskKey = null;
      analysis.projectKey = null;
      analysis.confidenceScore = Math.min(analysis.confidenceScore || 0, 0.3);
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  // Parse args
  const args = process.argv.slice(2);
  let limit = 20;
  let statusFilter = 'all'; // pending, analyzed, or all
  let userFilter = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[i + 1]);
    if (args[i] === '--status' && args[i + 1]) statusFilter = args[i + 1];
    if (args[i] === '--user' && args[i + 1]) userFilter = args[i + 1];
  }

  // Init Supabase
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Init Portkey AI client (same as production)
  const portkey = new OpenAI({
    apiKey: process.env.PORTKEY_API_KEY,
    baseURL: 'https://api.portkey.ai/v1',
    defaultHeaders: {
      'x-portkey-config': process.env.PORTKEY_CONFIG_ID,
    },
    timeout: 60000,
    maxRetries: 0,
  });

  console.log('='.repeat(80));
  console.log('AI ISSUE MATCHING TEST');
  console.log(`Provider: Portkey → ${process.env.PORTKEY_MODEL}`);
  console.log(`Filters: status=${statusFilter}, limit=${limit}${userFilter ? ', user=' + userFilter : ''}`);
  console.log('='.repeat(80));

  // Fetch records from Supabase
  let query = supabase
    .from('activity_records')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (statusFilter !== 'all') {
    query = query.eq('status', statusFilter);
  }
  if (userFilter) {
    query = query.eq('user_id', userFilter);
  }

  const { data: records, error } = await query;
  if (error) {
    console.error('Failed to fetch records:', error);
    process.exit(1);
  }

  if (!records || records.length === 0) {
    console.log('\nNo records found matching filters.');
    process.exit(0);
  }

  console.log(`\nFetched ${records.length} records`);

  // Group by user
  const userBatches = {};
  for (const record of records) {
    const key = record.user_id;
    if (!userBatches[key]) userBatches[key] = [];
    userBatches[key].push(record);
  }

  console.log(`Users: ${Object.keys(userBatches).length}\n`);

  // Process each user batch
  for (const [userId, userRecords] of Object.entries(userBatches)) {
    console.log('-'.repeat(80));
    console.log(`USER: ${userId}`);
    console.log(`Records: ${userRecords.length}`);

    // Extract user_assigned_issues from first record that has them
    let userAssignedIssues = [];
    for (const r of userRecords) {
      if (r.user_assigned_issues) {
        try {
          const parsed = typeof r.user_assigned_issues === 'string'
            ? JSON.parse(r.user_assigned_issues)
            : r.user_assigned_issues;
          if (Array.isArray(parsed) && parsed.length > 0) {
            userAssignedIssues = parsed;
            break;
          }
        } catch (e) { /* ignore */ }
      }
    }

    if (userAssignedIssues.length === 0) {
      // Try fetching from user_jira_issues_cache
      const { data: cached } = await supabase
        .from('user_jira_issues_cache')
        .select('issues')
        .eq('user_id', userId)
        .single();
      if (cached?.issues) {
        userAssignedIssues = Array.isArray(cached.issues) ? cached.issues : [];
      }
    }

    console.log(`Assigned Issues: ${userAssignedIssues.length}`);
    if (userAssignedIssues.length > 0) {
      console.log('  Issues:');
      userAssignedIssues.slice(0, 10).forEach(i => {
        console.log(`    ${i.key}: ${i.summary} (${i.status})`);
      });
      if (userAssignedIssues.length > 10) {
        console.log(`    ... and ${userAssignedIssues.length - 10} more`);
      }
    }

    // Show records being analyzed
    console.log('\n  Activity Records:');
    userRecords.forEach((r, i) => {
      const ocrStatus = r.ocr_text ? `OCR: ${r.ocr_text.substring(0, 80)}...` : 'OCR: (none)';
      console.log(`    [${i}] [${r.application_name}] ${r.window_title}`);
      console.log(`        Time: ${r.total_time_seconds}s | ${ocrStatus}`);
      if (r.user_assigned_issue_key) {
        console.log(`        Current match: ${r.user_assigned_issue_key}`);
      }
    });

    // Build prompt (exact same as production)
    const assignedIssuesText = formatAssignedIssues(userAssignedIssues);
    const userPrompt = buildBatchAnalysisPrompt(
      userRecords.map(r => ({
        application_name: r.application_name,
        window_title: r.window_title,
        ocr_text: r.ocr_text,
        total_time_seconds: r.total_time_seconds,
        start_time: r.start_time,
        end_time: r.end_time,
      })),
      assignedIssuesText
    );

    const messages = [
      { role: 'system', content: BATCH_ANALYSIS_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ];

    // Call AI (exact same params as production)
    const maxTokens = Math.max(1500, userRecords.length * 150 + 200);
    console.log(`\n  Calling AI (max_tokens: ${maxTokens})...`);

    try {
      const response = await portkey.chat.completions.create({
        model: process.env.PORTKEY_MODEL || 'gemini-2.0-flash',
        messages,
        temperature: 0.3,
        max_tokens: maxTokens,
      });

      const content = response.choices[0].message.content.trim();

      // Parse response (same logic as production)
      let analyses;
      try {
        analyses = JSON.parse(content);
      } catch {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          analyses = JSON.parse(jsonMatch[0]);
        } else {
          console.error('  FAILED to parse AI response:', content.substring(0, 300));
          continue;
        }
      }

      if (!Array.isArray(analyses)) {
        console.error('  AI response is not an array');
        continue;
      }

      // Validate keys (same as production)
      validateAnalysisKeys(analyses, userAssignedIssues);

      // Display results
      console.log('\n  RESULTS:');
      console.log('  ' + '-'.repeat(70));
      for (const a of analyses) {
        const record = userRecords[a.recordIndex];
        const appName = record?.application_name || '?';
        const windowTitle = record?.window_title || '?';
        const prevMatch = record?.user_assigned_issue_key || '(none)';
        const newMatch = a.taskKey || 'null';
        const matchChanged = prevMatch !== newMatch && prevMatch !== '(none)';

        console.log(`  Record ${a.recordIndex}: [${appName}] ${windowTitle.substring(0, 60)}`);
        console.log(`    Task:       ${newMatch} (confidence: ${a.confidenceScore})`);
        console.log(`    Work Type:  ${a.workType}`);
        console.log(`    Reasoning:  ${a.reasoning}`);
        if (matchChanged) {
          console.log(`    ⚡ CHANGED from previous: ${prevMatch} → ${newMatch}`);
        }
        console.log();
      }

      // Summary
      const matched = analyses.filter(a => a.taskKey !== null).length;
      const unmatched = analyses.filter(a => a.taskKey === null).length;
      console.log(`  Summary: ${matched} matched, ${unmatched} null (no match)`);
      console.log(`  Model: ${response.model || 'unknown'}`);
      console.log(`  Tokens: prompt=${response.usage?.prompt_tokens || '?'}, completion=${response.usage?.completion_tokens || '?'}`);

    } catch (err) {
      console.error(`  AI call failed: ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('TEST COMPLETE');
  console.log('='.repeat(80));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
