/**
 * Feedback Service
 * Orchestrates AI analysis of user feedback and Jira ticket creation
 */

const axios = require('axios');
const FormData = require('form-data');
const logger = require('../utils/logger');
const { chatCompletionWithFallback } = require('./ai/ai-client');
const { FEEDBACK_ANALYSIS_SYSTEM_PROMPT, buildFeedbackAnalysisPrompt } = require('./ai/feedback-prompts');
const { getFeedbackById, updateFeedbackStatus, updateFeedbackAIResults } = require('./db/feedback-db-service');
const { downloadFile } = require('./db/storage-service');

/**
 * Validate required Jira environment variables
 * @returns {Object|null} Error object if validation fails, null if valid
 */
function validateJiraEnvVars() {
  const projectKey = process.env.JIRA_FEEDBACK_PROJECT;
  const jiraSiteUrl = process.env.JIRA_FEEDBACK_SITE_URL;
  const jiraEmail = process.env.JIRA_FEEDBACK_EMAIL;
  const jiraApiToken = process.env.JIRA_FEEDBACK_API_TOKEN;

  if (projectKey && jiraSiteUrl && jiraEmail && jiraApiToken) {
    return null;
  }

  const missing = [];
  if (!projectKey) missing.push('JIRA_FEEDBACK_PROJECT');
  if (!jiraSiteUrl) missing.push('JIRA_FEEDBACK_SITE_URL');
  if (!jiraEmail) missing.push('JIRA_FEEDBACK_EMAIL');
  if (!jiraApiToken) missing.push('JIRA_FEEDBACK_API_TOKEN');

  return {
    missing,
    error: `Server configuration incomplete: missing ${missing.join(', ')}`
  };
}

/**
 * Get default AI results when AI analysis fails
 * @param {Object} feedback - Feedback record
 * @returns {Object} Default AI results
 */
function getDefaultAIResults(feedback) {
  return {
    title: feedback.title || `[${feedback.category}] User Feedback`,
    summary: feedback.description,
    issueType: feedback.category === 'bug' ? 'Bug' : 'Task',
    priority: 'Medium',
    labels: [feedback.category.replace('_', '-')]
  };
}

/**
 * Parse JSON from AI response (handles markdown wrapping)
 * @param {string} content - AI response content
 * @returns {Object} Parsed JSON object
 */
function parseAIResponse(content) {
  const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(jsonStr);
}

/**
 * Check if error is related to priority or labels fields
 * @param {Object} error - Axios error
 * @returns {boolean} True if error is related to priority/labels
 */
function isPriorityOrLabelsError(error) {
  const errors = error.response?.data?.errors;
  return errors && (errors.priority || errors.labels);
}

/**
 * Extract error message from Jira API response
 * @param {Object} error - Axios error
 * @returns {string} Error message
 */
function extractJiraErrorMessage(error) {
  const errors = error.response?.data?.errors;
  if (errors) {
    return JSON.stringify(errors);
  }
  return error.response?.data?.errorMessages?.join(', ') || error.message;
}

/**
 * Get file extension from filename
 * @param {string} filename - Filename with extension
 * @returns {string} File extension (lowercase) or empty string
 */
function getFileExtension(filename) {
  if (typeof filename !== 'string') {
    return '';
  }

  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex === -1 || lastDotIndex === filename.length - 1) {
    return '';
  }

  return filename.slice(lastDotIndex + 1).toLowerCase();
}

/**
 * Extract filename from storage path
 * @param {string} path - Storage path
 * @param {number} index - Image index for fallback name
 * @returns {string} Filename
 */
function extractFilenameFromPath(path, index) {
  const extracted = path ? path.split('/').filter(Boolean).pop() : '';
  return extracted || `screenshot_${index + 1}.png`;
}

/**
 * Perform AI analysis on feedback
 * @param {string} feedbackId - Feedback ID
 * @param {Object} feedback - Feedback record
 * @returns {Promise<Object>} AI results
 */
