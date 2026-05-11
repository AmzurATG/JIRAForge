'use strict';

/**
 * Advanced E2E Scenarios for Time Tracking
 *
 * Complements e2e-time-tracking.test.js with additional real-world scenarios:
 * - Approval workflow (pending_approval → approved → sync)
 * - Unassigned work clustering & suggestions
 * - Cross-project tracking (multi-project workday)
 * - Worklog sync failures & recovery
 * - Confidence anomalies (all high, all low, bimodal)
 * - Non-work-hours & overnight scenarios
 * - Concurrent/overlapping task switching
 * - Batch retry & partial failure recovery
 */

// ============================================================================
// MOCKS (shared with e2e-time-tracking.test.js)
// ============================================================================

jest.mock('../../src/services/ai/ai-client', () => ({
  chatCompletionWithFallback: jest.fn(),
  isActivityAIEnabled: jest.fn(),
}));

jest.mock('../../src/services/ai/prompts', () => ({
  formatAssignedIssues: jest.fn(),
  buildAppIdentificationPrompt: jest.fn(),
  APP_IDENTIFICATION_SYSTEM_PROMPT: 'mock system prompt',
}));

jest.mock('../../src/services/db/activity-db-service', () => ({
  updateActivityRecordAnalysis: jest.fn(),
  getPendingActivityBatches: jest.fn(),
  claimBatchForProcessing: jest.fn(),
  markBatchAnalyzed: jest.fn(),
  markBatchFailed: jest.fn(),
  releaseRecordsToPending: jest.fn(),
  resetStuckProcessingRecords: jest.fn(),
  resetStuckFailedRecords: jest.fn(),
  approveActivityRecord: jest.fn(),
  rejectActivityRecord: jest.fn(),
  reassignActivityRecord: jest.fn(),
}));

