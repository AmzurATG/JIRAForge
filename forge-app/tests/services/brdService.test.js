'use strict';

// ---------------------------------------------------------------------------
// Mocks — hoisted before all imports by babel-jest
// ---------------------------------------------------------------------------

jest.mock('../../src/utils/supabase.js', () => ({
  __esModule: true,
  getSupabaseConfig: jest.fn(),
  getOrCreateUser: jest.fn(),
  getOrCreateOrganization: jest.fn(),
  supabaseRequest: jest.fn(),
  uploadToSupabaseStorage: jest.fn(),
}));

jest.mock('../../src/utils/jira.js', () => ({
  __esModule: true,
  createJiraIssue: jest.fn(),
}));

jest.mock('../../src/config/constants.js', () => ({
  __esModule: true,
  ALLOWED_BRD_FILE_TYPES: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
  ],
}));

jest.mock('../../src/utils/validators.js', () => ({
  __esModule: true,
  isValidUUID: jest.fn(),
  isValidProjectKey: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

const {
  getSupabaseConfig,
  getOrCreateUser,
  getOrCreateOrganization,
  supabaseRequest,
  uploadToSupabaseStorage,
} = require('../../src/utils/supabase.js');

const { createJiraIssue } = require('../../src/utils/jira.js');
const { isValidUUID, isValidProjectKey } = require('../../src/utils/validators.js');
const { uploadBRDDocument, createIssuesFromBRD, getBRDStatus } = require('../../src/services/brdService.js');

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const VALID_UUID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const VALID_PROJECT_KEY = 'PROJ';
const MOCK_CONFIG = { url: 'remote:ai-server', isRemoteMode: true };
const MOCK_ORG = { id: 'org-uuid-001' };
const MOCK_USER_ID = 'user-uuid-001';
const MOCK_DOC_ID = 'doc-uuid-001';

// Minimal valid base64 strings for upload tests
// "%PDF-1" in base64 → valid atob input
const BASE64_PDF = 'JVBERi0x';
const DATA_URL_PDF = `data:application/pdf;base64,${BASE64_PDF}`;

// ---------------------------------------------------------------------------
// Suppress console.error from catch blocks
// ---------------------------------------------------------------------------

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.error.mockRestore();
});

// ===========================================================================
// uploadBRDDocument
// ===========================================================================

describe('uploadBRDDocument', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSupabaseConfig.mockResolvedValue(MOCK_CONFIG);
    getOrCreateOrganization.mockResolvedValue(MOCK_ORG);
    getOrCreateUser.mockResolvedValue(MOCK_USER_ID);
    uploadToSupabaseStorage.mockResolvedValue(undefined);
    supabaseRequest.mockResolvedValue([{ id: MOCK_DOC_ID }]);
  });

  // ── guard clauses ─────────────────────────────────────────────────────────

  it('throws when supabaseConfig is null', async () => {
    getSupabaseConfig.mockResolvedValue(null);
    await expect(
      uploadBRDDocument('acc', 'cloud', 'file.pdf', 'application/pdf', BASE64_PDF, 100),
    ).rejects.toThrow('Supabase not configured. Please configure in Settings.');
  });

  it('throws when organization is null', async () => {
    getOrCreateOrganization.mockResolvedValue(null);
    await expect(
      uploadBRDDocument('acc', 'cloud', 'file.pdf', 'application/pdf', BASE64_PDF, 100),
    ).rejects.toThrow('Unable to get organization information');
  });

  it('throws when userId is null', async () => {
    getOrCreateUser.mockResolvedValue(null);
    await expect(
      uploadBRDDocument('acc', 'cloud', 'file.pdf', 'application/pdf', BASE64_PDF, 100),
    ).rejects.toThrow('Unable to get user information');
  });

  it('throws for an invalid file type', async () => {
    await expect(
      uploadBRDDocument('acc', 'cloud', 'file.exe', 'application/octet-stream', BASE64_PDF, 100),
    ).rejects.toThrow('Invalid file type. Only PDF and DOCX files are supported.');
  });

  // ── success paths ─────────────────────────────────────────────────────────

  it('returns documentId and success message for a valid PDF upload', async () => {
    const result = await uploadBRDDocument('acc', 'cloud', 'file.pdf', 'application/pdf', BASE64_PDF, 100);
    expect(result).toEqual({
      documentId: MOCK_DOC_ID,
      message: 'Document uploaded successfully. Processing will begin shortly.',
    });
  });

  it('accepts application/pdf file type', async () => {
    await expect(
      uploadBRDDocument('acc', 'cloud', 'f.pdf', 'application/pdf', BASE64_PDF, 100),
    ).resolves.not.toThrow();
  });

  it('accepts application/msword file type', async () => {
    await expect(
      uploadBRDDocument('acc', 'cloud', 'f.doc', 'application/msword', BASE64_PDF, 100),
    ).resolves.not.toThrow();
  });

  it('accepts DOCX MIME type', async () => {
    const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await expect(
      uploadBRDDocument('acc', 'cloud', 'f.docx', docxMime, BASE64_PDF, 100),
    ).resolves.not.toThrow();
  });

  // ── base64 / data-URL handling ─────────────────────────────────────────────

  it('strips the data URL prefix before decoding', async () => {
    // uploadToSupabaseStorage must receive a Uint8Array regardless of data-URL prefix
    await uploadBRDDocument('acc', 'cloud', 'f.pdf', 'application/pdf', DATA_URL_PDF, 100);
    expect(uploadToSupabaseStorage).toHaveBeenCalledWith(
      MOCK_CONFIG,
      'documents',
      expect.any(String),
      expect.any(Uint8Array),
      'application/pdf',
    );
  });

  it('handles plain base64 input (no data URL prefix)', async () => {
    await uploadBRDDocument('acc', 'cloud', 'f.pdf', 'application/pdf', BASE64_PDF, 100);
    expect(uploadToSupabaseStorage).toHaveBeenCalledWith(
      MOCK_CONFIG,
      'documents',
      expect.any(String),
      expect.any(Uint8Array),
      'application/pdf',
    );
  });

  // ── file extension logic ──────────────────────────────────────────────────

  it('uses "pdf" file extension for PDF MIME type', async () => {
    await uploadBRDDocument('acc', 'cloud', 'f.pdf', 'application/pdf', BASE64_PDF, 100);
    expect(supabaseRequest).toHaveBeenCalledWith(
      MOCK_CONFIG,
      'documents',
      expect.objectContaining({ body: expect.objectContaining({ file_type: 'pdf' }) }),
    );
  });

  it('uses "docx" file extension for DOCX MIME type', async () => {
    const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await uploadBRDDocument('acc', 'cloud', 'f.docx', docxMime, BASE64_PDF, 200);
    expect(supabaseRequest).toHaveBeenCalledWith(
      MOCK_CONFIG,
      'documents',
      expect.objectContaining({ body: expect.objectContaining({ file_type: 'docx' }) }),
    );
  });

  // ── supabaseRequest call ──────────────────────────────────────────────────

  it('calls supabaseRequest with correct metadata body', async () => {
    await uploadBRDDocument('acc', 'cloud', 'report.pdf', 'application/pdf', BASE64_PDF, 512);
    expect(supabaseRequest).toHaveBeenCalledWith(
      MOCK_CONFIG,
      'documents',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          user_id: MOCK_USER_ID,
          organization_id: MOCK_ORG.id,
          file_name: 'report.pdf',
          file_size_bytes: 512,
          processing_status: 'uploaded',
        }),
      }),
    );
  });

  it('constructs the storage_url using the supabaseConfig url', async () => {
    await uploadBRDDocument('acc', 'cloud', 'f.pdf', 'application/pdf', BASE64_PDF, 100);
    const body = supabaseRequest.mock.calls[0][2].body;
    expect(body.storage_url).toMatch(/^remote:ai-server\/storage\/v1\/object\/public\/documents\//);
  });

  it('includes storage_path in the metadata body', async () => {
    await uploadBRDDocument('acc', 'cloud', 'f.pdf', 'application/pdf', BASE64_PDF, 100);
    const body = supabaseRequest.mock.calls[0][2].body;
    expect(body.storage_path).toBeDefined();
    expect(typeof body.storage_path).toBe('string');
    expect(body.storage_path).toContain(MOCK_USER_ID);
  });
});

