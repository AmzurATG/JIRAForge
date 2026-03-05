const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { chatCompletionWithFallback, isAIEnabled } = require('./ai/ai-client');
const logger = require('../utils/logger');

/**
 * Extract text from PDF document
 */
exports.extractTextFromPDF = async (pdfBuffer) => {
  try {
    const data = await pdfParse(pdfBuffer);
    return data.text;
  } catch (error) {
    logger.error('PDF extraction error:', error);
    throw new Error(`Failed to extract text from PDF: ${error.message}`);
  }
};

/**
 * Extract text from DOCX document
 */
exports.extractTextFromDocx = async (docxBuffer) => {
  try {
    const result = await mammoth.extractRawText({ buffer: docxBuffer });
    return result.value;
  } catch (error) {
    logger.error('DOCX extraction error:', error);
    throw new Error(`Failed to extract text from DOCX: ${error.message}`);
  }
};

/**
 * Parse requirements from BRD text using AI
 * Uses Fireworks AI as primary, falls back to LiteLLM on consecutive failures
 */
exports.parseRequirements = async (text, context = {}) => {
  if (!isAIEnabled()) {
    throw new Error('AI client not initialized - check API keys');
  }

  try {
    const prompt = buildPrompt(text, context);

    const messages = [
      {
        role: 'system',
        content: 'You are an expert business analyst who extracts structured requirements from Business Requirements Documents (BRDs). You parse the document and create a hierarchical structure of Epics, Stories, and Tasks suitable for Jira. Always respond with valid JSON only.'
      },
      {
        role: 'user',
        content: prompt
      }
    ];

    // Note: userId available from params, but not passed through currently
    // Cost tracking will log without user context for BRD
    const { response, provider, model } = await chatCompletionWithFallback({
      messages,
      temperature: 0.3,
      max_tokens: 4000,
      isVision: false,
      userId: null, // Can be added if userId is passed to this function
      organizationId: null,
      screenshotId: null,
      apiCallName: 'brd-generation'
    });

    const content = response.choices[0].message.content.trim();

    // Parse JSON from the response (handle markdown code blocks)
    let parsedData;
    try {
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) ||
                        content.match(/```\s*([\s\S]*?)\s*```/);
      const jsonString = jsonMatch ? jsonMatch[1] : content;
      parsedData = JSON.parse(jsonString);
    } catch (parseError) {
      logger.error('Failed to parse BRD response as JSON:', {
        contentPreview: content.substring(0, 200),
        error: parseError
      });
      throw new Error('Invalid JSON response from AI');
    }

    logger.info('[BRD] Requirements parsed | %s (%s) | epics: %d, stories: %d, tasks: %d',
      provider, model,
      parsedData.epics?.length || 0,
      parsedData.stories?.length || 0,
      parsedData.tasks?.length || 0
    );

    return {
      epics: parsedData.epics || [],
      stories: parsedData.stories || [],
      tasks: parsedData.tasks || [],
      modelVersion: model,
      aiProvider: provider,
      metadata: {
        tokensUsed: response.usage?.total_tokens || 0,
        finishReason: response.choices[0].finish_reason
      }
    };
  } catch (error) {
    logger.error('Requirements parsing error:', error);
    throw new Error(`Failed to parse requirements: ${error.message}`);
  }
};

/**
 * Build prompt for AI to parse requirements
 */
function buildPrompt(text, context) {
  return `
Extract structured requirements from the following Business Requirements Document.

${context.fileName ? `Document Name: ${context.fileName}` : ''}
${context.projectKey ? `Target Jira Project: ${context.projectKey}` : ''}

Instructions:
1. Identify Epics (major features or themes)
2. Break down Epics into User Stories (specific user-facing functionality)
3. Break down Stories into Technical Tasks (implementation steps)
4. For each item, extract:
   - Title (clear, actionable)
   - Description (detailed requirements)
   - Acceptance Criteria (if mentioned)
   - Priority (High/Medium/Low based on context)
   - Estimated Effort (if mentioned, in story points or hours)

Return a JSON object with this structure:
{
  "epics": [
    {
      "title": "Epic title",
      "description": "Detailed description",
      "stories": ["story_id_1", "story_id_2"],
      "priority": "High/Medium/Low"
    }
  ],
  "stories": [
    {
      "id": "story_id_1",
      "epic_id": "epic_title",
      "title": "User story title",
      "description": "As a [user], I want [feature] so that [benefit]",
      "acceptance_criteria": ["Criterion 1", "Criterion 2"],
      "priority": "High/Medium/Low",
      "tasks": ["task_id_1", "task_id_2"]
    }
  ],
  "tasks": [
    {
      "id": "task_id_1",
      "story_id": "story_id_1",
      "title": "Task title",
      "description": "Technical implementation details",
      "estimated_hours": 8
    }
  ]
}

Document Text:
${text}

Remember to return ONLY valid JSON without any additional text.
`;
}

/**
 * Create Jira issues from parsed requirements
 */
exports.createJiraIssues = async ({ requirements, projectKey, userId }) => {
  try {
    logger.info('Creating Jira issues', {
      projectKey,
      epicsCount: requirements.epics?.length || 0,
      storiesCount: requirements.stories?.length || 0
    });

    

    // This would call the Forge app's API to create Jira issues
    // For now, log the action
    logger.info('Jira issue creation requested', {
      userId,
      projectKey,
      requirementsCount: {
        epics: requirements.epics?.length || 0,
        stories: requirements.stories?.length || 0,
        tasks: requirements.tasks?.length || 0
      }
    });

    // In production, this would:
    // 1. Call Forge app API to create Epics
    // 2. For each Epic, create linked Stories
    // 3. For each Story, create linked Tasks
    // 4. Return the created issue keys


    // Placeholder response
    return [];
  } catch (error) {
    logger.error('Jira issue creation error:', error);
    throw new Error(`Failed to create Jira issues: ${error.message}`);
  }
};