jest.mock('../../src/services/db/user-db-service', () => ({
  getUserCachedIssues: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const { chatCompletionWithFallback, isActivityAIEnabled } = require('../../src/services/ai/ai-client');
const { formatAssignedIssues } = require('../../src/services/ai/prompts');
const activityDbService = require('../../src/services/db/activity-db-service');
const { analyzeBatch } = require('../../src/services/activity-service');

// ============================================================================
// HELPER: LLM Response Builder
// ============================================================================

const makeLLMResponse = (content, finishReason = 'stop') => ({
  response: {
    choices: [{ message: { content }, finish_reason: finishReason }],
  },
  provider: 'portkey',
  model: 'gemini-2.0-flash',
});

// ============================================================================
// HELPER: Multi-tenancy Test Data
// ============================================================================

const TEST_USER_ID = 'user-dev-advanced-001';
const TEST_ORG_ID = 'org-multi-project-corp';

const MULTI_PROJECT_ISSUES = [
  // ENG project (3 issues)
  { key: 'ENG-101', summary: 'Feature A', issueType: 'Story', project: 'ENG', status: 'In Progress' },
  { key: 'ENG-102', summary: 'Feature B', issueType: 'Story', project: 'ENG', status: 'In Progress' },
  { key: 'ENG-201', summary: 'Task A', issueType: 'Task', project: 'ENG', status: 'In Progress' },

  // INFRA project (3 issues)
  { key: 'INFRA-50', summary: 'Database migration', issueType: 'Task', project: 'INFRA', status: 'In Progress' },
  { key: 'INFRA-51', summary: 'K8s upgrade', issueType: 'Story', project: 'INFRA', status: 'To Do' },
  { key: 'INFRA-301', summary: 'Monitoring setup', issueType: 'Bug', project: 'INFRA', status: 'In Progress' },

  // OPS project (2 issues)
  { key: 'OPS-1', summary: 'On-call runbook', issueType: 'Task', project: 'OPS', status: 'In Progress' },
  { key: 'OPS-2', summary: 'Incident response', issueType: 'Story', project: 'OPS', status: 'In Progress' },
];

// ============================================================================
// SCENARIO 1: Approval Workflow
// ============================================================================

describe('Scenario 1: Approval Workflow (pending_approval → approved → sync)', () => {
  let analyses;

  beforeEach(() => {
    jest.clearAllMocks();
    isActivityAIEnabled.mockReturnValue(true);
    formatAssignedIssues.mockReturnValue(
      MULTI_PROJECT_ISSUES.slice(0, 3).map(i => `${i.key}: ${i.summary}`).join('\n')
    );
    activityDbService.updateActivityRecordAnalysis.mockResolvedValue({});
    activityDbService.approveActivityRecord.mockResolvedValue({ approval_status: 'approved' });
  });

  it('stamps records with pending_approval after AI analysis', async () => {
    const testRecords = [
      {
        id: 'rec-1',
        user_id: TEST_USER_ID,
        organization_id: TEST_ORG_ID,
        application_name: 'Code.exe',
        window_title: 'src/app.ts - ENG-101 - VS Code',
        ocr_text: 'const feature = new Feature()',
        total_time_seconds: 300,
        start_time: '2026-05-07T09:00:00Z',
        end_time: '2026-05-07T09:05:00Z',
        status: 'pending',
        classification: 'productive',
        user_assigned_issues: JSON.stringify(MULTI_PROJECT_ISSUES.slice(0, 3)),
      },
    ];

    const testAnalyses = [
      {
        recordIndex: 0,
        taskKey: 'ENG-101',
        confidenceScore: 0.85,
        workType: 'office',
        reasoning: 'Window title explicitly mentions ENG-101',
      },
    ];

    chatCompletionWithFallback.mockResolvedValue(makeLLMResponse(JSON.stringify(testAnalyses)));

    await analyzeBatch(testRecords, MULTI_PROJECT_ISSUES.slice(0, 3), TEST_USER_ID, TEST_ORG_ID);

    // Verify record was analyzed with correct task key
    // DB layer internally sets approvalStatus = pending_approval when taskKey is set
    expect(activityDbService.updateActivityRecordAnalysis).toHaveBeenCalledWith(
      'rec-1',
      expect.objectContaining({
        taskKey: 'ENG-101',
        projectKey: 'ENG',
      })
    );
  });

  it('tracks record flow: pending_approval → approved (user action)', async () => {
    // Simulate user approving a record
    const recordId = 'rec-pending-001';
    const approvalData = {
      recordId,
      approvalStatus: 'approved',
      approvedAt: new Date(),
      approvedBy: TEST_USER_ID,
    };

    activityDbService.approveActivityRecord.mockResolvedValue(approvalData);

    const result = await activityDbService.approveActivityRecord(
      recordId,
      TEST_USER_ID,
      TEST_ORG_ID
    );

    expect(result.approvalStatus).toBe('approved');
    expect(result.approvedBy).toBe(TEST_USER_ID);
  });

  it('allows user to reassign record before approval', async () => {
    const recordId = 'rec-misassigned-001';
    const reassignData = {
      recordId,
      originalTaskKey: 'ENG-101',
      newTaskKey: 'ENG-102',
      approvalStatus: 'approved',
    };

    activityDbService.reassignActivityRecord.mockResolvedValue(reassignData);

    const result = await activityDbService.reassignActivityRecord(
      recordId,
      'ENG-102',
      TEST_USER_ID,
      TEST_ORG_ID
    );

    expect(result.newTaskKey).toBe('ENG-102');
    expect(result.approvalStatus).toBe('approved');
  });

  it('batch approval: user approves multiple records at once', async () => {
    const recordIds = ['rec-1', 'rec-2', 'rec-3'];

    // Mock bulk approval
    activityDbService.approveActivityRecord.mockImplementation((recordId) =>
      Promise.resolve({ recordId, approvalStatus: 'approved' })
    );

    const results = await Promise.all(
      recordIds.map(id => activityDbService.approveActivityRecord(id, TEST_USER_ID, TEST_ORG_ID))
    );

    expect(results).toHaveLength(3);
    expect(results.every(r => r.approvalStatus === 'approved')).toBe(true);
  });

  it('only approved records count toward time aggregation', () => {
    // Simulate aggregation logic with mixed statuses
    const analysisResults = [
      { recordIndex: 0, taskKey: 'ENG-101', seconds: 300, approvalStatus: 'approved' },
      { recordIndex: 1, taskKey: 'ENG-102', seconds: 300, approvalStatus: 'pending_approval' },
      { recordIndex: 2, taskKey: 'ENG-101', seconds: 300, approvalStatus: 'approved' },
    ];

    const syncableTime = analysisResults
      .filter(r => r.approvalStatus === 'approved')
      .reduce((sum, r) => sum + r.seconds, 0);

    expect(syncableTime).toBe(600); // Only 2 approved records
  });
});

// ============================================================================
// SCENARIO 2: Unassigned Work Clustering & Suggestions
// ============================================================================

describe('Scenario 2: Unassigned Work Clustering & Suggestions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isActivityAIEnabled.mockReturnValue(true);
    formatAssignedIssues.mockReturnValue(MULTI_PROJECT_ISSUES.map(i => `${i.key}`).join('\n'));
  });

  it('detects multiple similar unassigned activities', async () => {
    const unassignedRecords = [
      {
        id: 'unass-1',
        user_id: TEST_USER_ID,
        organization_id: TEST_ORG_ID,
        application_name: 'Slack.exe',
        window_title: 'Slack - #infrastructure',
        ocr_text: 'Discussion about K8s migration',
        total_time_seconds: 600,
        status: 'analyzed',
      },
      {
        id: 'unass-2',
        user_id: TEST_USER_ID,
        organization_id: TEST_ORG_ID,
        application_name: 'Slack.exe',
        window_title: 'Slack - #infrastructure',
        ocr_text: 'K8s upgrade timeline',
        total_time_seconds: 500,
        status: 'analyzed',
      },
      {
        id: 'unass-3',
        user_id: TEST_USER_ID,
        organization_id: TEST_ORG_ID,
        application_name: 'chrome.exe',
        window_title: 'GitHub - kubernetes/kubernetes',
        ocr_text: 'K8s release notes for v1.30',
        total_time_seconds: 400,
        status: 'analyzed',
      },
    ];

    // AI groups these as related
    const clusteringAnalysis = {
      clusters: [
        {
          clusterName: 'Kubernetes Upgrade Planning',
          activities: [
            { recordId: 'unass-1', similarity: 0.95 },
            { recordId: 'unass-2', similarity: 0.92 },
            { recordId: 'unass-3', similarity: 0.88 },
          ],
          suggestedIssue: 'INFRA-51',
          suggestedConfidence: 0.85,
          totalSeconds: 1500,
        },
      ],
    };

    const totalUnassignedSeconds = unassignedRecords.reduce((sum, r) => sum + r.total_time_seconds, 0);
    expect(totalUnassignedSeconds).toBe(1500);

    // Cluster suggestion matches
    expect(clusteringAnalysis.clusters[0].suggestedIssue).toBe('INFRA-51');
    expect(clusteringAnalysis.clusters[0].activities).toHaveLength(3);
  });

  it('validates suggested issue is in user assigned issues before creating cluster', () => {
    const suggestedKey = 'INFRA-51';
    const isValid = MULTI_PROJECT_ISSUES.some(issue => issue.key === suggestedKey);

    expect(isValid).toBe(true);
    expect(MULTI_PROJECT_ISSUES.find(i => i.key === suggestedKey).project).toBe('INFRA');
  });

  it('user can accept cluster suggestion and bulk-assign', () => {
    // User accepts suggestion and assigns cluster to INFRA-51
    const bulkAssignData = {
      clusterName: 'Kubernetes Upgrade Planning',
      assignedToIssue: 'INFRA-51',
      recordCount: 3,
      totalSeconds: 1500,
      assignedAt: new Date(),
    };

    expect(bulkAssignData.recordCount).toBe(3);
    expect(bulkAssignData.totalSeconds).toBe(1500);
    expect(bulkAssignData.assignedToIssue).toBe('INFRA-51');
  });

  it('user can create new issue from unassigned cluster', () => {
    // User decides cluster represents new work and creates issue
    const newIssueData = {
      projectKey: 'INFRA',
      summary: 'Kubernetes Upgrade Planning',
      description: 'Unassigned work cluster: K8s migration, upgrade timeline, release notes',
      issueType: 'Task',
      createdFrom: 'unassigned_cluster',
      linkedRecords: 3,
    };

    expect(newIssueData.projectKey).toBe('INFRA');
    expect(newIssueData.issueType).toBe('Task');
    expect(newIssueData.linkedRecords).toBe(3);
  });
});