async function performAIAnalysis(feedbackId, feedback) {
  try {
    const aiResults = await analyzeFeedbackWithAI(feedback);
    await updateFeedbackAIResults(feedbackId, {
      ai_summary: aiResults.summary,
      ai_priority: aiResults.priority,
      ai_labels: aiResults.labels,
      ai_issue_type: aiResults.issueType,
      title: feedback.title ? undefined : aiResults.title
    });
    return aiResults;
  } catch (aiError) {
    logger.warn('[Feedback] AI analysis failed for %s, using defaults: %s', feedbackId, aiError.message);
    return getDefaultAIResults(feedback);
  }
}

/**
 * Create Jira ticket with images
 * @param {string} feedbackId - Feedback ID
 * @param {Object} feedback - Feedback record
 * @param {Object} aiResults - AI analysis results
 * @returns {Promise<void>}
 */
async function createJiraTicketWithImages(feedbackId, feedback, aiResults) {
  const projectKey = process.env.JIRA_FEEDBACK_PROJECT;
  const jiraSiteUrl = process.env.JIRA_FEEDBACK_SITE_URL;
  const jiraEmail = process.env.JIRA_FEEDBACK_EMAIL;
  const jiraApiToken = process.env.JIRA_FEEDBACK_API_TOKEN;

  const jiraResult = await createJiraIssue(jiraEmail, jiraApiToken, jiraSiteUrl, {
    projectKey,
    title: aiResults.title || feedback.title || `[${feedback.category}] User Feedback`,
    description: feedback.description,
    aiSummary: aiResults.summary,
    issueType: aiResults.issueType,
    priority: aiResults.priority,
    labels: aiResults.labels,
    category: feedback.category,
    reporterName: feedback.user_display_name,
    reporterEmail: feedback.user_email
  });

  // Attach images if any exist
  if (feedback.image_paths?.length > 0) {
    try {
      await attachImagesToJiraIssue(
        jiraEmail,
        jiraApiToken,
        jiraSiteUrl,
        jiraResult.key,
        feedback.image_paths
      );
      logger.info('[Feedback] Attached %d images to ticket %s', feedback.image_paths.length, jiraResult.key);
    } catch (attachError) {
      logger.error('[Feedback] Failed to attach images to %s: %s', jiraResult.key, attachError.message);
      // Don't fail the entire process if attachments fail
    }
  }

  // Update DB with Jira info
  await updateFeedbackStatus(feedbackId, 'created', {
    jira_issue_key: jiraResult.key,
    jira_issue_url: jiraResult.url
  });

  logger.info('[Feedback] Jira ticket %s created for feedback %s', jiraResult.key, feedbackId);
}

/**
 * Process feedback: AI analysis -> Jira ticket creation -> DB update
 * Runs asynchronously after feedback submission.
 * All tickets are created on a single configured Jira instance using
 * server-side API token credentials (JIRA_FEEDBACK_* env vars).
 * @param {string} feedbackId - Feedback record ID
 */
async function processAndCreateJiraTicket(feedbackId) {
  try {
    // Mark as processing
    await updateFeedbackStatus(feedbackId, 'processing');

    // Fetch feedback from DB
    const feedback = await getFeedbackById(feedbackId);
    if (!feedback) {
      logger.error('[Feedback] Feedback %s not found', feedbackId);
      return;
    }

    // Validate Jira environment variables
    const envValidation = validateJiraEnvVars();
    if (envValidation) {
      logger.error('[Feedback] Missing env vars: %s', envValidation.missing.join(', '));
      await updateFeedbackStatus(feedbackId, 'failed', { error: envValidation.error });
      return;
    }

    // Step 1: AI analysis
    const aiResults = await performAIAnalysis(feedbackId, feedback);

    // Step 2: Create Jira issue and attach images
    try {
      await createJiraTicketWithImages(feedbackId, feedback, aiResults);
    } catch (jiraError) {
      logger.error('[Feedback] Jira creation failed for %s: %s', feedbackId, jiraError.message);
      await updateFeedbackStatus(feedbackId, 'failed', { error: jiraError.message });
    }
  } catch (error) {
    logger.error('[Feedback] Error processing feedback %s:', feedbackId, error);
    try {
      await updateFeedbackStatus(feedbackId, 'failed', { error: error.message });
    } catch (dbError) {
      logger.error('[Feedback] Failed to update error status:', dbError);
    }
  }
}

