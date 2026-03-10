'use strict';

/**
 * Tests for polling-service.js
 * The module exports a singleton PollingService instance.
 * We use jest.resetModules() + re-require to get a fresh instance per describe block,
 * and jest.useFakeTimers() to control setInterval / setTimeout timing.
 */

// ── Shared mock factories ────────────────────────────────────────────────────

function makeSupabaseMock({
  resetStuck = jest.fn().mockResolvedValue(undefined),
  getPending = jest.fn().mockResolvedValue([]),
  claim = jest.fn().mockResolvedValue(true),
  getCachedIssues = jest.fn().mockResolvedValue([]),
  download = jest.fn().mockResolvedValue(Buffer.from('img')),
  saveAnalysis = jest.fn().mockResolvedValue(undefined),
  updateStatus = jest.fn().mockResolvedValue(undefined),
  updateDuration = jest.fn().mockResolvedValue(undefined),
  deleteFile = jest.fn().mockResolvedValue(undefined),
  clearStorage = jest.fn().mockResolvedValue(undefined),
  markWorklog = jest.fn().mockResolvedValue(undefined),
} = {}) {
  return {
    resetStuckProcessingScreenshots: resetStuck,
    getPendingScreenshots: getPending,
    claimScreenshotForProcessing: claim,
    getUserCachedIssues: getCachedIssues,
    downloadFile: download,
    saveAnalysisResult: saveAnalysis,
    updateScreenshotStatus: updateStatus,
    updateScreenshotDuration: updateDuration,
    deleteFile,
    clearStorageUrls: clearStorage,
    markWorklogCreated: markWorklog,
  };
}

function makeScreenshotServiceMock({
  analyzeActivity = jest.fn().mockResolvedValue({
    taskKey: 'ATG-1',
    projectKey: 'ATG',
    workType: 'office',
    confidenceScore: 0.9,
    timeSpentSeconds: 300,
    modelVersion: 'v3',
    metadata: { extractedText: 'text' },
  }),
  createWorklog = jest.fn().mockResolvedValue({ worklogId: 'wl-1', created: true }),
} = {}) {
  return { analyzeActivity, createWorklog };
}