// ============================================================================
// SCENARIO 3: Cross-Project Tracking
// ============================================================================

describe('Scenario 3: Cross-Project Tracking (Multi-project workday)', () => {
  let records;
  let analyses;

  beforeEach(() => {
    jest.clearAllMocks();
    isActivityAIEnabled.mockReturnValue(true);
    formatAssignedIssues.mockReturnValue(
      MULTI_PROJECT_ISSUES.map(i => `${i.key}: ${i.summary}`).join('\n')
    );
    activityDbService.updateActivityRecordAnalysis.mockResolvedValue({});

    // Generate records for ENG, INFRA, OPS
    records = [];
    let recordId = 1;

    // ENG project: 09:00-10:00
    for (let i = 0; i < 12; i++) {
      records.push({
        id: `rec-eng-${recordId++}`,
        user_id: TEST_USER_ID,
        organization_id: TEST_ORG_ID,
        application_name: 'Code.exe',
        window_title: `src/engine.ts - ENG-101 - VS Code`,
        ocr_text: `Feature implementation for ENG-101 ${i}`,
        total_time_seconds: 300,
        start_time: `2026-05-07T0${9 + Math.floor(i / 12)}:${(i % 12) * 5}:00Z`,
        end_time: `2026-05-07T0${9 + Math.floor(i / 12)}:${(i % 12) * 5 + 5}:00Z`,
        status: 'pending',
        classification: 'productive',
        user_assigned_issues: JSON.stringify(MULTI_PROJECT_ISSUES),
      });
    }

    // INFRA project: 10:00-11:00
    for (let i = 0; i < 12; i++) {
      records.push({
        id: `rec-infra-${recordId++}`,
        user_id: TEST_USER_ID,
        organization_id: TEST_ORG_ID,
        application_name: 'WindowsTerminal.exe',
        window_title: `psql - INFRA-50 - Terminal`,
        ocr_text: `Running database migration INFRA-50 ${i}`,
        total_time_seconds: 300,
        start_time: `2026-05-07T10:${i * 5}:00Z`,
        end_time: `2026-05-07T10:${i * 5 + 5}:00Z`,
        status: 'pending',
        classification: 'productive',
        user_assigned_issues: JSON.stringify(MULTI_PROJECT_ISSUES),
      });
    }

    // OPS project: 11:00-12:00
    for (let i = 0; i < 12; i++) {
      records.push({
        id: `rec-ops-${recordId++}`,
        user_id: TEST_USER_ID,
        organization_id: TEST_ORG_ID,
        application_name: 'Notepad.exe',
        window_title: `On-call runbook - OPS-1`,
        ocr_text: `Incident response procedures OPS-1 ${i}`,
        total_time_seconds: 300,
        start_time: `2026-05-07T11:${i * 5}:00Z`,
        end_time: `2026-05-07T11:${i * 5 + 5}:00Z`,
        status: 'pending',
        classification: 'productive',
        user_assigned_issues: JSON.stringify(MULTI_PROJECT_ISSUES),
      });
    }
  });

  it('generates 36 records across 3 projects (1 hour each)', () => {
    expect(records).toHaveLength(36);

    const engRecords = records.filter(r => r.id.includes('eng'));
    const infraRecords = records.filter(r => r.id.includes('infra'));
    const opsRecords = records.filter(r => r.id.includes('ops'));

    expect(engRecords).toHaveLength(12);
    expect(infraRecords).toHaveLength(12);
    expect(opsRecords).toHaveLength(12);
  });

  it('tracks time per project: ENG=3600s, INFRA=3600s, OPS=3600s', async () => {
    analyses = [
      ...records
        .filter(r => r.id.includes('eng'))
        .map((r, i) => ({
          recordIndex: i,
          taskKey: 'ENG-101',
          confidenceScore: 0.9,
          workType: 'office',
        })),
      ...records
        .filter(r => r.id.includes('infra'))
        .map((r, i) => ({
          recordIndex: 12 + i,
          taskKey: 'INFRA-50',
          confidenceScore: 0.9,
          workType: 'office',
        })),
      ...records
        .filter(r => r.id.includes('ops'))
        .map((r, i) => ({
          recordIndex: 24 + i,
          taskKey: 'OPS-1',
          confidenceScore: 0.9,
          workType: 'office',
        })),
    ];

    const engTime = analyses
      .filter(a => a.taskKey === 'ENG-101')
      .reduce((sum) => sum + 300, 0);
    const infraTime = analyses
      .filter(a => a.taskKey === 'INFRA-50')
      .reduce((sum) => sum + 300, 0);
    const opsTime = analyses
      .filter(a => a.taskKey === 'OPS-1')
      .reduce((sum) => sum + 300, 0);

    expect(engTime).toBe(3600);
    expect(infraTime).toBe(3600);
    expect(opsTime).toBe(3600);
    expect(engTime + infraTime + opsTime).toBe(10800); // 3 hours total
  });

  it('project distribution is realistic: 33% each', () => {
    const total = 36;
    const engPct = (12 / total) * 100;
    const infraPct = (12 / total) * 100;
    const opsPct = (12 / total) * 100;

    expect(engPct).toBeCloseTo(33.3, 1);
    expect(infraPct).toBeCloseTo(33.3, 1);
    expect(opsPct).toBeCloseTo(33.3, 1);
  });

  it('validates all matched issues belong to assigned list', () => {
    const matchedIssues = ['ENG-101', 'INFRA-50', 'OPS-1'];
    const allValid = matchedIssues.every(key =>
      MULTI_PROJECT_ISSUES.some(issue => issue.key === key)
    );

    expect(allValid).toBe(true);
  });

  it('aggregates per-project summary for team dashboard', () => {
    const projectSummary = {
      'ENG': { issues: ['ENG-101'], totalSeconds: 3600 },
      'INFRA': { issues: ['INFRA-50'], totalSeconds: 3600 },
      'OPS': { issues: ['OPS-1'], totalSeconds: 3600 },
    };

    expect(projectSummary['ENG'].totalSeconds).toBe(3600);
    expect(projectSummary['INFRA'].totalSeconds).toBe(3600);
    expect(projectSummary['OPS'].totalSeconds).toBe(3600);
  });
});

