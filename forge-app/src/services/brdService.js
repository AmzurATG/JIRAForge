/**
 * BRD Service
 * Business logic for BRD document upload and issue creation
 */

// eslint-disable-next-line deprecation/deprecation
import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization, supabaseRequest, uploadToSupabaseStorage } from '../utils/supabase.js';
import { createJiraIssue } from '../utils/jira.js';
import { ALLOWED_BRD_FILE_TYPES } from '../config/constants.js';
import { isValidUUID, isValidProjectKey } from '../utils/validators.js';

/**
 * Create a task under a story in Jira
 * @param {string} projectKey - Jira project key
 * @param {Object} task - Task data
 * @param {string} storyKey - Parent story key
 * @returns {Promise<Object>} Created issue result or error
 */
async function createTask(projectKey, task, storyKey) {
  try {
    const taskData = await createJiraIssue(projectKey, {
      summary: task.summary || task.name,
      description: task.description || '',
      issuetype: { name: 'Task' },
      parent: { key: storyKey }
    });

    return {
      key: taskData.key,
      id: taskData.id,
      type: 'Task',
      summary: task.summary || task.name,
      parent: storyKey
    };
  } catch (taskError) {
    console.error('Error creating task:', taskError);
    return {
      error: `Failed to create task: ${task.summary || task.name}`,
      details: taskError.message
    };
  }
}

/**
 * Create tasks for a story
 * @param {string} projectKey - Jira project key
 * @param {Array} tasks - Array of task data
 * @param {string} storyKey - Parent story key
 * @returns {Promise<Array>} Array of created task results
 */
async function createTasksForStory(projectKey, tasks, storyKey) {
  const results = [];
  for (const task of tasks) {
    const result = await createTask(projectKey, task, storyKey);
    results.push(result);
  }
  return results;
}

/**
 * Create a story under an epic in Jira
 * @param {string} projectKey - Jira project key
 * @param {Object} story - Story data
 * @param {string} epicKey - Parent epic key
 * @returns {Promise<Array>} Array of created issue results (story and its tasks)
 */
async function createStory(projectKey, story, epicKey) {
  const results = [];
  try {
    const storyData = await createJiraIssue(projectKey, {
      summary: story.summary || story.name,
      description: story.description || '',
      issuetype: { name: 'Story' },
      parent: { key: epicKey }
    });

    results.push({
      key: storyData.key,
      id: storyData.id,
      type: 'Story',
      summary: story.summary || story.name,
      parent: epicKey
    });

    // Create Tasks under this Story
    if (story.tasks && Array.isArray(story.tasks)) {
      const taskResults = await createTasksForStory(projectKey, story.tasks, storyData.key);
      results.push(...taskResults);
    }
  } catch (storyError) {
    console.error('Error creating story:', storyError);
    results.push({
      error: `Failed to create story: ${story.summary || story.name}`,
      details: storyError.message
    });
  }
  return results;
}

/**
 * Create stories for an epic
 * @param {string} projectKey - Jira project key
 * @param {Array} stories - Array of story data
 * @param {string} epicKey - Parent epic key
 * @returns {Promise<Array>} Array of created issue results
 */
async function createStoriesForEpic(projectKey, stories, epicKey) {
  const results = [];
  for (const story of stories) {
    const storyResults = await createStory(projectKey, story, epicKey);
    results.push(...storyResults);
  }
  return results;
}

/**
 * Create an epic with its stories and tasks in Jira
 * @param {string} projectKey - Jira project key
 * @param {Object} epic - Epic data
 * @returns {Promise<Array>} Array of created issue results
 */
async function createEpic(projectKey, epic) {
  const results = [];
  try {
    const epicData = await createJiraIssue(projectKey, {
      summary: epic.summary || epic.name,
      description: epic.description || '',
      issuetype: { name: 'Epic' },
      ...(epic.name && { customfield_10011: epic.name }) // Epic Name field
    });

    results.push({
      key: epicData.key,
      id: epicData.id,
      type: 'Epic',
      summary: epic.summary || epic.name
    });

    // Create Stories under this Epic
    if (epic.stories && Array.isArray(epic.stories)) {
      const storyResults = await createStoriesForEpic(projectKey, epic.stories, epicData.key);
      results.push(...storyResults);
    }
  } catch (epicError) {
    console.error('Error creating epic:', epicError);
    results.push({
      error: `Failed to create epic: ${epic.summary || epic.name}`,
      details: epicError.message
    });
  }
  return results;
}

/**
 * Create all epics from requirements
 * @param {string} projectKey - Jira project key
 * @param {Array} epics - Array of epic data
 * @returns {Promise<Array>} Array of all created issue results
 */
async function createAllEpics(projectKey, epics) {
  const results = [];
  for (const epic of epics) {
    const epicResults = await createEpic(projectKey, epic);
    results.push(...epicResults);
  }
  return results;
}

/**
 * Upload BRD document to Supabase
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for organization filtering
 * @param {string} fileName - Original file name
 * @param {string} fileType - MIME type
 * @param {string} fileData - Base64 encoded file data
 * @param {number} fileSize - File size in bytes
 * @returns {Promise<Object>} Document metadata with ID
 */