const SCREENSHOT = {
  id: 'ss-1',
  user_id: 'user-1',
  organization_id: 'org-1',
  storage_path: 'users/user-1/screenshot_123.png',
  window_title: 'VSCode',
  application_name: 'Code',
  timestamp: '2024-01-01T10:00:00Z',
  duration_seconds: 300,
  start_time: '2024-01-01T09:55:00Z',
  end_time: '2024-01-01T10:00:00Z',
  user_assigned_issues: null,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadService(supabaseMock, screenshotMock) {
  jest.resetModules();
  jest.doMock('../../src/services/supabase-service', () => supabaseMock);
  jest.doMock('../../src/services/screenshot-service', () => screenshotMock);
  jest.doMock('../../src/utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }));
  jest.doMock('../../src/utils/datetime', () => ({
    getUTCISOString: jest.fn().mockReturnValue('2024-01-01T10:00:00Z'),
    toUTCISOString: jest.fn(d => d.toISOString()),
  }));
  return require('../../src/services/polling-service');
}

// ── start / stop ─────────────────────────────────────────────────────────────

describe('start / stop', () => {
  let pollingService;
  let supabase;

  beforeEach(() => {
    jest.useFakeTimers();
    supabase = makeSupabaseMock();
    pollingService = loadService(supabase, makeScreenshotServiceMock());
  });

  afterEach(() => {
    pollingService.stop();
    jest.useRealTimers();
  });

  it('sets isRunning=true and calls processPendingScreenshots immediately', async () => {
    pollingService.start();
    // Drain the promise queue so the initial processPendingScreenshots completes
    await Promise.resolve();
    await Promise.resolve();
    expect(pollingService.isRunning).toBe(true);
    expect(supabase.resetStuckProcessingScreenshots).toHaveBeenCalledWith(10);
  });

  it('warns and returns early if already running', () => {
    pollingService.start();
    const logger = require('../../src/utils/logger');
    jest.clearAllMocks();
    pollingService.start(); // second call
    expect(logger.warn).toHaveBeenCalledWith('Polling service is already running');
  });

  it('fires processPendingScreenshots after pollInterval via setInterval', async () => {
    pollingService.start();
    await Promise.resolve(); await Promise.resolve(); // drain initial
    supabase.resetStuckProcessingScreenshots.mockClear();

    jest.advanceTimersByTime(pollingService.pollInterval);
    await Promise.resolve(); await Promise.resolve();
    expect(supabase.resetStuckProcessingScreenshots).toHaveBeenCalled();
  });

  it('stop() clears isRunning and intervalId', () => {
    pollingService.start();
    expect(pollingService.isRunning).toBe(true);
    pollingService.stop();
    expect(pollingService.isRunning).toBe(false);
    expect(pollingService.intervalId).toBeNull();
  });

  it('stop() is a no-op when not running', () => {
    expect(() => pollingService.stop()).not.toThrow();
    expect(pollingService.isRunning).toBe(false);
  });

  it('service stays alive when initial processPendingScreenshots fails internally', async () => {
    // processPendingScreenshots catches all errors internally; start() stays alive
    supabase.resetStuckProcessingScreenshots.mockRejectedValue(new Error('unexpected crash'));
    pollingService.start();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const logger = require('../../src/utils/logger');
    // Internal catch logs "Error in polling cycle:"
    expect(logger.error).toHaveBeenCalledWith(
      'Error in polling cycle:',
      expect.any(Error)
    );
    expect(pollingService.isRunning).toBe(true); // service stays alive
  });

  it('logs error when interval cycle rejects', async () => {
    pollingService.start();
    await Promise.resolve(); await Promise.resolve();
    supabase.resetStuckProcessingScreenshots.mockRejectedValue(new Error('interval fail'));

    jest.advanceTimersByTime(pollingService.pollInterval);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const logger = require('../../src/utils/logger');
    expect(logger.error).toHaveBeenCalledWith(
      'Error in polling cycle:',
      expect.any(Error)
    );
  });

  it('logs "Error in initial polling cycle:" when processPendingScreenshots rejects directly', async () => {
    // Spy so the rejection bubbles out of start()'s .catch() on the first call only
    const spy = jest.spyOn(pollingService, 'processPendingScreenshots')
      .mockRejectedValueOnce(new Error('direct rejection'));
    pollingService.start();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    spy.mockRestore();
    const logger = require('../../src/utils/logger');
    expect(logger.error).toHaveBeenCalledWith(
      'Error in initial polling cycle:',
      expect.any(Error)
    );
  });

  it('logs "Error in polling cycle:" when processPendingScreenshots rejects on interval fire', async () => {
    // First call (initial) succeeds; second call (interval) rejects directly
    const spy = jest.spyOn(pollingService, 'processPendingScreenshots')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('interval rejection'));
    pollingService.start();
    await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(pollingService.pollInterval);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    spy.mockRestore();
    const logger = require('../../src/utils/logger');
    expect(logger.error).toHaveBeenCalledWith(
      'Error in polling cycle:',
      expect.any(Error)
    );
  });
});

// ── processPendingScreenshots ─────────────────────────────────────────────────

describe('processPendingScreenshots', () => {
  let pollingService;
  let supabase;

  beforeEach(() => {
    jest.useFakeTimers();
    supabase = makeSupabaseMock();
    pollingService = loadService(supabase, makeScreenshotServiceMock());
  });

  afterEach(() => {
    pollingService.processing = false;
    jest.useRealTimers();
  });

  it('skips when already processing', async () => {
    pollingService.processing = true;
    await pollingService.processPendingScreenshots();
    expect(supabase.resetStuckProcessingScreenshots).not.toHaveBeenCalled();
    const logger = require('../../src/utils/logger');
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Previous polling cycle still running'));
  });

  it('resets processing=false even when no pending screenshots', async () => {
    supabase.getPendingScreenshots.mockResolvedValue([]);
    await pollingService.processPendingScreenshots();
    expect(pollingService.processing).toBe(false);
  });

  it('logs debug when no pending screenshots', async () => {
    supabase.getPendingScreenshots.mockResolvedValue([]);
    await pollingService.processPendingScreenshots();
    const logger = require('../../src/utils/logger');
    expect(logger.debug).toHaveBeenCalledWith('No pending screenshots to process');
  });

  it('logs all-succeeded when no failures', async () => {
    supabase.getPendingScreenshots.mockResolvedValue([SCREENSHOT]);
    supabase.claimScreenshotForProcessing.mockResolvedValue(true);
    await pollingService.processPendingScreenshots();
    const logger = require('../../src/utils/logger');
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('all succeeded')
    );
  });

  it('logs failure count when some screenshots fail', async () => {
    supabase.getPendingScreenshots.mockResolvedValue([SCREENSHOT]);
    supabase.claimScreenshotForProcessing.mockRejectedValue(new Error('claim failed'));
    await pollingService.processPendingScreenshots();
    const logger = require('../../src/utils/logger');
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('1 failed')
    );
  });

  it('updates screenshot status to failed on processScreenshot error', async () => {
    supabase.getPendingScreenshots.mockResolvedValue([SCREENSHOT]);
    supabase.claimScreenshotForProcessing.mockRejectedValue(new Error('claim error'));
    await pollingService.processPendingScreenshots();
    expect(supabase.updateScreenshotStatus).toHaveBeenCalledWith('ss-1', 'failed', 'claim error');
  });

  it('logs error when updateScreenshotStatus to failed also fails', async () => {
    supabase.getPendingScreenshots.mockResolvedValue([SCREENSHOT]);
    supabase.claimScreenshotForProcessing.mockRejectedValue(new Error('claim error'));
    supabase.updateScreenshotStatus.mockRejectedValue(new Error('update error'));
    await pollingService.processPendingScreenshots();
    const logger = require('../../src/utils/logger');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to update screenshot status to failed',
      expect.objectContaining({ error: 'update error' })
    );
  });

  it('logs network errors at debug level', async () => {
    supabase.resetStuckProcessingScreenshots.mockRejectedValue(new Error('ENOTFOUND supabase.io'));
    await pollingService.processPendingScreenshots();
    const logger = require('../../src/utils/logger');
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Network error in polling cycle'),
      expect.any(Object)
    );
  });

  it('logs non-network errors at error level', async () => {
    supabase.resetStuckProcessingScreenshots.mockRejectedValue(new Error('unexpected crash'));
    await pollingService.processPendingScreenshots();
    const logger = require('../../src/utils/logger');
    expect(logger.error).toHaveBeenCalledWith(
      'Error in polling cycle:',
      expect.any(Error)
    );
  });

  it.each([
    'ECONNREFUSED',
    'ETIMEDOUT',
    'timeout',
    'certificate',
    'fetch failed',
  ])('treats "%s" as a network error', async (errorMsg) => {
    supabase.resetStuckProcessingScreenshots.mockRejectedValue(new Error(errorMsg));
    await pollingService.processPendingScreenshots();
    const logger = require('../../src/utils/logger');
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Network error in polling cycle'),
      expect.any(Object)
    );
  });

  it('rejects via Promise.race when screenshot processing times out', async () => {
    supabase.getPendingScreenshots.mockResolvedValue([SCREENSHOT]);
    supabase.claimScreenshotForProcessing.mockResolvedValue(true);
    // processScreenshot will never resolve
    supabase.downloadFile.mockReturnValue(new Promise(() => {}));

    // Use real timers for this test
    jest.useRealTimers();
    const origTimeout = process.env.SCREENSHOT_PROCESSING_TIMEOUT_MS;
    process.env.SCREENSHOT_PROCESSING_TIMEOUT_MS = '50'; // very short

    await pollingService.processPendingScreenshots();

    process.env.SCREENSHOT_PROCESSING_TIMEOUT_MS = origTimeout;
    const logger = require('../../src/utils/logger');
    expect(logger.error).toHaveBeenCalledWith(
      'Error processing screenshot',
      expect.objectContaining({ error: expect.stringContaining('timed out') })
    );
  }, 3000);
});