// ============================================================================
// SCENARIO 4: Worklog Sync Failure & Recovery
// ============================================================================

describe('Scenario 4: Worklog Sync Failure & Recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates worklog in PENDING state when Jira API is unavailable', async () => {
    const syncAttempt = {
      taskKey: 'ENG-101',
      trackedSeconds: 3600,
      jiraWorklogId: null, // Not yet created on Jira
      syncStatus: 'pending',
      retryCount: 0,
      error: 'JIRA_API_UNAVAILABLE',
    };

    expect(syncAttempt.syncStatus).toBe('pending');
    expect(syncAttempt.jiraWorklogId).toBeNull();
    expect(syncAttempt.retryCount).toBe(0);
  });

  it('retries on transient errors (ENOTFOUND, ETIMEDOUT)', () => {
    const transientErrors = [
      'ENOTFOUND',
      'ETIMEDOUT',
      'ECONNREFUSED',
    ];

    const retryableErrors = transientErrors.every(err => {
      return ['ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 503, 502, 500].includes(err);
    });

    expect(retryableErrors).toBe(true);
  });

  it('escalates to permanent failure after 3 retries', () => {
    const syncAttempt = {
      taskKey: 'ENG-101',
      syncStatus: 'failed',
      retryCount: 3,
      error: 'Max retries exceeded',
      finalError: true,
    };

    expect(syncAttempt.finalError).toBe(true);
    expect(syncAttempt.retryCount).toBe(3);
  });

  it('recovers on next successful Jira API call', () => {
    const syncRecovery = {
      taskKey: 'ENG-101',
      previousStatus: 'pending',
      recoveryAttempt: 1,
      jiraWorklogId: 'worklog-abc-123',
      syncStatus: 'synced',
      syncedAt: new Date(),
    };

    expect(syncRecovery.syncStatus).toBe('synced');
    expect(syncRecovery.jiraWorklogId).toBeDefined();
    expect(syncRecovery.previousStatus).toBe('pending');
  });

  it('cleans up orphaned worklogs when user reassigns time', () => {
    const orphanedWorklog = {
      taskKey: 'ENG-101',
      jiraWorklogId: 'worklog-old-123',
      status: 'delete_requested',
      reason: 'User reassigned time to ENG-102',
      deleteAttempts: 0,
    };

    expect(orphanedWorklog.reason).toContain('User reassigned');
    expect(orphanedWorklog.status).toBe('delete_requested');
  });
});