/**
 * Analyze feedback with AI to generate structured Jira content
 * @param {Object} feedback - Feedback record from DB
 * @returns {Promise<Object>} AI analysis results
 */
async function analyzeFeedbackWithAI(feedback) {
  const prompt = buildFeedbackAnalysisPrompt({
    category: feedback.category,
    title: feedback.title,
    description: feedback.description
  });

  const { response } = await chatCompletionWithFallback({
    messages: [
      { role: 'system', content: FEEDBACK_ANALYSIS_SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    temperature: 0.3,
    max_tokens: 1000,
    isVision: false,
    apiCallName: 'feedback-analysis'
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Empty AI response');
  }

  // Parse JSON from response (handle possible markdown wrapping)
  let parsed;
  try {
    parsed = parseAIResponse(content);
  } catch (parseError) {
    logger.warn('[Feedback] Failed to parse AI response: %s', content.substring(0, 200));
    throw new Error('Failed to parse AI response as JSON');
  }

  return {
    title: parsed.title,
    summary: parsed.summary,
    issueType: parsed.issueType || 'Task',
    priority: parsed.priority || 'Medium',
    labels: Array.isArray(parsed.labels) ? parsed.labels : []
  };
}

/**
 * Fetch available issue types for a Jira project.
 * @param {string} email - Atlassian account email
 * @param {string} apiToken - Atlassian API token
 * @param {string} siteUrl - Jira site URL
 * @param {string} projectKey - Project key
 * @returns {Promise<string[]>} Array of available issue type names
 */
async function getProjectIssueTypes(email, apiToken, siteUrl, projectKey) {
  const basicAuth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const baseUrl = siteUrl.replace(/\/$/, '');

  const response = await axios.get(
    `${baseUrl}/rest/api/3/project/${projectKey}`,
    {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Accept': 'application/json'
      },
      timeout: 15000
    }
  );

  const issueTypes = response.data.issueTypes || [];
  return issueTypes
    .filter(t => !t.subtask)
    .map(t => t.name);
}

/**
 * Resolve a valid issue type from available project issue types
 * @param {string} email - Atlassian account email
 * @param {string} apiToken - Atlassian API token
 * @param {string} siteUrl - Jira site URL
 * @param {string} projectKey - Project key
 * @param {string} requestedType - Requested issue type
 * @returns {Promise<string>} Resolved issue type name
 */
async function resolveIssueType(email, apiToken, siteUrl, projectKey, requestedType) {
  let resolvedType = requestedType || 'Task';
  
  try {
    const availableTypes = await getProjectIssueTypes(email, apiToken, siteUrl, projectKey);
    logger.info('[Feedback] Available issue types for %s: %s', projectKey, availableTypes.join(', '));

    if (availableTypes.length === 0) {
      return resolvedType;
    }

    // Try exact match first (case-insensitive)
    const exactMatch = availableTypes.find(
      t => t.toLowerCase() === resolvedType.toLowerCase()
    );

    if (exactMatch) {
      return exactMatch;
    }

    // Fall back to Task, then first available
    const taskType = availableTypes.find(t => t.toLowerCase() === 'task');
    resolvedType = taskType || availableTypes[0];
    logger.info('[Feedback] Issue type "%s" not available, using "%s"', requestedType, resolvedType);
    
    return resolvedType;
  } catch (err) {
    logger.warn('[Feedback] Could not fetch issue types, using "%s": %s', resolvedType, err.message);
    return resolvedType;
  }
}

/**
 * Build ADF (Atlassian Document Format) description content
 * @param {Object} data - Description data
 * @returns {Array} ADF content array
 */
function buildADFDescription(data) {
  const { aiSummary, description, category, reporterName, reporterEmail } = data;
  const content = [];

  // AI Summary section
  if (aiSummary) {
    content.push({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: 'Summary' }]
    });
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: aiSummary }]
    });
  }

  // Original description
  content.push({
    type: 'heading',
    attrs: { level: 3 },
    content: [{ type: 'text', text: 'User Description' }]
  });
  content.push({
    type: 'paragraph',
    content: [{ type: 'text', text: description }]
  });

  // Metadata section
  content.push({
    type: 'heading',
    attrs: { level: 3 },
    content: [{ type: 'text', text: 'Details' }]
  });
  content.push({
    type: 'bulletList',
    content: [
      {
        type: 'listItem',
        content: [{
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Category: ', marks: [{ type: 'strong' }] },
            { type: 'text', text: category }
          ]
        }]
      },
      {
        type: 'listItem',
        content: [{
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Submitted by: ', marks: [{ type: 'strong' }] },
            { type: 'text', text: `${reporterName || 'Unknown'} (${reporterEmail || 'N/A'})` }
          ]
        }]
      },
      {
        type: 'listItem',
        content: [{
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Source: ', marks: [{ type: 'strong' }] },
            { type: 'text', text: 'Desktop App Feedback Form' }
          ]
        }]
      }
    ]
  });

  return content;
}