// ── processScreenshot ────────────────────────────────────────────────────────

describe('processScreenshot', () => {
  let pollingService;
  let supabase;
  let screenshotSvc;

  beforeEach(() => {
    jest.useFakeTimers();
    supabase = makeSupabaseMock();
    screenshotSvc = makeScreenshotServiceMock();
    pollingService = loadService(supabase, screenshotSvc);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns early if screenshot is already claimed', async () => {
    supabase.claimScreenshotForProcessing.mockResolvedValue(false);
    await pollingService.processScreenshot(SCREENSHOT);
    expect(screenshotSvc.analyzeActivity).not.toHaveBeenCalled();
  });

  it('processes a screenshot end-to-end successfully', async () => {
    await pollingService.processScreenshot(SCREENSHOT);
    expect(supabase.claimScreenshotForProcessing).toHaveBeenCalledWith('ss-1');
    expect(supabase.downloadFile).toHaveBeenCalledWith('screenshots', SCREENSHOT.storage_path);
    expect(screenshotSvc.analyzeActivity).toHaveBeenCalled();
    expect(supabase.saveAnalysisResult).toHaveBeenCalled();
    expect(supabase.updateScreenshotStatus).toHaveBeenCalledWith('ss-1', 'analyzed');
  });

  it('does not update duration when all timing fields are already set', async () => {
    await pollingService.processScreenshot(SCREENSHOT); // has duration_seconds, start_time, end_time
    expect(supabase.updateScreenshotDuration).not.toHaveBeenCalled();
  });

  it('updates duration when duration_seconds is null', async () => {
    await pollingService.processScreenshot({
      ...SCREENSHOT,
      duration_seconds: null,
      start_time: null,
      end_time: null,
    });
    expect(supabase.updateScreenshotDuration).toHaveBeenCalledWith(
      'ss-1',
      expect.objectContaining({ duration_seconds: expect.any(Number) })
    );
  });

  it('uses duration_seconds from screenshot when analysis timeSpentSeconds differs', async () => {
    screenshotSvc.analyzeActivity.mockResolvedValue({
      taskKey: 'ATG-1',
      projectKey: 'ATG',
      workType: 'office',
      confidenceScore: 0.9,
      timeSpentSeconds: 500,
      modelVersion: 'v3',
      metadata: { extractedText: '' },
    });
    await pollingService.processScreenshot(SCREENSHOT); // duration_seconds = 300
    expect(supabase.saveAnalysisResult).toHaveBeenCalledWith(
      expect.objectContaining({ time_spent_seconds: 300 }) // screenshot's duration wins
    );
  });

  it('uses analysis.timeSpentSeconds when screenshot duration_seconds is null', async () => {
    screenshotSvc.analyzeActivity.mockResolvedValue({
      taskKey: 'ATG-1',
      projectKey: 'ATG',
      workType: 'office',
      confidenceScore: 0.9,
      timeSpentSeconds: 500,
      modelVersion: 'v3',
      metadata: { extractedText: '' },
    });
    await pollingService.processScreenshot({
      ...SCREENSHOT,
      duration_seconds: null,
      start_time: null,
      end_time: null,
    });
    expect(supabase.saveAnalysisResult).toHaveBeenCalledWith(
      expect.objectContaining({ time_spent_seconds: 500 })
    );
  });

  it('logs completion info', async () => {
    await pollingService.processScreenshot(SCREENSHOT);
    const logger = require('../../src/utils/logger');
    expect(logger.info).toHaveBeenCalledWith(
      'Screenshot analysis completed',
      expect.objectContaining({ screenshot_id: 'ss-1' })
    );
  });
});