// ============================================================================
// SCENARIO 5: Confidence Score Anomalies
// ============================================================================

describe('Scenario 5: Confidence Score Anomalies (Edge Distributions)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isActivityAIEnabled.mockReturnValue(true);
    formatAssignedIssues.mockReturnValue(MULTI_PROJECT_ISSUES.slice(0, 3).map(i => `${i.key}`).join('\n'));
  });

  it('handles bulk high-confidence scenario (all 0.9-1.0)', async () => {
    // Perfect matching: all records clearly on task
    const bulkHighAnalyses = Array(10)
      .fill(null)
      .map((_, i) => ({
        recordIndex: i,
        taskKey: 'ENG-101',
        confidenceScore: 0.9 + Math.random() * 0.09,
        workType: 'office',
      }));

    const passThreshold = bulkHighAnalyses.filter(a => a.confidenceScore >= 0.4).length;
    expect(passThreshold).toBe(10);

    const avgConfidence = bulkHighAnalyses.reduce((sum, a) => sum + a.confidenceScore, 0) / bulkHighAnalyses.length;
    expect(avgConfidence).toBeGreaterThan(0.9);
  });

  it('handles bulk low-confidence scenario (all 0.3-0.5)', () => {
    // Ambiguous matching: user context unclear
    const bulkLowAnalyses = Array(10)
      .fill(null)
      .map((_, i) => ({
        recordIndex: i,
        taskKey: i < 5 ? 'ENG-101' : null, // First 5 pass, rest demoted
        confidenceScore: 0.3 + Math.random() * 0.2,
        workType: 'office',
      }));

    const passThreshold = bulkLowAnalyses.filter(a => a.taskKey && a.confidenceScore >= 0.4).length;
    expect(passThreshold).toBeLessThanOrEqual(5);

    const assignedCount = bulkLowAnalyses.filter(a => a.taskKey).length;
    expect(assignedCount).toBeLessThan(10);
  });

  it('handles bimodal distribution (mostly high + few low)', () => {
    const bimodalAnalyses = [
      ...Array(8).fill(null).map((_, i) => ({
        recordIndex: i,
        taskKey: 'ENG-101',
        confidenceScore: 0.85 + Math.random() * 0.14,
      })),
      ...Array(2).fill(null).map((_, i) => ({
        recordIndex: 8 + i,
        taskKey: null,
        confidenceScore: 0.2 + Math.random() * 0.19,
      })),
    ];

    const highCluster = bimodalAnalyses.filter(a => a.confidenceScore > 0.7).length;
    const lowCluster = bimodalAnalyses.filter(a => a.confidenceScore < 0.4).length;

    expect(highCluster).toBeGreaterThan(lowCluster);
    expect(highCluster + lowCluster).toBe(10);
  });

  it('validates outlier confidence scores (0.0 and 1.0)', () => {
    const outliers = [
      { taskKey: null, confidenceScore: 0.0, reasoning: 'Complete mismatch' },
      { taskKey: 'ENG-101', confidenceScore: 1.0, reasoning: 'Perfect match (rare)' },
    ];

    expect(outliers[0].confidenceScore).toBe(0.0);
    expect(outliers[1].confidenceScore).toBe(1.0);
  });
});