// ===========================================================================
// createIssuesFromBRD
// ===========================================================================

describe('createIssuesFromBRD', () => {
  // Default mock document used in most tests
  const completedDoc = {
    id: 'doc-001',
    processing_status: 'completed',
    parsed_requirements: { epics: [] },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    isValidUUID.mockReturnValue(true);
    isValidProjectKey.mockReturnValue(true);
    getSupabaseConfig.mockResolvedValue(MOCK_CONFIG);
    // First call = GET document; second call = PATCH update
    supabaseRequest
      .mockResolvedValueOnce([completedDoc])
      .mockResolvedValueOnce([]);
    createJiraIssue.mockResolvedValue({ key: 'PROJ-1', id: '10001' });
  });

  // ── input validation ──────────────────────────────────────────────────────

  it('throws for invalid UUID', async () => {
    isValidUUID.mockReturnValue(false);
    await expect(createIssuesFromBRD('acc', 'bad-id', VALID_PROJECT_KEY)).rejects.toThrow(
      'Invalid document ID format',
    );
  });

  it('throws for invalid project key', async () => {
    isValidProjectKey.mockReturnValue(false);
    await expect(createIssuesFromBRD('acc', VALID_UUID, 'invalid key')).rejects.toThrow(
      'Invalid project key format',
    );
  });

  it('throws when supabaseConfig is null', async () => {
    getSupabaseConfig.mockResolvedValue(null);
    await expect(createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY)).rejects.toThrow(
      'Supabase not configured. Please configure in Settings.',
    );
  });

  // ── document fetch failures ───────────────────────────────────────────────

  it('throws when document list is empty', async () => {
    supabaseRequest.mockReset().mockResolvedValue([]);
    await expect(createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY)).rejects.toThrow(
      'Document not found',
    );
  });

  it('throws when document list is null', async () => {
    supabaseRequest.mockReset().mockResolvedValue(null);
    await expect(createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY)).rejects.toThrow(
      'Document not found',
    );
  });

  // ── processing state checks ───────────────────────────────────────────────

  it('throws when document is still processing', async () => {
    supabaseRequest.mockReset().mockResolvedValueOnce([
      { id: 'doc-001', processing_status: 'processing', parsed_requirements: null },
    ]);
    await expect(createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY)).rejects.toThrow(
      'Document is still processing. Current status: processing',
    );
  });

  it('throws when parsed_requirements is null', async () => {
    supabaseRequest.mockReset().mockResolvedValueOnce([
      { id: 'doc-001', processing_status: 'completed', parsed_requirements: null },
    ]);
    await expect(createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY)).rejects.toThrow(
      'Document has not been parsed yet. Please wait for processing to complete.',
    );
  });

  // ── no-epics paths ────────────────────────────────────────────────────────

  it('returns empty createdIssues when epics array is empty', async () => {
    const result = await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    expect(result.createdIssues).toHaveLength(0);
    expect(result.message).toBe('Successfully created 0 issues');
  });

  it('returns empty createdIssues when parsed_requirements has no epics property', async () => {
    supabaseRequest.mockReset()
      .mockResolvedValueOnce([{ id: 'doc-001', processing_status: 'completed', parsed_requirements: {} }])
      .mockResolvedValueOnce([]);
    const result = await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    expect(result.createdIssues).toHaveLength(0);
  });

  it('skips epics when the epics property is not an array', async () => {
    supabaseRequest.mockReset()
      .mockResolvedValueOnce([{
        id: 'doc-001',
        processing_status: 'completed',
        parsed_requirements: { epics: 'not-an-array' },
      }])
      .mockResolvedValueOnce([]);
    const result = await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    expect(result.createdIssues).toHaveLength(0);
  });

  // ── epic creation ─────────────────────────────────────────────────────────

  it('creates a single epic with no stories', async () => {
    supabaseRequest.mockReset()
      .mockResolvedValueOnce([{
        id: 'doc-001',
        processing_status: 'completed',
        parsed_requirements: { epics: [{ summary: 'Epic 1', description: 'Desc', name: 'Epic One' }] },
      }])
      .mockResolvedValueOnce([]);
    createJiraIssue.mockResolvedValue({ key: 'PROJ-1', id: '10001' });

    const result = await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    expect(result.createdIssues).toHaveLength(1);
    expect(result.createdIssues[0]).toEqual({ key: 'PROJ-1', id: '10001', type: 'Epic', summary: 'Epic 1' });
    expect(result.message).toBe('Successfully created 1 issues');
  });

  it('uses epic.name as summary fallback when epic.summary is absent', async () => {
    supabaseRequest.mockReset()
      .mockResolvedValueOnce([{
        id: 'doc-001',
        processing_status: 'completed',
        parsed_requirements: { epics: [{ name: 'Epic Name Only' }] },
      }])
      .mockResolvedValueOnce([]);
    createJiraIssue.mockResolvedValue({ key: 'PROJ-1', id: '10001' });

    const result = await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    expect(createJiraIssue).toHaveBeenCalledWith(
      VALID_PROJECT_KEY,
      expect.objectContaining({ summary: 'Epic Name Only' }),
    );
    expect(result.createdIssues[0].summary).toBe('Epic Name Only');
  });

  it('includes customfield_10011 when epic has a name', async () => {
    supabaseRequest.mockReset()
      .mockResolvedValueOnce([{
        id: 'doc-001',
        processing_status: 'completed',
        parsed_requirements: { epics: [{ summary: 'Epic 1', name: 'Epic Name', description: 'Desc' }] },
      }])
      .mockResolvedValueOnce([]);
    createJiraIssue.mockResolvedValue({ key: 'PROJ-1', id: '10001' });

    await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    expect(createJiraIssue).toHaveBeenCalledWith(
      VALID_PROJECT_KEY,
      expect.objectContaining({ customfield_10011: 'Epic Name' }),
    );
  });

  it('omits customfield_10011 when epic has no name property', async () => {
    supabaseRequest.mockReset()
      .mockResolvedValueOnce([{
        id: 'doc-001',
        processing_status: 'completed',
        parsed_requirements: { epics: [{ summary: 'Epic 1' }] },
      }])
      .mockResolvedValueOnce([]);
    createJiraIssue.mockResolvedValue({ key: 'PROJ-1', id: '10001' });

    await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    const callArgs = createJiraIssue.mock.calls[0][1];
    expect(callArgs).not.toHaveProperty('customfield_10011');
  });

  // ── story creation ────────────────────────────────────────────────────────

  it('creates epics and stories', async () => {
    supabaseRequest.mockReset()
      .mockResolvedValueOnce([{
        id: 'doc-001',
        processing_status: 'completed',
        parsed_requirements: {
          epics: [{
            summary: 'Epic 1',
            name: 'E1',
            stories: [{ summary: 'Story 1', description: 'S desc' }],
          }],
        },
      }])
      .mockResolvedValueOnce([]);
    createJiraIssue
      .mockResolvedValueOnce({ key: 'PROJ-1', id: '10001' })  // epic
      .mockResolvedValueOnce({ key: 'PROJ-2', id: '10002' }); // story

    const result = await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    expect(result.createdIssues).toHaveLength(2);
    expect(result.createdIssues[0]).toMatchObject({ type: 'Epic', key: 'PROJ-1' });
    expect(result.createdIssues[1]).toMatchObject({ type: 'Story', key: 'PROJ-2', parent: 'PROJ-1' });
    expect(result.message).toBe('Successfully created 2 issues');
  });

  it('passes the epic key as parent when creating stories', async () => {
    supabaseRequest.mockReset()
      .mockResolvedValueOnce([{
        id: 'doc-001',
        processing_status: 'completed',
        parsed_requirements: {
          epics: [{ summary: 'Epic 1', name: 'E1', stories: [{ summary: 'Story 1' }] }],
        },
      }])
      .mockResolvedValueOnce([]);
    createJiraIssue
      .mockResolvedValueOnce({ key: 'EPIC-10', id: '10001' })
      .mockResolvedValueOnce({ key: 'STORY-11', id: '10002' });

    await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    const storyCall = createJiraIssue.mock.calls[1][1];
    expect(storyCall.parent).toEqual({ key: 'EPIC-10' });
  });

  // ── task creation ─────────────────────────────────────────────────────────

  it('creates epics, stories, and tasks (full tree)', async () => {
    supabaseRequest.mockReset()
      .mockResolvedValueOnce([{
        id: 'doc-001',
        processing_status: 'completed',
        parsed_requirements: {
          epics: [{
            summary: 'Epic 1', name: 'E1',
            stories: [{
              summary: 'Story 1',
              tasks: [{ summary: 'Task 1', description: 'T desc' }],
            }],
          }],
        },
      }])
      .mockResolvedValueOnce([]);
    createJiraIssue
      .mockResolvedValueOnce({ key: 'PROJ-1', id: '10001' })  // epic
      .mockResolvedValueOnce({ key: 'PROJ-2', id: '10002' })  // story
      .mockResolvedValueOnce({ key: 'PROJ-3', id: '10003' }); // task

    const result = await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    expect(result.createdIssues).toHaveLength(3);
    expect(result.createdIssues[2]).toMatchObject({ type: 'Task', key: 'PROJ-3', parent: 'PROJ-2' });
    expect(result.message).toBe('Successfully created 3 issues');
  });

  it('passes the story key as parent when creating tasks', async () => {
    supabaseRequest.mockReset()
      .mockResolvedValueOnce([{
        id: 'doc-001',
        processing_status: 'completed',
        parsed_requirements: {
          epics: [{
            summary: 'E', name: 'E',
            stories: [{ summary: 'S', tasks: [{ summary: 'T' }] }],
          }],
        },
      }])
      .mockResolvedValueOnce([]);
    createJiraIssue
      .mockResolvedValueOnce({ key: 'E-1', id: '1' })
      .mockResolvedValueOnce({ key: 'S-2', id: '2' })
      .mockResolvedValueOnce({ key: 'T-3', id: '3' });

    await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    const taskCall = createJiraIssue.mock.calls[2][1];
    expect(taskCall.parent).toEqual({ key: 'S-2' });
  });

  // ── failure handling ──────────────────────────────────────────────────────

  it('records error entry when epic creation fails', async () => {
    supabaseRequest.mockReset()
      .mockResolvedValueOnce([{
        id: 'doc-001',
        processing_status: 'completed',
        parsed_requirements: { epics: [{ summary: 'Epic 1', name: 'E1' }] },
      }])
      .mockResolvedValueOnce([]);
    createJiraIssue.mockRejectedValue(new Error('Jira API error'));

    const result = await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    expect(result.createdIssues).toHaveLength(1);
    expect(result.createdIssues[0]).toMatchObject({
      error: 'Failed to create epic: Epic 1',
      details: 'Jira API error',
    });
    expect(result.message).toBe('Successfully created 0 issues');
  });

  it('records error entry when story creation fails but epic succeeds', async () => {
    supabaseRequest.mockReset()
      .mockResolvedValueOnce([{
        id: 'doc-001',
        processing_status: 'completed',
        parsed_requirements: {
          epics: [{ summary: 'Epic 1', name: 'E1', stories: [{ summary: 'Story 1' }] }],
        },
      }])
      .mockResolvedValueOnce([]);
    createJiraIssue
      .mockResolvedValueOnce({ key: 'PROJ-1', id: '10001' })  // epic ok
      .mockRejectedValueOnce(new Error('Story error'));        // story fails

    const result = await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    expect(result.createdIssues).toHaveLength(2);
    expect(result.createdIssues[0]).toMatchObject({ type: 'Epic', key: 'PROJ-1' });
    expect(result.createdIssues[1]).toMatchObject({
      error: 'Failed to create story: Story 1',
      details: 'Story error',
    });
  });

  it('records error entry when task creation fails but epic and story succeed', async () => {
    supabaseRequest.mockReset()
      .mockResolvedValueOnce([{
        id: 'doc-001',
        processing_status: 'completed',
        parsed_requirements: {
          epics: [{
            summary: 'Epic 1', name: 'E1',
            stories: [{ summary: 'Story 1', tasks: [{ summary: 'Task 1' }] }],
          }],
        },
      }])
      .mockResolvedValueOnce([]);
    createJiraIssue
      .mockResolvedValueOnce({ key: 'PROJ-1', id: '10001' })
      .mockResolvedValueOnce({ key: 'PROJ-2', id: '10002' })
      .mockRejectedValueOnce(new Error('Task error'));

    const result = await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    const taskErrorEntry = result.createdIssues.find(i => i.error?.startsWith('Failed to create task'));
    expect(taskErrorEntry).toMatchObject({ error: 'Failed to create task: Task 1', details: 'Task error' });
  });

  // ── document update ───────────────────────────────────────────────────────

  it('issues a PATCH request with createdIssues and projectKey after processing', async () => {
    await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    expect(supabaseRequest).toHaveBeenCalledTimes(2);
    const patchCall = supabaseRequest.mock.calls[1];
    expect(patchCall[1]).toBe(`documents?id=eq.${VALID_UUID}`);
    expect(patchCall[2]).toMatchObject({
      method: 'PATCH',
      body: { created_issues: [], project_key: VALID_PROJECT_KEY },
    });
  });

  // ── multi-epic ────────────────────────────────────────────────────────────

  it('creates multiple epics in order', async () => {
    supabaseRequest.mockReset()
      .mockResolvedValueOnce([{
        id: 'doc-001',
        processing_status: 'completed',
        parsed_requirements: {
          epics: [
            { summary: 'Epic A', name: 'A' },
            { summary: 'Epic B', name: 'B' },
          ],
        },
      }])
      .mockResolvedValueOnce([]);
    createJiraIssue
      .mockResolvedValueOnce({ key: 'PROJ-1', id: '1' })
      .mockResolvedValueOnce({ key: 'PROJ-2', id: '2' });

    const result = await createIssuesFromBRD('acc', VALID_UUID, VALID_PROJECT_KEY);
    expect(result.createdIssues).toHaveLength(2);
    expect(result.createdIssues[0].summary).toBe('Epic A');
    expect(result.createdIssues[1].summary).toBe('Epic B');
  });
});