// ── _parseAssignedIssues ─────────────────────────────────────────────────────

describe('_parseAssignedIssues', () => {
  let pollingService;

  beforeEach(() => {
    jest.useFakeTimers();
    pollingService = loadService(makeSupabaseMock(), makeScreenshotServiceMock());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns array as-is when already an array', () => {
    const issues = [{ key: 'ATG-1' }];
    expect(pollingService._parseAssignedIssues(issues, 'ss-1')).toEqual(issues);
  });

  it('parses JSON string to array', () => {
    const json = JSON.stringify([{ key: 'ATG-2' }]);
    const result = pollingService._parseAssignedIssues(json, 'ss-1');
    expect(result).toEqual([{ key: 'ATG-2' }]);
  });

  it('returns empty array and warns on invalid JSON', () => {
    const result = pollingService._parseAssignedIssues('not-json', 'ss-1');
    expect(result).toEqual([]);
    const logger = require('../../src/utils/logger');
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to parse user_assigned_issues',
      expect.objectContaining({ screenshot_id: 'ss-1' })
    );
  });

  it('returns null when input is null', () => {
    expect(pollingService._parseAssignedIssues(null, 'ss-1')).toBeNull();
  });
});

// ── _getCachedAssignedIssues ─────────────────────────────────────────────────