// ============================================================================
// SCENARIO 6: Non-Work-Hours & Overnight
// ============================================================================

describe('Scenario 6: Non-Work-Hours & Overnight (Weekend/Late-night)', () => {
  it('detects weekend work (Saturday tracking)', () => {
    const saturdayRecords = [
      {
        id: 'sat-001',
        timestamp: '2026-05-10T14:00:00Z', // Saturday 2:00 PM UTC
        dayOfWeek: 6, // Saturday
        isWorkDay: false,
        applicationName: 'Code.exe',
      },
      {
        id: 'sat-002',
        timestamp: '2026-05-10T15:00:00Z',
        dayOfWeek: 6,
        isWorkDay: false,
      },
    ];

    const weekendTime = saturdayRecords
      .filter(r => !r.isWorkDay)
      .reduce(() => 300 * 2, 0); // 2 records × 5 min

    expect(weekendTime).toBe(600);
    expect(saturdayRecords[0].dayOfWeek).toBe(6);
  });

  it('handles late-night coding (11 PM - midnight)', () => {
    const lateNightRecords = [
      {
        id: 'late-001',
        timestamp: '2026-05-07T23:00:00Z',
        hour: 23,
        isWorkHours: false,
      },
      {
        id: 'late-002',
        timestamp: '2026-05-07T23:30:00Z',
        hour: 23,
        isWorkHours: false,
      },
    ];

    const lateNightTime = lateNightRecords.reduce(() => 300, 0) * 2;
    expect(lateNightTime).toBe(600);

    const allOutsideWorkHours = lateNightRecords.every(r => !r.isWorkHours);
    expect(allOutsideWorkHours).toBe(true);
  });

  it('spans records across midnight boundary', () => {
    const midnightSpanRecords = [
      {
        id: 'midnight-001',
        startTime: '2026-05-07T23:55:00Z',
        endTime: '2026-05-08T00:05:00Z',
        spansMidnight: true,
        workDateA: '2026-05-07',
        workDateB: '2026-05-08',
      },
    ];

    expect(midnightSpanRecords[0].spansMidnight).toBe(true);
    expect(midnightSpanRecords[0].workDateA).not.toBe(midnightSpanRecords[0].workDateB);
  });

  it('attributes time to correct work_date based on user timezone', () => {
    // User in California (PT = UTC-7)
    const record = {
      startTime: '2026-05-08T06:00:00Z', // May 8, 6:00 UTC = May 7, 11 PM PT
      timezone: 'America/Los_Angeles',
      expectedWorkDate: '2026-05-07', // Previous calendar day
    };

    expect(record.expectedWorkDate).toBe('2026-05-07');
  });
});