/**
 * Build Jira issue request body
 * @param {Object} data - Issue data
 * @param {string} resolvedIssueType - Resolved issue type name
 * @returns {Object} Request body
 */
function buildJiraRequestBody(data, resolvedIssueType) {
  const { projectKey, title, description, aiSummary, priority, labels, category, reporterName, reporterEmail } = data;
  
  const adfContent = buildADFDescription({ aiSummary, description, category, reporterName, reporterEmail });
  
  const requestBody = {
    fields: {
      project: { key: projectKey },
      summary: title,
      description: {
        type: 'doc',
        version: 1,
        content: adfContent
      },
      issuetype: { name: resolvedIssueType }
    }
  };

  // Add optional fields
  if (priority) {
    requestBody.fields.priority = { name: priority };
  }
  if (labels?.length > 0) {
    requestBody.fields.labels = labels;
  }

  return requestBody;
}

/**
 * Execute Jira API request with optional retry on priority/labels errors
 * @param {string} apiUrl - Jira API URL
 * @param {Object} requestBody - Request body
 * @param {string} authHeader - Authorization header value
 * @param {string} baseUrl - Base Jira URL
 * @returns {Promise<Object>} Created issue data
 */
async function executeJiraRequest(apiUrl, requestBody, authHeader, baseUrl) {
  const headers = {
    'Authorization': authHeader,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };

  try {
    const response = await axios.post(apiUrl, requestBody, {
      headers,
      timeout: 30000
    });

    return {
      key: response.data.key,
      url: `${baseUrl}/browse/${response.data.key}`,
      id: response.data.id
    };
  } catch (error) {
    // If priority or labels caused the failure, retry without them
    if (!isPriorityOrLabelsError(error)) {
      throw error;
    }

    logger.warn('[Feedback] Retrying without priority/labels due to: %s', 
      JSON.stringify(error.response.data.errors));
    
    delete requestBody.fields.priority;
    delete requestBody.fields.labels;

    const retryResponse = await axios.post(apiUrl, requestBody, {
      headers,
      timeout: 30000
    });

    return {
      key: retryResponse.data.key,
      url: `${baseUrl}/browse/${retryResponse.data.key}`,
      id: retryResponse.data.id
    };
  }
}

/**
 * Create a Jira issue via Atlassian REST API using basic auth (API token).
 * All tickets go to a single configured Jira instance.
 * Uses direct site URL (e.g., https://yoursite.atlassian.net) for Basic auth.
 * @param {string} email - Atlassian account email for basic auth
 * @param {string} apiToken - Atlassian API token for basic auth
 * @param {string} siteUrl - Jira site URL (e.g., https://timetracker.atlassian.net)
 * @param {Object} issueData - Issue data
 * @returns {Promise<Object>} Created issue { key, url }
 */