describe('_getCachedAssignedIssues', () => {
  let pollingService;
  let supabase;

  beforeEach(() => {
    jest.useFakeTimers();
    supabase = makeSupabaseMock({
      getCachedIssues: jest.fn().mockResolvedValue([
        { issue_key: 'ATG-1', summary: 'Fix bug', status: 'In Progress', project_key: 'ATG' },
      ]),
    });
    pollingService = loadService(supabase, makeScreenshotServiceMock());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('maps supabase fields to expected shape', async () => {
    const result = await pollingService._getCachedAssignedIssues('user-1', 'org-1');
    expect(result).toEqual([
      { key: 'ATG-1', summary: 'Fix bug', status: 'In Progress', projectKey: 'ATG' }
    ]);
  });
});

// ── _deleteScreenshotFilesIfNeeded ────────────────────────────────────────────

describe('_deleteScreenshotFilesIfNeeded', () => {
  let pollingService;
  let supabase;

  afterEach(() => {
    delete process.env.DELETE_SCREENSHOTS_AFTER_ANALYSIS;
    jest.useRealTimers();
  });

  it('deletes screenshot and thumbnail when DELETE_AFTER_ANALYSIS is true (default)', async () => {
    jest.useFakeTimers();
    supabase = makeSupabaseMock();
    pollingService = loadService(supabase, makeScreenshotServiceMock());

    await pollingService._deleteScreenshotFilesIfNeeded('ss-1', 'users/user-1/screenshot_123.png', 'user-1');

    expect(supabase.deleteFile).toHaveBeenCalledWith('screenshots', 'users/user-1/screenshot_123.png');
    expect(supabase.deleteFile).toHaveBeenCalledWith('screenshots', 'users/user-1/thumb_123.jpg');
    expect(supabase.clearStorageUrls).toHaveBeenCalledWith('ss-1');
  });

  it('skips deletion when storage_path is null', async () => {
    jest.useFakeTimers();
    supabase = makeSupabaseMock();
    pollingService = loadService(supabase, makeScreenshotServiceMock());

    await pollingService._deleteScreenshotFilesIfNeeded('ss-1', null, 'user-1');
    expect(supabase.deleteFile).not.toHaveBeenCalled();
  });

  it('skips deletion when DELETE_SCREENSHOTS_AFTER_ANALYSIS=false', async () => {
    process.env.DELETE_SCREENSHOTS_AFTER_ANALYSIS = 'false';
    jest.useFakeTimers();
    supabase = makeSupabaseMock();
    pollingService = loadService(supabase, makeScreenshotServiceMock());

    await pollingService._deleteScreenshotFilesIfNeeded('ss-1', 'path/screenshot_1.png', 'user-1');
    expect(supabase.deleteFile).not.toHaveBeenCalled();
  });

  it('logs warning but does not throw when deleteFile fails', async () => {
    jest.useFakeTimers();
    supabase = makeSupabaseMock({
      deleteFile: jest.fn().mockRejectedValue(new Error('storage error')),
    });
    pollingService = loadService(supabase, makeScreenshotServiceMock());

    await expect(
      pollingService._deleteScreenshotFilesIfNeeded('ss-1', 'path/screenshot_1.png', 'user-1')
    ).resolves.toBeUndefined();

    const logger = require('../../src/utils/logger');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete screenshot from storage'),
      expect.any(Object)
    );
  });

  it('logs debug when thumbnail deletion fails (non-critical)', async () => {
    jest.useFakeTimers();
    const deleteFile = jest.fn()
      .mockResolvedValueOnce(undefined)   // main file succeeds
      .mockRejectedValueOnce(new Error('thumb not found')); // thumb fails
    supabase = makeSupabaseMock({ deleteFile });
    pollingService = loadService(supabase, makeScreenshotServiceMock());

    await pollingService._deleteScreenshotFilesIfNeeded('ss-1', 'path/screenshot_1.png', 'user-1');

    const logger = require('../../src/utils/logger');
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Thumbnail not found or already deleted'),
      expect.any(Object)
    );
  });
});

// ── _createWorklogIfNeeded ────────────────────────────────────────────────────