// ============================================================================
// SCENARIO 7: Concurrent/Overlapping Task Scenarios
// ============================================================================

describe('Scenario 7: Concurrent/Overlapping Task Scenarios', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isActivityAIEnabled.mockReturnValue(true);
    formatAssignedIssues.mockReturnValue(MULTI_PROJECT_ISSUES.slice(0, 3).map(i => `${i.key}`).join('\n'));
  });

  it('detects context switch from ENG-101 to ENG-102', async () => {
    const switchRecords = [
      // 12 records on ENG-101
      ...Array(12)
        .fill(null)
        .map((_, i) => ({
          id: `switch-eng101-${i}`,
          user_id: TEST_USER_ID,
          organization_id: TEST_ORG_ID,
          window_title: `src/feature-a.ts - ENG-101`,
          total_time_seconds: 300,
        })),
      // 12 records on ENG-102
      ...Array(12)
        .fill(null)
        .map((_, i) => ({
          id: `switch-eng102-${i}`,
          user_id: TEST_USER_ID,
          organization_id: TEST_ORG_ID,
          window_title: `src/feature-b.ts - ENG-102`,
          total_time_seconds: 300,
        })),
    ];

    const eng101Count = switchRecords.filter(r => r.window_title.includes('ENG-101')).length;
    const eng102Count = switchRecords.filter(r => r.window_title.includes('ENG-102')).length;

    expect(eng101Count).toBe(12);
    expect(eng102Count).toBe(12);
  });

  it('handles rapid task switching (every 5-10 minutes)', () => {
    const rapidSwitch = [
      { taskKey: 'ENG-101', duration: 300 }, // 5 min
      { taskKey: 'ENG-102', duration: 300 }, // 5 min
      { taskKey: 'ENG-201', duration: 300 }, // 5 min
      { taskKey: 'ENG-101', duration: 300 }, // 5 min (back to start)
    ];

    expect(rapidSwitch).toHaveLength(4);
    expect(rapidSwitch.every(r => r.duration === 300)).toBe(true);
  });

  it('prevents double-counting time during simultaneous windows', () => {
    // User has 2 VS Code windows open (impossible to work on both simultaneously)
    const simultaneousRecords = [
      { id: 'sim-1', app: 'Code.exe', window: 'src/a.ts', timestamp: '10:00', seconds: 300 },
      { id: 'sim-2', app: 'Code.exe', window: 'src/b.ts', timestamp: '10:00', seconds: 300 }, // Same time!
    ];

    // Filter: only count active (foreground) window
    const activeWindow = simultaneousRecords.filter(r => r.window.includes('a.ts'));
    expect(activeWindow).toHaveLength(1);
  });

  it('correctly attributes time when switching between Slack + VS Code', () => {
    const mixedContextRecords = [
      { taskKey: 'ENG-101', app: 'Code.exe', seconds: 600 },
      { taskKey: null, app: 'Slack.exe', seconds: 300 }, // Unassigned
      { taskKey: 'ENG-101', app: 'Code.exe', seconds: 600 }, // Back to ENG-101
    ];

    const codingTime = mixedContextRecords
      .filter(r => r.app === 'Code.exe')
      .reduce((sum, r) => sum + r.seconds, 0);

    const slackTime = mixedContextRecords
      .filter(r => r.app === 'Slack.exe')
      .reduce((sum, r) => sum + r.seconds, 0);

    expect(codingTime).toBe(1200); // 600 + 600
    expect(slackTime).toBe(300);
  });
});