export async function uploadBRDDocument(accountId, cloudId, fileName, fileType, fileData, fileSize) {
  // eslint-disable-next-line deprecation/deprecation
  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    throw new Error('Supabase not configured. Please configure in Settings.');
  }

  // Get or create organization first (multi-tenancy)
  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) {
    throw new Error('Unable to get organization information');
  }

  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  if (!userId) {
    throw new Error('Unable to get user information');
  }

  // Validate file type
  if (!ALLOWED_BRD_FILE_TYPES.includes(fileType)) {
    throw new Error('Invalid file type. Only PDF and DOCX files are supported.');
  }

  // Convert base64 to Uint8Array (Forge doesn't support Buffer)
  const base64String = fileData.replace(/^data:.*,/, ''); // Remove data URL prefix if present
  const binaryString = atob(base64String);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.codePointAt(i);
  }

  const fileExtension = fileType.includes('pdf') ? 'pdf' : 'docx';
  const storagePath = `${userId}/${Date.now()}_${fileName}`;

  // Upload to Supabase Storage
  await uploadToSupabaseStorage(supabaseConfig, 'documents', storagePath, bytes, fileType);

  const storageUrl = `${supabaseConfig.url}/storage/v1/object/public/documents/${storagePath}`;

  // Save document metadata to database - include organization_id for multi-tenancy
  // eslint-disable-next-line deprecation/deprecation
  const documentRecord = await supabaseRequest(
    supabaseConfig,
    'documents',
    {
      method: 'POST',
      body: {
        user_id: userId,
        organization_id: organization.id,
        file_name: fileName,
        file_type: fileExtension,
        file_size_bytes: fileSize,
        storage_url: storageUrl,
        storage_path: storagePath,
        processing_status: 'uploaded'
      }
    }
  );

  return {
    documentId: documentRecord[0].id,
    message: 'Document uploaded successfully. Processing will begin shortly.'
  };
}

/**
 * Create Jira issues from parsed BRD document
 * @param {string} accountId - Atlassian account ID
 * @param {string} documentId - Document ID
 * @param {string} projectKey - Jira project key
 * @returns {Promise<Object>} Created issues metadata
 */
export async function createIssuesFromBRD(accountId, documentId, projectKey) {
  // Validate inputs
  if (!isValidUUID(documentId)) {
    throw new Error('Invalid document ID format');
  }
  if (!isValidProjectKey(projectKey)) {
    throw new Error('Invalid project key format');
  }

  // eslint-disable-next-line deprecation/deprecation
  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    throw new Error('Supabase not configured. Please configure in Settings.');
  }

  // Fetch processed BRD data from Supabase
  // eslint-disable-next-line deprecation/deprecation
  const documents = await supabaseRequest(
    supabaseConfig,
    `documents?id=eq.${documentId}&select=*`
  );

  if (!documents || documents.length === 0) {
    throw new Error('Document not found');
  }

  const document = documents[0];

  if (document.processing_status !== 'completed') {
    throw new Error(`Document is still processing. Current status: ${document.processing_status}`);
  }

  if (!document.parsed_requirements) {
    throw new Error('Document has not been parsed yet. Please wait for processing to complete.');
  }

  const requirements = document.parsed_requirements;
  
  // Create all epics with their stories and tasks
  const createdIssues = requirements.epics && Array.isArray(requirements.epics)
    ? await createAllEpics(projectKey, requirements.epics)
    : [];

  // Update document with created issues
  // eslint-disable-next-line deprecation/deprecation
  await supabaseRequest(
    supabaseConfig,
    `documents?id=eq.${documentId}`,
    {
      method: 'PATCH',
      body: {
        created_issues: createdIssues,
        project_key: projectKey
      }
    }
  );

  return {
    createdIssues,
    message: `Successfully created ${createdIssues.filter(i => i.key).length} issues`
  };
}

/**
 * Get BRD document status and created issues
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for organization filtering
 * @param {string} documentId - Document ID
 * @returns {Promise<Object>} Document data
 */
export async function getBRDStatus(accountId, cloudId, documentId) {
  // Validate documentId format
  if (!isValidUUID(documentId)) {
    throw new Error('Invalid document ID format');
  }

  // eslint-disable-next-line deprecation/deprecation
  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    throw new Error('Supabase not configured. Please configure in Settings.');
  }

  // Get or create organization first (multi-tenancy)
  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) {
    throw new Error('Unable to get organization information');
  }

  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  if (!userId) {
    throw new Error('Unable to get user information');
  }

  // Filter by organization_id for multi-tenancy
  // eslint-disable-next-line deprecation/deprecation
  const documents = await supabaseRequest(
    supabaseConfig,
    `documents?id=eq.${documentId}&user_id=eq.${userId}&organization_id=eq.${organization.id}&select=*`
  );

  if (!documents || documents.length === 0) {
    throw new Error('Document not found');
  }

  return documents[0];
}