// ===========================================================================
// getBRDStatus
// ===========================================================================

describe('getBRDStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isValidUUID.mockReturnValue(true);
    getSupabaseConfig.mockResolvedValue(MOCK_CONFIG);
    getOrCreateOrganization.mockResolvedValue(MOCK_ORG);
    getOrCreateUser.mockResolvedValue(MOCK_USER_ID);
    supabaseRequest.mockResolvedValue([{ id: 'doc-001', processing_status: 'completed' }]);
  });

  // ── guard clauses ─────────────────────────────────────────────────────────

  it('throws for invalid UUID', async () => {
    isValidUUID.mockReturnValue(false);
    await expect(getBRDStatus('acc', 'cloud', 'bad-id')).rejects.toThrow('Invalid document ID format');
  });

  it('throws when supabaseConfig is null', async () => {
    getSupabaseConfig.mockResolvedValue(null);
    await expect(getBRDStatus('acc', 'cloud', VALID_UUID)).rejects.toThrow(
      'Supabase not configured. Please configure in Settings.',
    );
  });

  it('throws when organization is null', async () => {
    getOrCreateOrganization.mockResolvedValue(null);
    await expect(getBRDStatus('acc', 'cloud', VALID_UUID)).rejects.toThrow(
      'Unable to get organization information',
    );
  });

  it('throws when userId is null', async () => {
    getOrCreateUser.mockResolvedValue(null);
    await expect(getBRDStatus('acc', 'cloud', VALID_UUID)).rejects.toThrow(
      'Unable to get user information',
    );
  });

  it('throws when document list is empty', async () => {
    supabaseRequest.mockResolvedValue([]);
    await expect(getBRDStatus('acc', 'cloud', VALID_UUID)).rejects.toThrow('Document not found');
  });

  it('throws when document list is null', async () => {
    supabaseRequest.mockResolvedValue(null);
    await expect(getBRDStatus('acc', 'cloud', VALID_UUID)).rejects.toThrow('Document not found');
  });

  // ── success path ──────────────────────────────────────────────────────────

  it('returns the first document from the response', async () => {
    const doc = { id: 'doc-001', processing_status: 'completed', created_issues: [] };
    supabaseRequest.mockResolvedValue([doc]);
    const result = await getBRDStatus('acc', 'cloud', VALID_UUID);
    expect(result).toBe(doc);
  });

  it('calls supabaseRequest with the correct multi-tenant endpoint', async () => {
    await getBRDStatus('acc', 'cloud', VALID_UUID);
    expect(supabaseRequest).toHaveBeenCalledWith(
      MOCK_CONFIG,
      `documents?id=eq.${VALID_UUID}&user_id=eq.${MOCK_USER_ID}&organization_id=eq.${MOCK_ORG.id}&select=*`,
    );
  });

  it('passes the supabaseConfig returned by getSupabaseConfig', async () => {
    await getBRDStatus('acc', 'cloud', VALID_UUID);
    expect(supabaseRequest).toHaveBeenCalledWith(MOCK_CONFIG, expect.any(String));
  });
});