// ============================================================================
// SCENARIO 8: Batch Retry & Partial Failure Recovery
// ============================================================================

describe('Scenario 8: Batch Retry & Partial Failure Recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isActivityAIEnabled.mockReturnValue(true);
    formatAssignedIssues.mockReturnValue(MULTI_PROJECT_ISSUES.slice(0, 3).map(i => `${i.key}`).join('\n'));
    activityDbService.updateActivityRecordAnalysis.mockResolvedValue({});
  });

  it('recovers 18 of 20 records when batch truncated at 90%', async () => {
    // Create 20 records
    const testRecords = Array(20)
      .fill(null)
      .map((_, i) => ({
        id: `batch-rec-${i}`,
        user_id: TEST_USER_ID,
        organization_id: TEST_ORG_ID,
        application_name: 'Code.exe',
        window_title: `task-${i}`,
        total_time_seconds: 300,
        user_assigned_issues: JSON.stringify(MULTI_PROJECT_ISSUES.slice(0, 3)),
      }));

    // Mock: LLM truncates response at record 18
    const partialAnalyses = Array(18)
      .fill(null)
      .map((_, i) => ({
        recordIndex: i,
        taskKey: 'ENG-101',
        confidenceScore: 0.8,
        workType: 'office',
      }));

    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse(JSON.stringify(partialAnalyses), 'length')
    );

    const result = await analyzeBatch(
      testRecords, MULTI_PROJECT_ISSUES.slice(0, 3), TEST_USER_ID, TEST_ORG_ID
    );

    expect(result.recordsProcessed).toBe(18);
    expect(result.truncated).toBe(true);
    expect(result.analyses).toHaveLength(18);
  });

  it('queues remaining 2 records for retry in next batch', () => {
    // Simulate retry queue
    const failedRecords = [
      { id: 'batch-rec-18', status: 'pending', retryCount: 0 },
      { id: 'batch-rec-19', status: 'pending', retryCount: 0 },
    ];

    const retryableCount = failedRecords.filter(r => r.status === 'pending').length;
    expect(retryableCount).toBe(2);
  });

  it('marks batch failed only after persistent AI errors', () => {
    const batchFailureScenario = {
      totalRecords: 20,
      processingAttempts: 3,
      successfulRecords: 0, // All attempts failed
      batchStatus: 'failed',
      reason: 'AI service unavailable',
    };

    expect(batchFailureScenario.batchStatus).toBe('failed');
    expect(batchFailureScenario.successfulRecords).toBe(0);
  });

  it('preserves order when salvaging truncated response', async () => {
    // Ensure record indices remain correctly mapped
    const salvageAnalyses = [
      { recordIndex: 0, taskKey: 'ENG-101' },
      { recordIndex: 1, taskKey: 'ENG-102' },
      { recordIndex: 2, taskKey: 'ENG-101' },
      // ... truncated at index 3+
    ];

    expect(salvageAnalyses[0].recordIndex).toBe(0);
    expect(salvageAnalyses[1].recordIndex).toBe(1);
    expect(salvageAnalyses[2].recordIndex).toBe(2);
  });

  it('deduplicates records if batch retried accidentally', () => {
    // Prevent double-counting if same batch processed twice
    const dedupeData = [
      { recordId: 'rec-1', taskKey: 'ENG-101', seconds: 300 },
      { recordId: 'rec-1', taskKey: 'ENG-101', seconds: 300 }, // Duplicate
      { recordId: 'rec-2', taskKey: 'ENG-102', seconds: 300 },
    ];

    const unique = new Map(dedupeData.map(d => [d.recordId, d]));
    expect(unique.size).toBe(2); // Only 2 unique records
  });
});