describe('_createWorklogIfNeeded', () => {
  let pollingService;
  let supabase;
  let screenshotSvc;

  beforeEach(() => {
    jest.useFakeTimers();
    supabase = makeSupabaseMock();
    screenshotSvc = makeScreenshotServiceMock();
    pollingService = loadService(supabase, screenshotSvc);
  });

  afterEach(() => {
    delete process.env.AUTO_CREATE_WORKLOGS;
    jest.useRealTimers();
  });

  it('does not create worklog when AUTO_CREATE_WORKLOGS is not set', async () => {
    await pollingService._createWorklogIfNeeded({
      analysis: { taskKey: 'ATG-1', workType: 'office', timeSpentSeconds: 300 },
      user_id: 'user-1',
      screenshot_id: 'ss-1',
      timestamp: '2024-01-01T10:00:00Z',
    });
    expect(screenshotSvc.createWorklog).not.toHaveBeenCalled();
  });

  it('does not create worklog when workType is not "office"', async () => {
    process.env.AUTO_CREATE_WORKLOGS = 'true';
    await pollingService._createWorklogIfNeeded({
      analysis: { taskKey: 'ATG-1', workType: 'meeting', timeSpentSeconds: 300 },
      user_id: 'user-1',
      screenshot_id: 'ss-1',
      timestamp: '2024-01-01T10:00:00Z',
    });
    expect(screenshotSvc.createWorklog).not.toHaveBeenCalled();
  });

  it('does not create worklog when taskKey is null', async () => {
    process.env.AUTO_CREATE_WORKLOGS = 'true';
    await pollingService._createWorklogIfNeeded({
      analysis: { taskKey: null, workType: 'office', timeSpentSeconds: 300 },
      user_id: 'user-1',
      screenshot_id: 'ss-1',
      timestamp: '2024-01-01T10:00:00Z',
    });
    expect(screenshotSvc.createWorklog).not.toHaveBeenCalled();
  });

  it('creates worklog and marks it when all conditions met', async () => {
    process.env.AUTO_CREATE_WORKLOGS = 'true';
    await pollingService._createWorklogIfNeeded({
      analysis: { taskKey: 'ATG-1', workType: 'office', timeSpentSeconds: 300 },
      user_id: 'user-1',
      screenshot_id: 'ss-1',
      timestamp: '2024-01-01T10:00:00Z',
    });
    expect(screenshotSvc.createWorklog).toHaveBeenCalledWith({
      userId: 'user-1',
      issueKey: 'ATG-1',
      timeSpentSeconds: 300,
      startedAt: '2024-01-01T10:00:00Z',
    });
    expect(supabase.markWorklogCreated).toHaveBeenCalledWith('ss-1', 'ATG-1');
  });

  it('logs error but does not throw when worklog creation fails', async () => {
    process.env.AUTO_CREATE_WORKLOGS = 'true';
    screenshotSvc.createWorklog.mockRejectedValue(new Error('worklog API error'));
    await expect(pollingService._createWorklogIfNeeded({
      analysis: { taskKey: 'ATG-1', workType: 'office', timeSpentSeconds: 300 },
      user_id: 'user-1',
      screenshot_id: 'ss-1',
      timestamp: '2024-01-01T10:00:00Z',
    })).resolves.toBeUndefined();
    const logger = require('../../src/utils/logger');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to create worklog',
      expect.objectContaining({ error: 'worklog API error', screenshot_id: 'ss-1' })
    );
  });
});

// ── processScreenshot — _getCachedAssignedIssues fallback ────────────────────

describe('processScreenshot — cached issues fallback', () => {
  let pollingService;
  let supabase;

  beforeEach(() => {
    jest.useFakeTimers();
    supabase = makeSupabaseMock({
      getCachedIssues: jest.fn().mockResolvedValue([
        { issue_key: 'ATG-5', summary: 'Task', status: 'Open', project_key: 'ATG' }
      ]),
    });
    pollingService = loadService(supabase, makeScreenshotServiceMock());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fetches cached issues when user_assigned_issues is null', async () => {
    await pollingService.processScreenshot({ ...SCREENSHOT, user_assigned_issues: null });
    expect(supabase.getUserCachedIssues).toHaveBeenCalledWith('user-1', 'org-1');
  });

  it('fetches cached issues when user_assigned_issues is empty array', async () => {
    await pollingService.processScreenshot({ ...SCREENSHOT, user_assigned_issues: [] });
    expect(supabase.getUserCachedIssues).toHaveBeenCalledWith('user-1', 'org-1');
  });

  it('uses parsed user_assigned_issues without fetching cache when populated', async () => {
    const issues = JSON.stringify([{ key: 'ATG-99' }]);
    await pollingService.processScreenshot({ ...SCREENSHOT, user_assigned_issues: issues });
    expect(supabase.getUserCachedIssues).not.toHaveBeenCalled();
  });
});