async function createJiraIssue(email, apiToken, siteUrl, issueData) {
  const { projectKey, issueType } = issueData;

  // Resolve a valid issue type for this project
  const resolvedIssueType = await resolveIssueType(email, apiToken, siteUrl, projectKey, issueType);

  // Build request body with ADF description
  const requestBody = buildJiraRequestBody(issueData, resolvedIssueType);

  // Prepare authentication and URLs
  const basicAuth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const authHeader = `Basic ${basicAuth}`;
  const baseUrl = siteUrl.replace(/\/$/, '');
  const apiUrl = `${baseUrl}/rest/api/3/issue`;

  // Execute request with automatic retry on priority/labels errors
  try {
    return await executeJiraRequest(apiUrl, requestBody, authHeader, baseUrl);
  } catch (error) {
    const errorMsg = extractJiraErrorMessage(error);
    logger.error('[Feedback] Jira API error: %s', errorMsg);
    throw new Error(`Jira API error: ${errorMsg}`);
  }
}

/**
 * Attach a single image to Jira issue
 * @param {string} basicAuth - Base64 encoded basic auth
 * @param {string} attachmentUrl - Jira attachment API URL
 * @param {string} imagePath - Image path in Supabase storage
 * @param {number} index - Image index
 * @param {number} total - Total number of images
 * @param {string} issueKey - Jira issue key
 * @returns {Promise<void>}
 */
async function attachSingleImage(basicAuth, attachmentUrl, imagePath, index, total, issueKey) {
  // Download image from Supabase storage
  logger.info('[Feedback] Downloading image %d/%d: %s', index + 1, total, imagePath);
  const imageBuffer = await downloadFile('feedback-images', imagePath);

  // Extract filename from path
  const filename = extractFilenameFromPath(imagePath, index);

  // Create form data with the image
  const formData = new FormData();
  formData.append('file', imageBuffer, {
    filename: filename,
    contentType: getContentTypeFromFilename(filename)
  });

  // Upload to Jira
  logger.info('[Feedback] Uploading image to Jira: %s', filename);
  await axios.post(attachmentUrl, formData, {
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'X-Atlassian-Token': 'no-check', // Required for attachment uploads
      ...formData.getHeaders()
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 30000
  });

  logger.info('[Feedback] Successfully attached image %d/%d to %s', index + 1, total, issueKey);
}

/**
 * Attach images from Supabase storage to a Jira issue
 * Downloads each image from Supabase and uploads it as an attachment to the Jira issue
 * @param {string} email - Atlassian account email for basic auth
 * @param {string} apiToken - Atlassian API token for basic auth
 * @param {string} siteUrl - Jira site URL
 * @param {string} issueKey - Jira issue key (e.g., 'FEEDBACK-123')
 * @param {string[]} imagePaths - Array of image paths in Supabase storage
 * @returns {Promise<void>}
 */
async function attachImagesToJiraIssue(email, apiToken, siteUrl, issueKey, imagePaths) {
  const basicAuth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const baseUrl = siteUrl.replace(/\/$/, '');
  const attachmentUrl = `${baseUrl}/rest/api/3/issue/${issueKey}/attachments`;

  logger.info('[Feedback] Attaching %d images to Jira issue %s', imagePaths.length, issueKey);

  for (let i = 0; i < imagePaths.length; i++) {
    try {
      await attachSingleImage(basicAuth, attachmentUrl, imagePaths[i], i, imagePaths.length, issueKey);
    } catch (error) {
      logger.error('[Feedback] Failed to attach image %s to %s: %s',
        imagePaths[i], issueKey, error.message);
      // Continue with next image even if one fails
    }
  }
}

/**
 * Get MIME type from filename extension
 * @param {string} filename - Filename with extension
 * @returns {string} MIME type
 */
function getContentTypeFromFilename(filename) {
  const ext = getFileExtension(filename);
  
  if (!ext) {
    return 'application/octet-stream';
  }

  const mimeTypes = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp'
  };
  
  return mimeTypes[ext] || 'application/octet-stream';
}

module.exports = {
  processAndCreateJiraTicket,
  analyzeFeedbackWithAI,
  createJiraIssue,
  attachImagesToJiraIssue
};
