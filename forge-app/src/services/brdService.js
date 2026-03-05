/**
 * BRD Service
 * Business logic for BRD document upload and issue creation
 */

import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization, supabaseRequest, uploadToSupabaseStorage } from '../utils/supabase.js';
import { createJiraIssue } from '../utils/jira.js';
import { ALLOWED_BRD_FILE_TYPES } from '../config/constants.js';
import { isValidUUID, isValidProjectKey } from '../utils/validators.js';

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
  const base64String = fileData.replaceAll(/^data:.*,/g, ''); // Remove data URL prefix if present
  const binaryString = atob(base64String);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const fileExtension = fileType.includes('pdf') ? 'pdf' : 'docx';
  const storagePath = `${userId}/${Date.now()}_${fileName}`;

  // Upload to Supabase Storage
  await uploadToSupabaseStorage(supabaseConfig, 'documents', storagePath, bytes, fileType);

  const storageUrl = `${supabaseConfig.url}/storage/v1/object/public/documents/${storagePath}`;

  // Save document metadata to database - include organization_id for multi-tenancy
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

  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    throw new Error('Supabase not configured. Please configure in Settings.');
  }

  // Fetch processed BRD data from Supabase
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
  const createdIssues = [];

  // Create Epics first
  if (requirements.epics && Array.isArray(requirements.epics)) {
    for (const epic of requirements.epics) {
      try {
        const epicData = await createJiraIssue(projectKey, {
          summary: epic.summary || epic.name,
          description: epic.description || '',
          issuetype: { name: 'Epic' },
          ...(epic.name && { customfield_10011: epic.name }) // Epic Name field
        });

        createdIssues.push({
          key: epicData.key,
          id: epicData.id,
          type: 'Epic',
          summary: epic.summary || epic.name
        });

        // Create Stories under this Epic
        if (epic.stories && Array.isArray(epic.stories)) {
          for (const story of epic.stories) {
            try {
              const storyData = await createJiraIssue(projectKey, {
                summary: story.summary || story.name,
                description: story.description || '',
                issuetype: { name: 'Story' },
                parent: { key: epicData.key }
              });

              createdIssues.push({
                key: storyData.key,
                id: storyData.id,
                type: 'Story',
                summary: story.summary || story.name,
                parent: epicData.key
              });

              // Create Tasks under this Story
              if (story.tasks && Array.isArray(story.tasks)) {
                for (const task of story.tasks) {
                  try {
                    const taskData = await createJiraIssue(projectKey, {
                      summary: task.summary || task.name,
                      description: task.description || '',
                      issuetype: { name: 'Task' },
                      parent: { key: storyData.key }
                    });

                    createdIssues.push({
                      key: taskData.key,
                      id: taskData.id,
                      type: 'Task',
                      summary: task.summary || task.name,
                      parent: storyData.key
                    });
                  } catch (taskError) {
                    console.error('Error creating task:', taskError);
                    createdIssues.push({
                      error: `Failed to create task: ${task.summary || task.name}`,
                      details: taskError.message
                    });
                  }
                }
              }
            } catch (storyError) {
              console.error('Error creating story:', storyError);
              createdIssues.push({
                error: `Failed to create story: ${story.summary || story.name}`,
                details: storyError.message
              });
            }
          }
        }
      } catch (epicError) {
        console.error('Error creating epic:', epicError);
        createdIssues.push({
          error: `Failed to create epic: ${epic.summary || epic.name}`,
          details: epicError.message
        });
      }
    }
  }

  // Update document with created issues
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
  const documents = await supabaseRequest(
    supabaseConfig,
    `documents?id=eq.${documentId}&user_id=eq.${userId}&organization_id=eq.${organization.id}&select=*`
  );

  if (!documents || documents.length === 0) {
    throw new Error('Document not found');
  }

  return documents[0];
}
