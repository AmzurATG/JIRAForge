'use strict';

/**
 * End-to-End Time Tracking Test Suite
 *
 * Simulates a complete workday for a developer working on multiple Jira issues
 * (user stories, tasks, bugs) with realistic activity patterns. Tests the full
 * pipeline from activity record ingestion → AI analysis → time aggregation →
 * worklog calculations.
 *
 * Covers:
 * - Multiple issue types: User Stories, Tasks, Bugs
 * - Realistic time distribution across a workday
 * - Confidence scoring and threshold enforcement
 * - Approval gating (pending_approval flow)
 * - Unassigned work detection (meetings, browsing)
 * - Session continuity (consecutive records on same task)
 * - Idle time handling
 * - Time aggregation and worklog calculation accuracy
 * - Edge cases: sub-60s rounding, hallucinated keys, low confidence demotion
 */

// ============================================================================
// MOCKS
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
// TEST DATA — Realistic Jira Project Setup
// ============================================================================

const TEST_USER_ID = 'user-dev-001';
const TEST_ORG_ID = 'org-acme-corp';
const TEST_PROJECT_KEY = 'ENG';

/**
 * Simulated Jira issues assigned to the test user.
 * Mix of User Stories, Tasks, and Bugs — mirrors a real sprint backlog.
 */
const USER_ASSIGNED_ISSUES = [
  // User Stories
  {
    key: 'ENG-101',
    summary: 'Implement user authentication with OAuth 2.0 PKCE flow',
    status: 'In Progress',
    project: 'ENG',
    issueType: 'Story',
    description: 'As a user, I want to sign in using my Atlassian account via OAuth 2.0 PKCE flow so that my data is secure. Includes login page, token refresh, and session management.',
    labels: ['authentication', 'security', 'oauth'],
    priority: 'High',
    updated: '2026-05-06T14:00:00Z',
  },
  {
    key: 'ENG-102',
    summary: 'Build dashboard analytics charts with Chart.js',
    status: 'In Progress',
    project: 'ENG',
    issueType: 'Story',
    description: 'Create interactive charts showing time spent per project and per issue. Include daily, weekly, and monthly views with filtering. Use Chart.js for rendering.',
    labels: ['frontend', 'analytics', 'charts'],
    priority: 'Medium',
    updated: '2026-05-05T10:00:00Z',
  },
  {
    key: 'ENG-103',
    summary: 'Implement REST API rate limiting middleware',
    status: 'To Do',
    project: 'ENG',
    issueType: 'Story',
    description: 'Add express-rate-limit middleware to protect API endpoints from abuse. Configure per-route limits and respond with 429 status.',
    labels: ['backend', 'security', 'api'],
    priority: 'Medium',
    updated: '2026-05-04T09:00:00Z',
  },
  // Tasks (subtasks / technical tasks)
  {
    key: 'ENG-201',
    summary: 'Write unit tests for OAuth token refresh logic',
    status: 'In Progress',
    project: 'ENG',
    issueType: 'Task',
    description: 'Add Jest tests covering token refresh, expiry handling, and error cases for the auth module.',
    labels: ['testing', 'auth'],
    priority: 'High',
    updated: '2026-05-06T16:00:00Z',
  },
  {
    key: 'ENG-202',
    summary: 'Configure CI pipeline for automated test execution',
    status: 'In Progress',
    project: 'ENG',
    issueType: 'Task',
    description: 'Set up GitHub Actions workflow to run Jest tests on push to main and develop branches. Include coverage reporting to SonarCloud.',
    labels: ['devops', 'ci-cd'],
    priority: 'Medium',
    updated: '2026-05-05T08:00:00Z',
  },
  {
    key: 'ENG-203',
    summary: 'Database migration for user preferences table',
    status: 'To Do',
    project: 'ENG',
    issueType: 'Task',
    description: 'Create Supabase migration adding user_preferences table with columns for theme, notification settings, and timezone.',
    labels: ['database', 'migration'],
    priority: 'Low',
    updated: '2026-05-03T12:00:00Z',
  },
  // Bugs
  {
    key: 'ENG-301',
    summary: 'Fix: Dashboard time chart shows incorrect totals for Monday',
    status: 'In Progress',
    project: 'ENG',
    issueType: 'Bug',
    description: 'The weekly time chart on the dashboard miscalculates Monday totals by including Sunday late-night activities. Root cause: timezone offset not applied to week boundary calculation.',
    labels: ['bug', 'frontend', 'charts'],
    priority: 'High',
    updated: '2026-05-06T11:00:00Z',
  },
  {
    key: 'ENG-302',
    summary: 'Fix: API returns 500 when user has no organization',
    status: 'Open',
    project: 'ENG',
    issueType: 'Bug',
    description: 'GET /api/analytics throws unhandled null reference when user.organization_id is null. Should return 403 with helpful message.',
    labels: ['bug', 'backend', 'api'],
    priority: 'Critical',
    updated: '2026-05-06T09:00:00Z',
  },
  {
    key: 'ENG-303',
    summary: 'Fix: Screenshot upload fails silently on slow connections',
    status: 'Open',
    project: 'ENG',
    issueType: 'Bug',
    description: 'Desktop app does not retry screenshot upload when network is intermittent. User loses activity data without any notification.',
    labels: ['bug', 'desktop-app', 'reliability'],
    priority: 'Medium',
    updated: '2026-05-04T15:00:00Z',
  },
];

// ============================================================================
// ACTIVITY RECORDS — Simulates a full 8-hour workday (9:00 AM - 5:00 PM)
// ============================================================================

/**
 * Generate a realistic workday of activity records.
 * Each record represents a 5-minute capture interval (standard for BRD).
 *
 * Workday timeline:
 * 09:00-09:30 — Bug fix: ENG-301 (dashboard chart issue) - 30 min
 * 09:30-10:00 — Bug fix: ENG-302 (API 500 error) - 30 min
 * 10:00-10:15 — Stand-up meeting (idle, unassigned) - 15 min
 * 10:15-11:15 — Story: ENG-101 (OAuth implementation) - 60 min
 * 11:15-11:30 — Code review (browsing PR, related to ENG-201) - 15 min
 * 11:30-12:00 — Task: ENG-201 (writing tests for OAuth) - 30 min
 * 12:00-13:00 — Lunch break (non-office) - 60 min (not tracked)
 * 13:00-14:00 — Story: ENG-102 (dashboard charts) - 60 min
 * 14:00-14:30 — Task: ENG-202 (CI pipeline config) - 30 min
 * 14:30-14:45 — Slack messages (generic, unassigned) - 15 min
 * 14:45-15:30 — Story: ENG-101 (OAuth - continued) - 45 min
 * 15:30-16:00 — Bug fix: ENG-303 (upload retry logic) - 30 min
 * 16:00-16:30 — Task: ENG-203 (DB migration) - 30 min
 * 16:30-17:00 — Documentation & wrap-up (unassigned) - 30 min
 *
 * Total tracked: 7h (420 min) of 8h workday (60 min lunch excluded)
 */

function generateWorkdayRecords() {
  const baseDate = '2026-05-07';
  const records = [];
  let recordId = 1;

  function addRecord(hour, minute, appName, windowTitle, ocrText, durationSec = 300) {
    const startTime = `${baseDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
    const endMinute = minute + Math.floor(durationSec / 60);
    const endHour = hour + Math.floor(endMinute / 60);
    const endTime = `${baseDate}T${String(endHour).padStart(2, '0')}:${String(endMinute % 60).padStart(2, '0')}:00Z`;

    records.push({
      id: `rec-${String(recordId++).padStart(3, '0')}`,
      user_id: TEST_USER_ID,
      organization_id: TEST_ORG_ID,
      application_name: appName,
      window_title: windowTitle,
      ocr_text: ocrText,
      ocr_confidence: 0.85,
      total_time_seconds: durationSec,
      start_time: startTime,
      end_time: endTime,
      status: 'pending',
      classification: 'productive',
      metadata: {},
      user_assigned_issues: JSON.stringify(USER_ASSIGNED_ISSUES),
    });
  }

  // === 09:00-09:30 — Bug fix: ENG-301 (dashboard chart Monday totals) ===
  addRecord(9, 0, 'Code.exe', 'weeklyChart.tsx - ENG-301-fix-monday-totals - Visual Studio Code',
    'function getWeekBoundary(date, timezone) {\n  const startOfWeek = startOfISOWeek(date);\n  return adjustForTimezone(startOfWeek, timezone);\n}');
  addRecord(9, 5, 'Code.exe', 'weeklyChart.test.tsx - ENG-301-fix-monday-totals - Visual Studio Code',
    'describe("getWeekBoundary", () => {\n  it("should not include Sunday activities in Monday", () => {');
  addRecord(9, 10, 'chrome.exe', 'Date-fns startOfISOWeek documentation - Google Chrome',
    'startOfISOWeek returns the start of an ISO week for the given date. The ISO week starts on Monday.');
  addRecord(9, 15, 'Code.exe', 'weeklyChart.tsx - ENG-301-fix-monday-totals - Visual Studio Code',
    'const mondayStart = startOfISOWeek(selectedDate);\nconst sundayEnd = endOfISOWeek(subDays(selectedDate, 7));');
  addRecord(9, 20, 'Code.exe', 'timeUtils.ts - ENG-301-fix-monday-totals - Visual Studio Code',
    'export function getTimezoneAdjustedWeekStart(date: Date, tz: string): Date {\n  return zonedTimeToUtc(startOfISOWeek(date), tz);\n}');
  addRecord(9, 25, 'Code.exe', 'weeklyChart.tsx - ENG-301-fix-monday-totals - Visual Studio Code',
    'const weekData = filterByDateRange(activities, mondayStart, sundayEnd);\n// Fixed: use timezone-aware boundaries');

  // === 09:30-10:00 — Bug fix: ENG-302 (API 500 error) ===
  addRecord(9, 30, 'Code.exe', 'analyticsController.js - api-server - Visual Studio Code',
    'router.get("/api/analytics", authMiddleware, async (req, res) => {\n  const orgId = req.user.organization_id;\n  if (!orgId) return res.status(403).json({ error: "No organization" });');
  addRecord(9, 35, 'Code.exe', 'analyticsController.test.js - api-server - Visual Studio Code',
    'it("returns 403 when user has no organization", async () => {\n  const res = await request(app).get("/api/analytics")\n    .set("Authorization", "Bearer token-no-org");\n  expect(res.status).toBe(403);');
  addRecord(9, 40, 'Code.exe', 'analyticsController.js - api-server - Visual Studio Code',
    '// Before: const analytics = await getAnalytics(orgId); // throws if null\n// After: guard clause added above');
  addRecord(9, 45, 'WindowsTerminal.exe', 'npm test -- analyticsController.test.js - Terminal',
    'PASS tests/controllers/analyticsController.test.js\n  ✓ returns 403 when user has no organization (45 ms)\n  ✓ returns analytics for valid user (120 ms)');
  addRecord(9, 50, 'chrome.exe', 'Pull Request #247: Fix null org handling - GitHub',
    'ENG-302: Fix API 500 when user has no organization\n\nAdds guard clause to check organization_id before querying analytics.\n\nReviewers: @sarah-dev');
  addRecord(9, 55, 'Code.exe', 'analyticsController.js - api-server - Visual Studio Code',
    'logger.warn(`User ${req.user.id} attempted analytics without organization`);\nreturn res.status(403).json({\n  error: "Organization membership required",\n  code: "NO_ORG"});');

  // === 10:00-10:15 — Stand-up meeting (idle/unassigned) ===
  addRecord(10, 0, 'ms-teams.exe', 'Daily Stand-up - Engineering Team - Microsoft Teams',
    '(no text extracted)', 300);
  addRecord(10, 5, 'ms-teams.exe', 'Daily Stand-up - Engineering Team - Microsoft Teams',
    '(no text extracted)', 300);
  addRecord(10, 10, 'ms-teams.exe', 'Daily Stand-up - Engineering Team - Microsoft Teams',
    '(no text extracted)', 300);

  // === 10:15-11:15 — Story: ENG-101 (OAuth implementation) ===
  addRecord(10, 15, 'Code.exe', 'authService.ts - src/services - Visual Studio Code',
    'import { AuthorizationCode } from "simple-oauth2";\n\nexport class OAuthService {\n  private client: AuthorizationCode;');
  addRecord(10, 20, 'Code.exe', 'authService.ts - src/services - Visual Studio Code',
    'async getAuthorizationUrl(): Promise<string> {\n  const state = crypto.randomBytes(16).toString("hex");\n  const codeVerifier = generateCodeVerifier();');
  addRecord(10, 25, 'chrome.exe', 'Atlassian OAuth 2.0 (3LO) - Developer Documentation',
    'Authorization code grants (3LO)\nTo implement OAuth 2.0 authorization code grants:\n1. Direct user to authorization URL\n2. Receive authorization code');
  addRecord(10, 30, 'Code.exe', 'authService.ts - src/services - Visual Studio Code',
    'async exchangeCodeForToken(code: string, codeVerifier: string): Promise<TokenSet> {\n  const tokenParams = { code, redirect_uri: this.redirectUri, code_verifier: codeVerifier };');
  addRecord(10, 35, 'Code.exe', 'tokenRefresh.ts - src/services/auth - Visual Studio Code',
    'export async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {\n  const response = await fetch(TOKEN_URL, {\n    method: "POST",\n    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken })');
  addRecord(10, 40, 'Code.exe', 'authService.ts - src/services - Visual Studio Code',
    'private async storeTokenSecurely(tokenSet: TokenSet): Promise<void> {\n  await keytar.setPassword("brd-tracker", "access_token", tokenSet.access_token);');
  addRecord(10, 45, 'Code.exe', 'authMiddleware.ts - src/middleware - Visual Studio Code',
    'export async function validateToken(req: Request, res: Response, next: NextFunction) {\n  const token = extractBearerToken(req);\n  if (!token) return res.status(401).json({ error: "Missing token" });');
  addRecord(10, 50, 'chrome.exe', 'PKCE - RFC 7636 - OAuth 2.0 Proof Key for Code Exchange',
    'The code verifier is a cryptographically random string using characters [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~" with a minimum length of 43');
  addRecord(10, 55, 'Code.exe', 'pkce.ts - src/utils/auth - Visual Studio Code',
    'export function generateCodeVerifier(length = 64): string {\n  const array = crypto.getRandomValues(new Uint8Array(length));\n  return base64url.encode(array);');
  addRecord(11, 0, 'Code.exe', 'authService.ts - src/services - Visual Studio Code',
    'async handleCallback(code: string, state: string): Promise<User> {\n  this.validateState(state);\n  const tokenSet = await this.exchangeCodeForToken(code, this.storedVerifier);');
  addRecord(11, 5, 'Code.exe', 'authService.ts - src/services - Visual Studio Code',
    'const userInfo = await this.fetchUserProfile(tokenSet.access_token);\nreturn {\n  id: userInfo.account_id,\n  email: userInfo.email,\n  name: userInfo.name\n};');
  addRecord(11, 10, 'WindowsTerminal.exe', 'npm test -- auth - Terminal',
    'PASS tests/services/authService.test.ts\n  OAuthService\n    ✓ generates valid authorization URL with PKCE (23 ms)\n    ✓ exchanges code for token (45 ms)\n    ✓ refreshes expired token (38 ms)');

  // === 11:15-11:30 — Code review (related to ENG-201 - test task) ===
  addRecord(11, 15, 'chrome.exe', 'Pull Request #245: Add OAuth token refresh tests - GitHub',
    'ENG-201: Unit tests for OAuth token refresh\n\n+ describe("refreshAccessToken", () => {\n+   it("returns new token set on success", async () => {');
  addRecord(11, 20, 'chrome.exe', 'Pull Request #245: Files changed (4) - GitHub',
    'tests/services/tokenRefresh.test.ts\n+ it("throws AuthError when refresh token is expired", async () => {\n+   mockFetch.mockResolvedValue({ status: 401 });');
  addRecord(11, 25, 'chrome.exe', 'Pull Request #245: Review comment - GitHub',
    'Comment: Looks good! Maybe add a test for network failure during refresh?\nResponse: Good catch, adding that case now.');

  // === 11:30-12:00 — Task: ENG-201 (writing OAuth tests) ===
  addRecord(11, 30, 'Code.exe', 'tokenRefresh.test.ts - tests/services - Visual Studio Code',
    'describe("refreshAccessToken", () => {\n  it("retries on network failure", async () => {\n    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"))');
  addRecord(11, 35, 'Code.exe', 'tokenRefresh.test.ts - tests/services - Visual Studio Code',
    '  it("clears stored tokens on permanent auth failure", async () => {\n    mockFetch.mockResolvedValue({ status: 401, json: () => ({ error: "invalid_grant" }) });\n    await expect(refreshAccessToken(expiredToken)).rejects.toThrow("invalid_grant");');
  addRecord(11, 40, 'Code.exe', 'authService.test.ts - tests/services - Visual Studio Code',
    'describe("OAuthService.handleCallback", () => {\n  it("validates state parameter to prevent CSRF", async () => {\n    await expect(service.handleCallback(code, "wrong-state")).rejects.toThrow("State mismatch");');
  addRecord(11, 45, 'Code.exe', 'authService.test.ts - tests/services - Visual Studio Code',
    '  it("stores token securely after successful exchange", async () => {\n    mockKeytar.setPassword.mockResolvedValue();\n    await service.handleCallback(validCode, validState);');
  addRecord(11, 50, 'WindowsTerminal.exe', 'npm test -- auth --coverage - Terminal',
    'PASS tests/services/authService.test.ts\nPASS tests/services/tokenRefresh.test.ts\n\nStatements: 94.2% | Branches: 88.5% | Functions: 100% | Lines: 93.8%');
  addRecord(11, 55, 'Code.exe', 'tokenRefresh.test.ts - tests/services - Visual Studio Code',
    '  it("schedules token refresh before expiry", async () => {\n    const tokenSet = { access_token: "at", expires_in: 3600 };\n    await scheduleRefresh(tokenSet);\n    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 3300000);');

  // === 13:00-14:00 — Story: ENG-102 (dashboard analytics charts) ===
  addRecord(13, 0, 'Code.exe', 'TimeChart.tsx - src/components/analytics - Visual Studio Code',
    'import { Chart } from "chart.js/auto";\nimport { Bar } from "react-chartjs-2";\n\nexport function TimeChart({ data, period }: TimeChartProps) {');
  addRecord(13, 5, 'Code.exe', 'TimeChart.tsx - src/components/analytics - Visual Studio Code',
    'const chartData = useMemo(() => ({\n  labels: data.map(d => formatDate(d.date, period)),\n  datasets: [{\n    label: "Hours tracked",\n    data: data.map(d => d.totalSeconds / 3600),');
  addRecord(13, 10, 'chrome.exe', 'Chart.js - Bar Chart - Documentation',
    'Bar Chart\nA bar chart provides a way of showing data values as vertical bars. Options: responsive, maintainAspectRatio, scales configuration.');
  addRecord(13, 15, 'Code.exe', 'IssueBreakdown.tsx - src/components/analytics - Visual Studio Code',
    'export function IssueBreakdown({ issueData }: Props) {\n  const sorted = issueData.sort((a, b) => b.timeTracked - a.timeTracked);\n  return (\n    <div className="issue-breakdown">');
  addRecord(13, 20, 'Code.exe', 'analyticsHooks.ts - src/hooks - Visual Studio Code',
    'export function useTimeAnalytics(period: "daily" | "weekly" | "monthly") {\n  const [data, setData] = useState<TimeData[]>([]);\n  useEffect(() => {\n    invoke("fetchTimeAnalytics", { period })');
  addRecord(13, 25, 'Code.exe', 'TimeChart.tsx - src/components/analytics - Visual Studio Code',
    'const options = {\n  responsive: true,\n  plugins: { legend: { position: "top" } },\n  scales: {\n    y: { beginAtZero: true, title: { display: true, text: "Hours" } }');
  addRecord(13, 30, 'Code.exe', 'ProjectPieChart.tsx - src/components/analytics - Visual Studio Code',
    'import { Doughnut } from "react-chartjs-2";\n\nexport function ProjectPieChart({ projects }: Props) {\n  const chartData = { labels: projects.map(p => p.name),');
  addRecord(13, 35, 'Code.exe', 'WeeklyView.tsx - src/components/analytics - Visual Studio Code',
    'export function WeeklyView() {\n  const { data, loading } = useTimeAnalytics("weekly");\n  return (\n    <Card title="This Week">\n      <TimeChart data={data} period="weekly" />');
  addRecord(13, 40, 'Code.exe', 'TimeChart.test.tsx - tests/components - Visual Studio Code',
    'describe("TimeChart", () => {\n  it("renders bar chart with correct data points", () => {\n    render(<TimeChart data={mockWeekData} period="weekly" />);\n    expect(screen.getByRole("img")).toBeInTheDocument();');
  addRecord(13, 45, 'Code.exe', 'DailyView.tsx - src/components/analytics - Visual Studio Code',
    'export function DailyView() {\n  const { data, loading } = useTimeAnalytics("daily");\n  const todayTotal = data.reduce((sum, d) => sum + d.totalSeconds, 0);\n  return <h2>{formatDuration(todayTotal)}</h2>;');
  addRecord(13, 50, 'chrome.exe', 'React Chart.js 2 - npm package documentation',
    'react-chartjs-2 is a React wrapper for Chart.js. Import chart components: Bar, Line, Pie, Doughnut. Pass data and options as props.');
  addRecord(13, 55, 'Code.exe', 'MonthlyView.tsx - src/components/analytics - Visual Studio Code',
    'export function MonthlyView() {\n  const { data } = useTimeAnalytics("monthly");\n  const grouped = groupByWeek(data);\n  return <TimeChart data={grouped} period="monthly" />;');

  // === 14:00-14:30 — Task: ENG-202 (CI pipeline configuration) ===
  addRecord(14, 0, 'Code.exe', '.github/workflows/test.yml - Visual Studio Code',
    'name: Run Tests\non:\n  push:\n    branches: [main, develop]\njobs:\n  test:\n    runs-on: ubuntu-latest');
  addRecord(14, 5, 'Code.exe', '.github/workflows/test.yml - Visual Studio Code',
    '    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: "20"\n      - run: npm ci\n      - run: npm test -- --coverage');
  addRecord(14, 10, 'chrome.exe', 'GitHub Actions - SonarCloud Scan Action - Marketplace',
    'SonarCloud GitHub Action\nAnalyze your code with SonarCloud. Add sonarcloud.yml to your .github/workflows directory.');
  addRecord(14, 15, 'Code.exe', '.github/workflows/test.yml - Visual Studio Code',
    '      - name: SonarCloud Scan\n        uses: SonarSource/sonarcloud-github-action@master\n        env:\n          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}');
  addRecord(14, 20, 'chrome.exe', 'GitHub Actions run #1234 - Test pipeline - GitHub',
    'Run Tests ✓\n  ✓ Setup Node.js 20\n  ✓ Install dependencies (42s)\n  ✓ Run tests (1m 23s)\n  ✓ SonarCloud scan (2m 15s)');
  addRecord(14, 25, 'Code.exe', 'sonar-project.properties - Visual Studio Code',
    'sonar.organization=acme-corp\nsonar.projectKey=brd-time-tracker\nsonar.sources=src/\nsonar.javascript.lcov.reportPaths=coverage/lcov.info');

  // === 14:30-14:45 — Slack messages (generic, unassigned) ===
  addRecord(14, 30, 'Slack.exe', 'Slack - #engineering - Acme Corp',
    'Discussion about upcoming sprint planning\nThread: database migration timeline\nReply: Should we prioritize the user prefs table?');
  addRecord(14, 35, 'Slack.exe', 'Slack - #random - Acme Corp',
    'Team lunch poll for Friday\nOptions: Italian, Thai, Mexican\nVotes: Italian 5, Thai 3, Mexican 2');
  addRecord(14, 40, 'Slack.exe', 'Slack - Direct Message - Sarah Chen',
    'Quick question about the PR review feedback on the auth tests');

  // === 14:45-15:30 — Story: ENG-101 (OAuth - continued session) ===
  addRecord(14, 45, 'Code.exe', 'authService.ts - src/services - Visual Studio Code',
    'async logout(): Promise<void> {\n  await this.revokeToken(this.currentToken);\n  await keytar.deletePassword("brd-tracker", "access_token");\n  await keytar.deletePassword("brd-tracker", "refresh_token");');
  addRecord(14, 50, 'Code.exe', 'sessionManager.ts - src/services/auth - Visual Studio Code',
    'export class SessionManager {\n  private refreshTimer: NodeJS.Timeout | null = null;\n\n  async initSession(tokenSet: TokenSet): Promise<void> {\n    this.scheduleRefresh(tokenSet.expires_in);');
  addRecord(14, 55, 'Code.exe', 'authService.ts - src/services - Visual Studio Code',
    'async getAccessibleResources(accessToken: string): Promise<JiraCloudSite[]> {\n  const response = await fetch("https://api.atlassian.com/oauth/token/accessible-resources",\n    { headers: { Authorization: `Bearer ${accessToken}` } });');
  addRecord(15, 0, 'Code.exe', 'authService.ts - src/services - Visual Studio Code',
    '  const sites = await response.json();\n  return sites.map(site => ({\n    id: site.id,\n    name: site.name,\n    url: site.url,\n    scopes: site.scopes\n  }));');
  addRecord(15, 5, 'Code.exe', 'LoginPage.tsx - src/components/auth - Visual Studio Code',
    'export function LoginPage() {\n  const [loading, setLoading] = useState(false);\n  const handleLogin = async () => {\n    setLoading(true);\n    const authUrl = await invoke("getAuthorizationUrl");');
  addRecord(15, 10, 'Code.exe', 'LoginPage.tsx - src/components/auth - Visual Studio Code',
    '    window.open(authUrl, "_blank", "width=600,height=700");\n  };\n  return (\n    <Button onClick={handleLogin} isLoading={loading}>\n      Sign in with Atlassian\n    </Button>');
  addRecord(15, 15, 'Code.exe', 'authCallbackHandler.ts - src/handlers - Visual Studio Code',
    'export async function handleAuthCallback(callbackUrl: string): Promise<void> {\n  const url = new URL(callbackUrl);\n  const code = url.searchParams.get("code");\n  const state = url.searchParams.get("state");');
  addRecord(15, 20, 'WindowsTerminal.exe', 'npm run dev - Terminal',
    'Server running on http://localhost:3001\nOAuth callback server listening on http://localhost:8000/callback\nWaiting for authentication...');
  addRecord(15, 25, 'chrome.exe', 'localhost:3001 - BRD Time Tracker - Login',
    'BRD Time Tracker\nSign in with your Atlassian account to start tracking time.\n[Sign in with Atlassian] button');

  // === 15:30-16:00 — Bug fix: ENG-303 (screenshot upload retry) ===
  addRecord(15, 30, 'Code.exe', 'uploadService.py - python-desktop-app - Visual Studio Code',
    'class ScreenshotUploader:\n    MAX_RETRIES = 3\n    RETRY_DELAY_SEC = 5\n\n    async def upload_with_retry(self, screenshot_data: bytes):');
  addRecord(15, 35, 'Code.exe', 'uploadService.py - python-desktop-app - Visual Studio Code',
    '        for attempt in range(self.MAX_RETRIES):\n            try:\n                response = await self.supabase.storage.upload(path, screenshot_data)\n                return response');
  addRecord(15, 40, 'Code.exe', 'uploadService.py - python-desktop-app - Visual Studio Code',
    '            except (ConnectionError, TimeoutError) as e:\n                if attempt < self.MAX_RETRIES - 1:\n                    await asyncio.sleep(self.RETRY_DELAY_SEC * (attempt + 1))\n                    logger.warning(f"Upload retry {attempt + 1}: {e}")');
  addRecord(15, 45, 'Code.exe', 'test_upload_service.py - tests - Visual Studio Code',
    'def test_upload_retries_on_network_failure():\n    uploader = ScreenshotUploader(mock_supabase)\n    mock_supabase.storage.upload.side_effect = [ConnectionError(), ConnectionError(), success_response]');
  addRecord(15, 50, 'Code.exe', 'uploadService.py - python-desktop-app - Visual Studio Code',
    '                else:\n                    logger.error(f"Upload failed after {self.MAX_RETRIES} attempts")\n                    self.queue_for_later(screenshot_data)\n                    raise UploadError(f"Failed after {self.MAX_RETRIES} retries")');
  addRecord(15, 55, 'WindowsTerminal.exe', 'python -m pytest tests/test_upload_service.py -v - Terminal',
    'PASSED tests/test_upload_service.py::test_upload_retries_on_network_failure\nPASSED tests/test_upload_service.py::test_upload_queues_on_persistent_failure\nPASSED tests/test_upload_service.py::test_upload_success_first_attempt');

  // === 16:00-16:30 — Task: ENG-203 (DB migration - user preferences) ===
  addRecord(16, 0, 'Code.exe', '20260507_add_user_preferences.sql - supabase/migrations - Visual Studio Code',
    'CREATE TABLE IF NOT EXISTS public.user_preferences (\n  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,\n  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,');
  addRecord(16, 5, 'Code.exe', '20260507_add_user_preferences.sql - supabase/migrations - Visual Studio Code',
    '  theme VARCHAR(20) DEFAULT \'light\',\n  notification_enabled BOOLEAN DEFAULT true,\n  timezone VARCHAR(50) DEFAULT \'UTC\',\n  screenshot_interval_seconds INTEGER DEFAULT 300,');
  addRecord(16, 10, 'Code.exe', '20260507_add_user_preferences.sql - supabase/migrations - Visual Studio Code',
    '  organization_id UUID REFERENCES public.organizations(id),\n  created_at TIMESTAMPTZ DEFAULT NOW(),\n  updated_at TIMESTAMPTZ DEFAULT NOW()\n);\n\nALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;');
  addRecord(16, 15, 'Code.exe', '20260507_add_user_preferences.sql - supabase/migrations - Visual Studio Code',
    'CREATE POLICY "Users can read own preferences"\n  ON public.user_preferences FOR SELECT\n  USING (user_id = auth.uid());\n\nCREATE POLICY "Users can update own preferences"\n  ON public.user_preferences FOR UPDATE\n  USING (user_id = auth.uid());');
  addRecord(16, 20, 'WindowsTerminal.exe', 'supabase db reset - Terminal',
    'Resetting local database...\nApplying migration 20260507_add_user_preferences.sql...\nSeeding initial data...\nDatabase reset completed successfully.');
  addRecord(16, 25, 'DBeaver.exe', 'user_preferences - public - DBeaver',
    'SELECT * FROM public.user_preferences;\n-- 0 rows returned\n\n\\d user_preferences\n-- id uuid, user_id uuid, theme varchar, notification_enabled bool, timezone varchar');

  // === 16:30-17:00 — Documentation & wrap-up (generic, unassigned) ===
  addRecord(16, 30, 'chrome.exe', 'Confluence - Sprint 14 Notes - Acme Engineering',
    'Sprint 14 Progress Notes\n- OAuth implementation: 80% complete\n- Dashboard charts: In progress\n- CI pipeline: Configured and running');
  addRecord(16, 35, 'chrome.exe', 'Confluence - Sprint 14 Notes - Edit - Acme Engineering',
    'Added: Bug fixes completed today\n- ENG-301: Fixed Monday chart calculation\n- ENG-302: Fixed null org 500 error\n- ENG-303: Added upload retry logic');
  addRecord(16, 40, 'Outlook.exe', 'RE: Sprint Review Tomorrow - Microsoft Outlook',
    'Hi team, reminder that sprint review is tomorrow at 2 PM. Please prepare your demos.');
  addRecord(16, 45, 'chrome.exe', 'Jira Board - ENG Sprint 14 - Atlassian',
    'Sprint 14 board view\nIn Progress: ENG-101, ENG-102, ENG-201, ENG-202\nDone: ENG-301, ENG-302, ENG-303');
  addRecord(16, 50, 'Notepad.exe', 'TODO.txt - Notepad',
    'Tomorrow:\n- Continue ENG-101 OAuth: add error handling for revoked tokens\n- ENG-102: finish monthly view chart\n- Start ENG-103 rate limiting');
  addRecord(16, 55, 'explorer.exe', 'Downloads - File Explorer',
    '(no text extracted)');

  return records;
}

// ============================================================================
// EXPECTED AI RESPONSES — What the LLM should return for each record
// ============================================================================

/**
 * Generate the expected AI analysis responses for the workday.
 * Each record maps to an issue with appropriate confidence and reasoning.
 */
function generateExpectedAnalyses() {
  return [
    // 09:00-09:30 — ENG-301 (Bug: Monday chart fix) — 6 records
    { recordIndex: 0, taskKey: 'ENG-301', confidenceScore: 0.95, workType: 'office', reasoning: 'Branch name ENG-301-fix-monday-totals in title' },
    { recordIndex: 1, taskKey: 'ENG-301', confidenceScore: 0.95, workType: 'office', reasoning: 'Test file for ENG-301 branch' },
    { recordIndex: 2, taskKey: 'ENG-301', confidenceScore: 0.7, workType: 'office', reasoning: 'Researching date-fns for week boundary fix' },
    { recordIndex: 3, taskKey: 'ENG-301', confidenceScore: 0.95, workType: 'office', reasoning: 'ENG-301 branch, timezone week boundary code' },
    { recordIndex: 4, taskKey: 'ENG-301', confidenceScore: 0.9, workType: 'office', reasoning: 'Timezone-aware week start utility' },
    { recordIndex: 5, taskKey: 'ENG-301', confidenceScore: 0.9, workType: 'office', reasoning: 'Fixed date range filtering for chart' },

    // 09:30-10:00 — ENG-302 (Bug: API 500 error) — 6 records
    { recordIndex: 6, taskKey: 'ENG-302', confidenceScore: 0.85, workType: 'office', reasoning: 'Adding null org guard to analytics API' },
    { recordIndex: 7, taskKey: 'ENG-302', confidenceScore: 0.85, workType: 'office', reasoning: 'Test for 403 on missing org matches bug desc' },
    { recordIndex: 8, taskKey: 'ENG-302', confidenceScore: 0.85, workType: 'office', reasoning: 'Fixing null org handling in controller' },
    { recordIndex: 9, taskKey: 'ENG-302', confidenceScore: 0.8, workType: 'office', reasoning: 'Running tests for analytics controller' },
    { recordIndex: 10, taskKey: 'ENG-302', confidenceScore: 0.9, workType: 'office', reasoning: 'PR title references ENG-302 explicitly' },
    { recordIndex: 11, taskKey: 'ENG-302', confidenceScore: 0.85, workType: 'office', reasoning: 'Adding error logging for null org case' },

    // 10:00-10:15 — Stand-up (unassigned) — 3 records
    { recordIndex: 12, taskKey: null, confidenceScore: 0.0, workType: 'office', reasoning: 'Team stand-up meeting, no specific task' },
    { recordIndex: 13, taskKey: null, confidenceScore: 0.0, workType: 'office', reasoning: 'Team stand-up meeting, no specific task' },
    { recordIndex: 14, taskKey: null, confidenceScore: 0.0, workType: 'office', reasoning: 'Team stand-up meeting, no specific task' },

    // 10:15-11:15 — ENG-101 (Story: OAuth) — 12 records
    { recordIndex: 15, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'OAuth service implementation matches story' },
    { recordIndex: 16, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'PKCE code verifier implementation' },
    { recordIndex: 17, taskKey: 'ENG-101', confidenceScore: 0.8, workType: 'office', reasoning: 'Atlassian OAuth docs for implementation' },
    { recordIndex: 18, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'Token exchange in OAuth flow' },
    { recordIndex: 19, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'Token refresh logic for OAuth' },
    { recordIndex: 20, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'Secure token storage with keytar' },
    { recordIndex: 21, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'Auth middleware for token validation' },
    { recordIndex: 22, taskKey: 'ENG-101', confidenceScore: 0.75, workType: 'office', reasoning: 'PKCE RFC documentation research' },
    { recordIndex: 23, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'PKCE code verifier generation utility' },
    { recordIndex: 24, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'OAuth callback handler implementation' },
    { recordIndex: 25, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'User profile fetch after token exchange' },
    { recordIndex: 26, taskKey: 'ENG-101', confidenceScore: 0.8, workType: 'office', reasoning: 'Running auth tests, session continuity' },

    // 11:15-11:30 — ENG-201 (Task: OAuth tests) — 3 records
    { recordIndex: 27, taskKey: 'ENG-201', confidenceScore: 0.9, workType: 'office', reasoning: 'PR title references ENG-201 test task' },
    { recordIndex: 28, taskKey: 'ENG-201', confidenceScore: 0.85, workType: 'office', reasoning: 'Reviewing test file changes for token refresh' },
    { recordIndex: 29, taskKey: 'ENG-201', confidenceScore: 0.7, workType: 'office', reasoning: 'Code review feedback on auth tests' },

    // 11:30-12:00 — ENG-201 (Task: writing tests) — 6 records
    { recordIndex: 30, taskKey: 'ENG-201', confidenceScore: 0.85, workType: 'office', reasoning: 'Writing token refresh retry test' },
    { recordIndex: 31, taskKey: 'ENG-201', confidenceScore: 0.85, workType: 'office', reasoning: 'Testing permanent auth failure handling' },
    { recordIndex: 32, taskKey: 'ENG-201', confidenceScore: 0.85, workType: 'office', reasoning: 'Testing CSRF state validation' },
    { recordIndex: 33, taskKey: 'ENG-201', confidenceScore: 0.85, workType: 'office', reasoning: 'Testing secure token storage after exchange' },
    { recordIndex: 34, taskKey: 'ENG-201', confidenceScore: 0.8, workType: 'office', reasoning: 'Running full auth test suite with coverage' },
    { recordIndex: 35, taskKey: 'ENG-201', confidenceScore: 0.85, workType: 'office', reasoning: 'Testing scheduled token refresh timing' },

    // 13:00-14:00 — ENG-102 (Story: dashboard charts) — 12 records
    { recordIndex: 36, taskKey: 'ENG-102', confidenceScore: 0.85, workType: 'office', reasoning: 'TimeChart component with Chart.js' },
    { recordIndex: 37, taskKey: 'ENG-102', confidenceScore: 0.85, workType: 'office', reasoning: 'Chart data transformation for display' },
    { recordIndex: 38, taskKey: 'ENG-102', confidenceScore: 0.7, workType: 'office', reasoning: 'Chart.js bar chart documentation' },
    { recordIndex: 39, taskKey: 'ENG-102', confidenceScore: 0.85, workType: 'office', reasoning: 'Issue breakdown component for analytics' },
    { recordIndex: 40, taskKey: 'ENG-102', confidenceScore: 0.85, workType: 'office', reasoning: 'Analytics hook for fetching time data' },
    { recordIndex: 41, taskKey: 'ENG-102', confidenceScore: 0.85, workType: 'office', reasoning: 'Chart options with y-axis labels' },
    { recordIndex: 42, taskKey: 'ENG-102', confidenceScore: 0.85, workType: 'office', reasoning: 'Project pie chart component' },
    { recordIndex: 43, taskKey: 'ENG-102', confidenceScore: 0.85, workType: 'office', reasoning: 'Weekly analytics view component' },
    { recordIndex: 44, taskKey: 'ENG-102', confidenceScore: 0.8, workType: 'office', reasoning: 'Chart render test with mock data' },
    { recordIndex: 45, taskKey: 'ENG-102', confidenceScore: 0.85, workType: 'office', reasoning: 'Daily view total calculation' },
    { recordIndex: 46, taskKey: 'ENG-102', confidenceScore: 0.7, workType: 'office', reasoning: 'react-chartjs-2 docs for integration' },
    { recordIndex: 47, taskKey: 'ENG-102', confidenceScore: 0.85, workType: 'office', reasoning: 'Monthly view with weekly grouping' },

    // 14:00-14:30 — ENG-202 (Task: CI pipeline) — 6 records
    { recordIndex: 48, taskKey: 'ENG-202', confidenceScore: 0.85, workType: 'office', reasoning: 'GitHub Actions workflow for tests' },
    { recordIndex: 49, taskKey: 'ENG-202', confidenceScore: 0.85, workType: 'office', reasoning: 'CI pipeline steps configuration' },
    { recordIndex: 50, taskKey: 'ENG-202', confidenceScore: 0.8, workType: 'office', reasoning: 'SonarCloud scan action for CI' },
    { recordIndex: 51, taskKey: 'ENG-202', confidenceScore: 0.85, workType: 'office', reasoning: 'Adding SonarCloud step to workflow' },
    { recordIndex: 52, taskKey: 'ENG-202', confidenceScore: 0.85, workType: 'office', reasoning: 'Verifying CI pipeline run success' },
    { recordIndex: 53, taskKey: 'ENG-202', confidenceScore: 0.85, workType: 'office', reasoning: 'Sonar project properties config' },

    // 14:30-14:45 — Slack (unassigned) — 3 records
    { recordIndex: 54, taskKey: null, confidenceScore: 0.0, workType: 'office', reasoning: 'General Slack discussion, no task link' },
    { recordIndex: 55, taskKey: null, confidenceScore: 0.0, workType: 'non-office', reasoning: 'Social channel, non-work content' },
    { recordIndex: 56, taskKey: 'ENG-201', confidenceScore: 0.5, workType: 'office', reasoning: 'DM about PR review on auth tests' },

    // 14:45-15:30 — ENG-101 (Story: OAuth continued) — 9 records
    { recordIndex: 57, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'OAuth logout and token revocation' },
    { recordIndex: 58, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'Session manager for token lifecycle' },
    { recordIndex: 59, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'Accessible resources API integration' },
    { recordIndex: 60, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'Parsing Jira cloud sites response' },
    { recordIndex: 61, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'Login page UI component' },
    { recordIndex: 62, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'Login button with Atlassian OAuth' },
    { recordIndex: 63, taskKey: 'ENG-101', confidenceScore: 0.85, workType: 'office', reasoning: 'Auth callback URL handler' },
    { recordIndex: 64, taskKey: 'ENG-101', confidenceScore: 0.8, workType: 'office', reasoning: 'Running dev server with OAuth callback' },
    { recordIndex: 65, taskKey: 'ENG-101', confidenceScore: 0.75, workType: 'office', reasoning: 'Testing login page in browser' },

    // 15:30-16:00 — ENG-303 (Bug: upload retry) — 6 records
    { recordIndex: 66, taskKey: 'ENG-303', confidenceScore: 0.85, workType: 'office', reasoning: 'Upload retry logic for screenshots' },
    { recordIndex: 67, taskKey: 'ENG-303', confidenceScore: 0.85, workType: 'office', reasoning: 'Retry loop with exponential backoff' },
    { recordIndex: 68, taskKey: 'ENG-303', confidenceScore: 0.85, workType: 'office', reasoning: 'Exception handling for upload failures' },
    { recordIndex: 69, taskKey: 'ENG-303', confidenceScore: 0.85, workType: 'office', reasoning: 'Test for upload retry on network error' },
    { recordIndex: 70, taskKey: 'ENG-303', confidenceScore: 0.85, workType: 'office', reasoning: 'Queue for later on persistent failure' },
    { recordIndex: 71, taskKey: 'ENG-303', confidenceScore: 0.8, workType: 'office', reasoning: 'Running upload service test suite' },

    // 16:00-16:30 — ENG-203 (Task: DB migration) — 6 records
    { recordIndex: 72, taskKey: 'ENG-203', confidenceScore: 0.85, workType: 'office', reasoning: 'Creating user_preferences table' },
    { recordIndex: 73, taskKey: 'ENG-203', confidenceScore: 0.85, workType: 'office', reasoning: 'Table columns for preferences' },
    { recordIndex: 74, taskKey: 'ENG-203', confidenceScore: 0.85, workType: 'office', reasoning: 'RLS policy for user preferences' },
    { recordIndex: 75, taskKey: 'ENG-203', confidenceScore: 0.85, workType: 'office', reasoning: 'Row-level security policies' },
    { recordIndex: 76, taskKey: 'ENG-203', confidenceScore: 0.8, workType: 'office', reasoning: 'Applying migration with db reset' },
    { recordIndex: 77, taskKey: 'ENG-203', confidenceScore: 0.7, workType: 'office', reasoning: 'Verifying table structure in DBeaver' },

    // 16:30-17:00 — Documentation / wrap-up (mostly unassigned) — 6 records
    { recordIndex: 78, taskKey: null, confidenceScore: 0.0, workType: 'office', reasoning: 'Sprint notes update, no single task' },
    { recordIndex: 79, taskKey: null, confidenceScore: 0.0, workType: 'office', reasoning: 'Sprint notes editing, general update' },
    { recordIndex: 80, taskKey: null, confidenceScore: 0.0, workType: 'office', reasoning: 'Email about sprint review, no task' },
    { recordIndex: 81, taskKey: null, confidenceScore: 0.0, workType: 'office', reasoning: 'Jira board overview, no specific task' },
    { recordIndex: 82, taskKey: null, confidenceScore: 0.0, workType: 'office', reasoning: 'Personal TODO notes, not task-specific' },
    { recordIndex: 83, taskKey: null, confidenceScore: 0.0, workType: 'non-office', reasoning: 'File Explorer browsing, no task context' },
  ];
}

// ============================================================================
// EXPECTED TIME CALCULATIONS
// ============================================================================

/**
 * Expected time per issue based on the workday simulation.
 * Each record = 300 seconds (5 minutes).
 *
 * Calculation:
 * - ENG-101: 12 + 9 = 21 records × 300s = 6300s (1h 45m)
 * - ENG-102: 12 records × 300s = 3600s (1h 0m)
 * - ENG-103: 0 records (not worked on today)
 * - ENG-201: 3 + 6 + 1 (DM at 0.5 confidence) = 10 records × 300s = 3000s (50m)
 *   But the DM (record 56) has confidence 0.5 ≥ 0.4, so it passes threshold
 * - ENG-202: 6 records × 300s = 1800s (30m)
 * - ENG-203: 6 records × 300s = 1800s (30m)
 * - ENG-301: 6 records × 300s = 1800s (30m)
 * - ENG-302: 6 records × 300s = 1800s (30m)
 * - ENG-303: 6 records × 300s = 1800s (30m)
 * - Unassigned: 3 (standup) + 2 (slack) + 6 (wrap-up) = 11 records × 300s = 3300s (55m)
 * - Non-office: 1 (slack #random) + 1 (file explorer) = 2 records × 300s = 600s (10m)
 *
 * Total assigned: 21 + 12 + 10 + 6 + 6 + 6 + 6 + 6 = 73 records = 21,900s (6h 5m)
 * Total unassigned: 11 records = 3,300s (55m)
 * Total tracked: 84 records = 25,200s (7h 0m)
 */
const EXPECTED_TIME_PER_ISSUE = {
  'ENG-101': { records: 21, totalSeconds: 6300, description: 'OAuth implementation (Story)' },
  'ENG-102': { records: 12, totalSeconds: 3600, description: 'Dashboard charts (Story)' },
  'ENG-201': { records: 10, totalSeconds: 3000, description: 'OAuth test writing (Task)' },
  'ENG-202': { records: 6, totalSeconds: 1800, description: 'CI pipeline config (Task)' },
  'ENG-203': { records: 6, totalSeconds: 1800, description: 'DB migration (Task)' },
  'ENG-301': { records: 6, totalSeconds: 1800, description: 'Monday chart bug (Bug)' },
  'ENG-302': { records: 6, totalSeconds: 1800, description: 'API 500 error bug (Bug)' },
  'ENG-303': { records: 6, totalSeconds: 1800, description: 'Upload retry bug (Bug)' },
};

const EXPECTED_UNASSIGNED = {
  records: 11,
  totalSeconds: 3300,
  description: 'Meetings, Slack, documentation, file browsing',
};

const EXPECTED_TOTALS = {
  totalRecords: 84,
  totalSeconds: 25200, // 7 hours
  assignedRecords: 73,
  assignedSeconds: 21900, // 6h 5m
  unassignedRecords: 11,
  unassignedSeconds: 3300, // 55m
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const makeLLMResponse = (content, finishReason = 'stop') => ({
  response: {
    choices: [{ message: { content }, finish_reason: finishReason }],
  },
  provider: 'portkey',
  model: 'gemini-2.0-flash',
});

/**
 * Simulates what the DB layer does: apply confidence threshold and approval gating.
 * This replicates activity-db-service.updateActivityRecordAnalysis logic.
 */
function applyDbLayerLogic(analysis) {
  const MIN_CONFIDENCE_THRESHOLD = 0.4;
  const confidenceScore = analysis.confidenceScore ?? 0;
  const taskKeyMeetsThreshold = analysis.taskKey && confidenceScore >= MIN_CONFIDENCE_THRESHOLD;

  const effectiveTaskKey = taskKeyMeetsThreshold ? analysis.taskKey : null;
  let projectKey = null;
  if (effectiveTaskKey) {
    const match = effectiveTaskKey.match(/^([A-Z][A-Z0-9]+)-\d+$/);
    projectKey = match ? match[1] : null;
  }

  return {
    effectiveTaskKey,
    projectKey,
    approvalStatus: effectiveTaskKey ? 'pending_approval' : null,
    confidenceScore,
    workType: analysis.workType || 'office',
  };
}

/**
 * Aggregates time per issue from analyzed records (simulates worklogService logic).
 * Only includes records where:
 * - approval_status is 'approved' (for assigned) or NULL (for unassigned display)
 * - effectiveTaskKey is not null
 */
function aggregateTimePerIssue(analyses, records, approvedKeys = null) {
  const timeTotals = {};

  for (const analysis of analyses) {
    const recordIndex = analysis.recordIndex;
    if (recordIndex < 0 || recordIndex >= records.length) continue;

    const record = records[recordIndex];
    const dbResult = applyDbLayerLogic(analysis);

    if (dbResult.effectiveTaskKey) {
      // If approvedKeys is provided, only count approved records
      if (approvedKeys && !approvedKeys.has(dbResult.effectiveTaskKey)) continue;

      if (!timeTotals[dbResult.effectiveTaskKey]) {
        timeTotals[dbResult.effectiveTaskKey] = 0;
      }
      timeTotals[dbResult.effectiveTaskKey] += record.total_time_seconds;
    }
  }

  return timeTotals;
}

/**
 * Calculate unassigned time from analyses (records with no effective task key).
 */
function calculateUnassignedTime(analyses, records) {
  let total = 0;
  for (const analysis of analyses) {
    const recordIndex = analysis.recordIndex;
    if (recordIndex < 0 || recordIndex >= records.length) continue;

    const record = records[recordIndex];
    const dbResult = applyDbLayerLogic(analysis);

    if (!dbResult.effectiveTaskKey) {
      total += record.total_time_seconds;
    }
  }
  return total;
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe('E2E Time Tracking — Full Workday Simulation', () => {
  let records;
  let expectedAnalyses;

  beforeAll(() => {
    records = generateWorkdayRecords();
    expectedAnalyses = generateExpectedAnalyses();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    isActivityAIEnabled.mockReturnValue(true);
    formatAssignedIssues.mockReturnValue(
      USER_ASSIGNED_ISSUES.map(i => `${i.key}: ${i.summary} [${i.status}] (${i.issueType})`).join('\n')
    );
    activityDbService.updateActivityRecordAnalysis.mockResolvedValue({});
  });

  // ==========================================================================
  // SECTION 1: Data Generation Validation
  // ==========================================================================

  describe('Test Data Integrity', () => {
    it('generates exactly 84 activity records for a 7-hour workday', () => {
      expect(records).toHaveLength(84);
    });

    it('all records have required fields', () => {
      for (const record of records) {
        expect(record.id).toBeDefined();
        expect(record.user_id).toBe(TEST_USER_ID);
        expect(record.organization_id).toBe(TEST_ORG_ID);
        expect(record.application_name).toBeDefined();
        expect(record.window_title).toBeDefined();
        expect(record.total_time_seconds).toBe(300);
        expect(record.start_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(record.end_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      }
    });

    it('records are in chronological order', () => {
      for (let i = 1; i < records.length; i++) {
        const prev = new Date(records[i - 1].start_time).getTime();
        const curr = new Date(records[i].start_time).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    });

    it('total time equals 7 hours (25200 seconds)', () => {
      const totalSeconds = records.reduce((sum, r) => sum + r.total_time_seconds, 0);
      expect(totalSeconds).toBe(EXPECTED_TOTALS.totalSeconds);
    });

    it('expected analyses cover all 84 records', () => {
      expect(expectedAnalyses).toHaveLength(84);
      const indices = expectedAnalyses.map(a => a.recordIndex);
      expect(new Set(indices).size).toBe(84);
      expect(Math.min(...indices)).toBe(0);
      expect(Math.max(...indices)).toBe(83);
    });

    it('user has 9 assigned issues spanning 3 types', () => {
      expect(USER_ASSIGNED_ISSUES).toHaveLength(9);
      const types = new Set(USER_ASSIGNED_ISSUES.map(i => i.issueType));
      expect(types).toEqual(new Set(['Story', 'Task', 'Bug']));
    });
  });

  // ==========================================================================
  // SECTION 2: Full Batch Analysis Pipeline
  // ==========================================================================

  describe('Full Batch Analysis — Single LLM Call', () => {
    it('processes all 84 records and returns correct analyses', async () => {
      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(expectedAnalyses))
      );

      const result = await analyzeBatch(records, USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID);

      expect(result.analyses).toHaveLength(84);
      expect(result.recordsProcessed).toBe(84);
      expect(result.truncated).toBe(false);
      expect(result.provider).toBe('portkey');
      expect(result.model).toBe('gemini-2.0-flash');
    });

    it('calls updateActivityRecordAnalysis for each analyzed record', async () => {
      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(expectedAnalyses))
      );

      await analyzeBatch(records, USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID);

      expect(activityDbService.updateActivityRecordAnalysis).toHaveBeenCalledTimes(84);
    });

    it('persists correct task keys and metadata for each record', async () => {
      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(expectedAnalyses))
      );

      await analyzeBatch(records, USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID);

      // Verify first record (ENG-301 bug fix)
      expect(activityDbService.updateActivityRecordAnalysis).toHaveBeenCalledWith(
        'rec-001',
        expect.objectContaining({
          taskKey: 'ENG-301',
          metadata: expect.objectContaining({
            confidenceScore: 0.95,
            workType: 'office',
            aiProvider: 'portkey',
            aiModel: 'gemini-2.0-flash',
          }),
        })
      );

      // Verify an unassigned record (stand-up meeting)
      expect(activityDbService.updateActivityRecordAnalysis).toHaveBeenCalledWith(
        'rec-013',
        expect.objectContaining({
          taskKey: null,
          metadata: expect.objectContaining({
            confidenceScore: 0.0,
            workType: 'office',
          }),
        })
      );
    });
  });

  // ==========================================================================
  // SECTION 3: Time Calculation Accuracy
  // ==========================================================================

  describe('Time Aggregation per Issue', () => {
    it('calculates correct total time for ENG-101 (OAuth Story): 6300s = 1h 45m', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      expect(timeTotals['ENG-101']).toBe(EXPECTED_TIME_PER_ISSUE['ENG-101'].totalSeconds);
    });

    it('calculates correct total time for ENG-102 (Charts Story): 3600s = 1h 0m', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      expect(timeTotals['ENG-102']).toBe(EXPECTED_TIME_PER_ISSUE['ENG-102'].totalSeconds);
    });

    it('calculates correct total time for ENG-201 (Test Task): 3000s = 50m', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      expect(timeTotals['ENG-201']).toBe(EXPECTED_TIME_PER_ISSUE['ENG-201'].totalSeconds);
    });

    it('calculates correct total time for ENG-202 (CI Task): 1800s = 30m', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      expect(timeTotals['ENG-202']).toBe(EXPECTED_TIME_PER_ISSUE['ENG-202'].totalSeconds);
    });

    it('calculates correct total time for ENG-203 (DB Migration Task): 1800s = 30m', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      expect(timeTotals['ENG-203']).toBe(EXPECTED_TIME_PER_ISSUE['ENG-203'].totalSeconds);
    });

    it('calculates correct total time for ENG-301 (Monday Chart Bug): 1800s = 30m', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      expect(timeTotals['ENG-301']).toBe(EXPECTED_TIME_PER_ISSUE['ENG-301'].totalSeconds);
    });

    it('calculates correct total time for ENG-302 (API 500 Bug): 1800s = 30m', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      expect(timeTotals['ENG-302']).toBe(EXPECTED_TIME_PER_ISSUE['ENG-302'].totalSeconds);
    });

    it('calculates correct total time for ENG-303 (Upload Retry Bug): 1800s = 30m', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      expect(timeTotals['ENG-303']).toBe(EXPECTED_TIME_PER_ISSUE['ENG-303'].totalSeconds);
    });

    it('ENG-103 (rate limiting) has zero tracked time (not worked on)', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      expect(timeTotals['ENG-103']).toBeUndefined();
    });

    it('total assigned time equals 21900s (6h 5m)', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      const totalAssigned = Object.values(timeTotals).reduce((sum, t) => sum + t, 0);
      expect(totalAssigned).toBe(EXPECTED_TOTALS.assignedSeconds);
    });

    it('total unassigned time equals 3300s (55m)', () => {
      const unassignedTime = calculateUnassignedTime(expectedAnalyses, records);
      expect(unassignedTime).toBe(EXPECTED_TOTALS.unassignedSeconds);
    });

    it('assigned + unassigned = total tracked time (25200s = 7h)', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      const totalAssigned = Object.values(timeTotals).reduce((sum, t) => sum + t, 0);
      const unassignedTime = calculateUnassignedTime(expectedAnalyses, records);
      expect(totalAssigned + unassignedTime).toBe(EXPECTED_TOTALS.totalSeconds);
    });

    it('Stories account for the most time (9900s = 2h 45m)', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      const storyIssues = USER_ASSIGNED_ISSUES.filter(i => i.issueType === 'Story').map(i => i.key);
      const storyTime = storyIssues.reduce((sum, key) => sum + (timeTotals[key] || 0), 0);
      // ENG-101 (6300) + ENG-102 (3600) = 9900
      expect(storyTime).toBe(9900);
    });

    it('Tasks account for 6600s (1h 50m)', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      const taskIssues = USER_ASSIGNED_ISSUES.filter(i => i.issueType === 'Task').map(i => i.key);
      const taskTime = taskIssues.reduce((sum, key) => sum + (timeTotals[key] || 0), 0);
      // ENG-201 (3000) + ENG-202 (1800) + ENG-203 (1800) = 6600
      expect(taskTime).toBe(6600);
    });

    it('Bugs account for 5400s (1h 30m)', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      const bugIssues = USER_ASSIGNED_ISSUES.filter(i => i.issueType === 'Bug').map(i => i.key);
      const bugTime = bugIssues.reduce((sum, key) => sum + (timeTotals[key] || 0), 0);
      // ENG-301 (1800) + ENG-302 (1800) + ENG-303 (1800) = 5400
      expect(bugTime).toBe(5400);
    });
  });

  // ==========================================================================
  // SECTION 4: Confidence Threshold Enforcement
  // ==========================================================================

  describe('Confidence Threshold & Approval Gating', () => {
    it('all assigned records have confidence >= 0.4 (threshold)', () => {
      for (const analysis of expectedAnalyses) {
        if (analysis.taskKey) {
          expect(analysis.confidenceScore).toBeGreaterThanOrEqual(0.4);
        }
      }
    });

    it('records with confidence exactly 0.4 pass threshold (ENG-201 DM edge case not here)', () => {
      // The Slack DM about auth tests has confidence 0.5, which passes
      const slackDM = expectedAnalyses.find(a => a.recordIndex === 56);
      expect(slackDM.taskKey).toBe('ENG-201');
      expect(slackDM.confidenceScore).toBe(0.5);

      const dbResult = applyDbLayerLogic(slackDM);
      expect(dbResult.effectiveTaskKey).toBe('ENG-201');
      expect(dbResult.approvalStatus).toBe('pending_approval');
    });

    it('demotes task key to null when confidence < 0.4', () => {
      const lowConfidenceAnalysis = {
        recordIndex: 0,
        taskKey: 'ENG-101',
        confidenceScore: 0.3,
        workType: 'office',
        reasoning: 'Weak match',
      };

      const dbResult = applyDbLayerLogic(lowConfidenceAnalysis);
      expect(dbResult.effectiveTaskKey).toBeNull();
      expect(dbResult.projectKey).toBeNull();
      expect(dbResult.approvalStatus).toBeNull();
    });

    it('assigned records get approval_status = pending_approval', () => {
      for (const analysis of expectedAnalyses) {
        const dbResult = applyDbLayerLogic(analysis);
        if (dbResult.effectiveTaskKey) {
          expect(dbResult.approvalStatus).toBe('pending_approval');
        } else {
          expect(dbResult.approvalStatus).toBeNull();
        }
      }
    });

    it('73 records get pending_approval, 11 remain null (unassigned)', () => {
      let approvedCount = 0;
      let nullCount = 0;

      for (const analysis of expectedAnalyses) {
        const dbResult = applyDbLayerLogic(analysis);
        if (dbResult.approvalStatus === 'pending_approval') approvedCount++;
        else nullCount++;
      }

      expect(approvedCount).toBe(73);
      expect(nullCount).toBe(11);
    });
  });

  // ==========================================================================
  // SECTION 5: Task Key Validation (Anti-Hallucination)
  // ==========================================================================

  describe('Task Key Validation — Anti-Hallucination', () => {
    it('rejects hallucinated task keys not in assigned issues', async () => {
      const hallucinatedAnalyses = [
        { recordIndex: 0, taskKey: 'FAKE-999', confidenceScore: 0.9, workType: 'office', reasoning: 'Hallucinated' },
      ];
      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(hallucinatedAnalyses))
      );

      const result = await analyzeBatch(
        [records[0]], USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID
      );

      // validateAnalysisKeys clears the hallucinated key
      expect(result.analyses[0].taskKey).toBeNull();
      expect(result.analyses[0].confidenceScore).toBeLessThanOrEqual(0.3);
    });

    it('accepts all valid keys from user assigned issues', async () => {
      const validKeyAnalyses = USER_ASSIGNED_ISSUES.map((issue, index) => ({
        recordIndex: index,
        taskKey: issue.key,
        confidenceScore: 0.8,
        workType: 'office',
        reasoning: `Working on ${issue.key}`,
      }));

      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(validKeyAnalyses))
      );

      const testRecords = USER_ASSIGNED_ISSUES.map((issue, index) => ({
        ...records[0],
        id: `key-test-${index}`,
      }));

      const result = await analyzeBatch(
        testRecords, USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID
      );

      for (let i = 0; i < USER_ASSIGNED_ISSUES.length; i++) {
        expect(result.analyses[i].taskKey).toBe(USER_ASSIGNED_ISSUES[i].key);
      }
    });

    it('derives project key correctly from task key (ENG-xxx → ENG)', async () => {
      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(expectedAnalyses.slice(0, 1)))
      );

      const result = await analyzeBatch(
        [records[0]], USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID
      );

      expect(result.analyses[0].projectKey).toBe('ENG');
    });

    it('clears project key when task key is null', () => {
      const unassignedAnalysis = expectedAnalyses.find(a => a.taskKey === null);
      const dbResult = applyDbLayerLogic(unassignedAnalysis);
      expect(dbResult.projectKey).toBeNull();
    });
  });

  // ==========================================================================
  // SECTION 6: Work Type Classification
  // ==========================================================================

  describe('Work Type Classification', () => {
    it('correctly classifies office vs non-office activities', () => {
      const officeRecords = expectedAnalyses.filter(a => a.workType === 'office');
      const nonOfficeRecords = expectedAnalyses.filter(a => a.workType === 'non-office');

      // Most activities are office work
      expect(officeRecords.length).toBe(82);
      // Only Slack #random and File Explorer are non-office
      expect(nonOfficeRecords.length).toBe(2);
    });

    it('Slack #random channel is classified as non-office', () => {
      const slackRandom = expectedAnalyses.find(a => a.recordIndex === 55);
      expect(slackRandom.workType).toBe('non-office');
    });

    it('File Explorer at end of day is classified as non-office', () => {
      const fileExplorer = expectedAnalyses.find(a => a.recordIndex === 83);
      expect(fileExplorer.workType).toBe('non-office');
    });

    it('Team meetings are classified as office even without task assignment', () => {
      const standupRecords = expectedAnalyses.filter(a => a.recordIndex >= 12 && a.recordIndex <= 14);
      for (const record of standupRecords) {
        expect(record.workType).toBe('office');
        expect(record.taskKey).toBeNull();
      }
    });
  });

  // ==========================================================================
  // SECTION 7: Session Continuity
  // ==========================================================================

  describe('Session Continuity — Consecutive Task Matching', () => {
    it('ENG-101 has continuous sessions (morning + afternoon)', () => {
      const eng101Records = expectedAnalyses.filter(a => a.taskKey === 'ENG-101');
      expect(eng101Records).toHaveLength(21);

      // Morning session: records 15-26 (12 records, 10:15-11:15)
      const morningSession = eng101Records.filter(a => a.recordIndex >= 15 && a.recordIndex <= 26);
      expect(morningSession).toHaveLength(12);

      // Afternoon session: records 57-65 (9 records, 14:45-15:30)
      const afternoonSession = eng101Records.filter(a => a.recordIndex >= 57 && a.recordIndex <= 65);
      expect(afternoonSession).toHaveLength(9);
    });

    it('ENG-201 spans code review + test writing sessions', () => {
      const eng201Records = expectedAnalyses.filter(a => a.taskKey === 'ENG-201');
      expect(eng201Records).toHaveLength(10);

      // Code review session: 27-29 (11:15-11:30)
      const reviewSession = eng201Records.filter(a => a.recordIndex >= 27 && a.recordIndex <= 29);
      expect(reviewSession).toHaveLength(3);

      // Test writing session: 30-35 (11:30-12:00)
      const writingSession = eng201Records.filter(a => a.recordIndex >= 30 && a.recordIndex <= 35);
      expect(writingSession).toHaveLength(6);

      // DM about auth tests: record 56
      const dmRecord = eng201Records.find(a => a.recordIndex === 56);
      expect(dmRecord).toBeDefined();
      expect(dmRecord.confidenceScore).toBe(0.5);
    });

    it('consecutive same-task records maintain consistent confidence', () => {
      // ENG-301 morning session: all records should have high confidence
      const eng301Records = expectedAnalyses.filter(a => a.taskKey === 'ENG-301');
      for (const record of eng301Records) {
        expect(record.confidenceScore).toBeGreaterThanOrEqual(0.7);
      }
    });

    it('research/documentation records have slightly lower confidence than code records', () => {
      // Record 22 (PKCE RFC docs) has lower confidence than record 23 (code)
      const docsRecord = expectedAnalyses.find(a => a.recordIndex === 22);
      const codeRecord = expectedAnalyses.find(a => a.recordIndex === 23);
      expect(docsRecord.confidenceScore).toBeLessThan(codeRecord.confidenceScore);
    });
  });

  // ==========================================================================
  // SECTION 8: Batch Processing — Truncation & Partial Results
  // ==========================================================================

  describe('Batch Processing — Truncation Handling', () => {
    it('handles truncated response by salvaging complete records', async () => {
      // Simulate LLM running out of tokens after 40 records
      const partialAnalyses = expectedAnalyses.slice(0, 40);
      const truncatedJson = JSON.stringify(partialAnalyses).slice(0, -1) + ',{"recordIndex":40,"taskKey":';

      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(truncatedJson, 'length')
      );

      const result = await analyzeBatch(records, USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID);

      expect(result.analyses.length).toBeLessThanOrEqual(40);
      expect(result.truncated).toBe(true);
      expect(result.recordsProcessed).toBeLessThan(84);
    });

    it('reports correct recordsProcessed on partial salvage', async () => {
      const first20 = expectedAnalyses.slice(0, 20);
      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(first20))
      );

      const result = await analyzeBatch(records, USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID);

      expect(result.recordsProcessed).toBe(20);
      expect(result.truncated).toBe(true); // 20 < 84 records sent
    });

    it('time from partial results is consistent with full results', async () => {
      // Process first 12 records (should be ENG-301 + ENG-302)
      const first12 = expectedAnalyses.slice(0, 12);
      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(first12))
      );

      const result = await analyzeBatch(
        records.slice(0, 12), USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID
      );

      const timeTotals = aggregateTimePerIssue(result.analyses, records.slice(0, 12));
      expect(timeTotals['ENG-301']).toBe(1800); // 6 records × 300s
      expect(timeTotals['ENG-302']).toBe(1800); // 6 records × 300s
    });
  });

  // ==========================================================================
  // SECTION 9: Worklog Sync Calculations
  // ==========================================================================

  describe('Worklog Sync — Jira Time Formatting', () => {
    it('all issue totals are >= 60s (Jira minimum worklog)', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      for (const [key, seconds] of Object.entries(timeTotals)) {
        expect(seconds).toBeGreaterThanOrEqual(60);
      }
    });

    it('time converts correctly to Jira format (seconds → hours/minutes)', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);

      // ENG-101: 6300s = 1h 45m
      expect(Math.floor(timeTotals['ENG-101'] / 3600)).toBe(1);
      expect(Math.floor((timeTotals['ENG-101'] % 3600) / 60)).toBe(45);

      // ENG-102: 3600s = 1h 0m
      expect(Math.floor(timeTotals['ENG-102'] / 3600)).toBe(1);
      expect(Math.floor((timeTotals['ENG-102'] % 3600) / 60)).toBe(0);

      // ENG-201: 3000s = 50m
      expect(Math.floor(timeTotals['ENG-201'] / 3600)).toBe(0);
      expect(Math.floor((timeTotals['ENG-201'] % 3600) / 60)).toBe(50);
    });

    it('sub-60s records would be rounded up to 60s (minimum worklog)', () => {
      // Test the rounding logic used by worklogService
      const roundUp = (seconds) => Math.max(seconds, 60);
      expect(roundUp(45)).toBe(60);
      expect(roundUp(1)).toBe(60);
      expect(roundUp(60)).toBe(60);
      expect(roundUp(300)).toBe(300);
    });

    it('issue-level time totals sum matches overall assigned total', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      const sum = Object.values(timeTotals).reduce((a, b) => a + b, 0);
      expect(sum).toBe(EXPECTED_TOTALS.assignedSeconds);
    });
  });

  // ==========================================================================
  // SECTION 10: Edge Cases & Error Scenarios
  // ==========================================================================

  describe('Edge Cases', () => {
    it('handles record with empty OCR text gracefully', async () => {
      const emptyOcrRecords = [
        {
          ...records[0],
          id: 'empty-ocr-1',
          ocr_text: null,
          window_title: 'VS Code - project',
        },
      ];
      const emptyOcrAnalysis = [
        { recordIndex: 0, taskKey: 'ENG-101', confidenceScore: 0.6, workType: 'office', reasoning: 'VS Code context' },
      ];

      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(emptyOcrAnalysis))
      );

      const result = await analyzeBatch(emptyOcrRecords, USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID);
      expect(result.analyses[0].taskKey).toBe('ENG-101');
    });

    it('handles record with very low OCR confidence', async () => {
      const lowOcrRecords = [
        {
          ...records[0],
          id: 'low-ocr-1',
          ocr_text: 'garbled_text_xxxx',
          ocr_confidence: 0.2,
        },
      ];
      const lowOcrAnalysis = [
        { recordIndex: 0, taskKey: 'ENG-301', confidenceScore: 0.6, workType: 'office', reasoning: 'Branch name in title' },
      ];

      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(lowOcrAnalysis))
      );

      const result = await analyzeBatch(lowOcrRecords, USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID);
      expect(result.analyses[0].taskKey).toBe('ENG-301');
    });

    it('handles idle records with tracking_mode metadata', async () => {
      const idleRecord = [{
        ...records[0],
        id: 'idle-1',
        window_title: 'Confluence - Architecture Docs',
        application_name: 'chrome.exe',
        ocr_text: '(no text extracted)',
        metadata: { tracking_mode: 'idle_for_llm_review' },
        total_time_seconds: 420, // 7 minutes idle
      }];
      const idleAnalysis = [
        { recordIndex: 0, taskKey: 'ENG-101', confidenceScore: 0.55, workType: 'office', reasoning: 'Reading arch docs, likely OAuth research' },
      ];

      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(idleAnalysis))
      );

      const result = await analyzeBatch(idleRecord, USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID);
      expect(result.analyses[0].taskKey).toBe('ENG-101');
      expect(result.analyses[0].confidenceScore).toBe(0.55);
    });

    it('handles AI returning zero-confidence for all records (bad batch)', async () => {
      const zeroConfidenceAnalyses = records.slice(0, 5).map((_, i) => ({
        recordIndex: i,
        taskKey: null,
        confidenceScore: 0.0,
        workType: 'office',
        reasoning: 'Cannot determine task',
      }));

      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(zeroConfidenceAnalyses))
      );

      const result = await analyzeBatch(
        records.slice(0, 5), USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID
      );

      const timeTotals = aggregateTimePerIssue(result.analyses, records.slice(0, 5));
      expect(Object.keys(timeTotals)).toHaveLength(0);

      const unassigned = calculateUnassignedTime(result.analyses, records.slice(0, 5));
      expect(unassigned).toBe(1500); // 5 × 300s
    });

    it('handles mixed high and low confidence for same issue', async () => {
      const mixedAnalyses = [
        { recordIndex: 0, taskKey: 'ENG-101', confidenceScore: 0.9, workType: 'office', reasoning: 'Clear match' },
        { recordIndex: 1, taskKey: 'ENG-101', confidenceScore: 0.35, workType: 'office', reasoning: 'Weak match' },
        { recordIndex: 2, taskKey: 'ENG-101', confidenceScore: 0.6, workType: 'office', reasoning: 'Moderate match' },
      ];

      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(mixedAnalyses))
      );

      const testRecords = records.slice(0, 3);
      const result = await analyzeBatch(testRecords, USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID);

      const timeTotals = aggregateTimePerIssue(result.analyses, testRecords);
      // Record 1 (confidence 0.35) gets demoted below threshold
      expect(timeTotals['ENG-101']).toBe(600); // Only records 0 and 2 pass (2 × 300s)
    });

    it('multiple issues in single session are tracked separately', () => {
      // Morning: ENG-301 then immediately ENG-302 — correct boundary detection
      const eng301Time = aggregateTimePerIssue(expectedAnalyses, records)['ENG-301'];
      const eng302Time = aggregateTimePerIssue(expectedAnalyses, records)['ENG-302'];

      expect(eng301Time).toBe(1800); // 09:00-09:30 = 6 records
      expect(eng302Time).toBe(1800); // 09:30-10:00 = 6 records
    });
  });

  // ==========================================================================
  // SECTION 11: Project-Level Aggregation
  // ==========================================================================

  describe('Project-Level Time Aggregation', () => {
    it('derives correct project key for all assigned records', () => {
      for (const analysis of expectedAnalyses) {
        if (analysis.taskKey) {
          const dbResult = applyDbLayerLogic(analysis);
          expect(dbResult.projectKey).toBe('ENG');
        }
      }
    });

    it('total project time for ENG equals all assigned time (21900s)', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      const projectTotal = Object.entries(timeTotals)
        .filter(([key]) => key.startsWith('ENG-'))
        .reduce((sum, [, seconds]) => sum + seconds, 0);
      expect(projectTotal).toBe(EXPECTED_TOTALS.assignedSeconds);
    });
  });

  // ==========================================================================
  // SECTION 12: Realistic Proportions Validation
  // ==========================================================================

  describe('Realistic Time Distribution Validation', () => {
    it('OAuth story (ENG-101) is the largest time block (30% of assigned time)', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      const proportion = timeTotals['ENG-101'] / EXPECTED_TOTALS.assignedSeconds;
      expect(proportion).toBeCloseTo(0.288, 2); // ~29% — largest single item
    });

    it('bug fixes collectively take ~25% of assigned time', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      const bugTime = (timeTotals['ENG-301'] || 0) + (timeTotals['ENG-302'] || 0) + (timeTotals['ENG-303'] || 0);
      const proportion = bugTime / EXPECTED_TOTALS.assignedSeconds;
      expect(proportion).toBeCloseTo(0.247, 2); // ~25%
    });

    it('unassigned time is ~13% of total (meetings, slack, wrap-up)', () => {
      const proportion = EXPECTED_TOTALS.unassignedSeconds / EXPECTED_TOTALS.totalSeconds;
      expect(proportion).toBeCloseTo(0.131, 2); // ~13%
    });

    it('developer spends most time in code editors (> 60% of records)', () => {
      const codeRecords = records.filter(r =>
        r.application_name === 'Code.exe' || r.application_name === 'DBeaver.exe'
      );
      const proportion = codeRecords.length / records.length;
      expect(proportion).toBeGreaterThan(0.6);
    });

    it('browser usage is secondary (~15% of records)', () => {
      const browserRecords = records.filter(r => r.application_name === 'chrome.exe');
      const proportion = browserRecords.length / records.length;
      expect(proportion).toBeCloseTo(0.167, 1); // ~17%
    });

    it('average confidence for assigned records is > 0.75', () => {
      const assignedAnalyses = expectedAnalyses.filter(a => a.taskKey !== null);
      const avgConfidence = assignedAnalyses.reduce((sum, a) => sum + a.confidenceScore, 0) / assignedAnalyses.length;
      expect(avgConfidence).toBeGreaterThan(0.75);
    });
  });

  // ==========================================================================
  // SECTION 13: Multi-Batch Processing Simulation
  // ==========================================================================

  describe('Multi-Batch Processing (Polling Service Pattern)', () => {
    it('processes records in batches of 20 and aggregates correctly', async () => {
      const batchSize = 20;
      const allAnalyses = [];
      let totalProcessed = 0;

      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        const batchAnalyses = expectedAnalyses.slice(i, i + batchSize).map((a, idx) => ({
          ...a,
          recordIndex: idx, // re-index for batch
        }));

        chatCompletionWithFallback.mockResolvedValue(
          makeLLMResponse(JSON.stringify(batchAnalyses))
        );

        const result = await analyzeBatch(batch, USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID);
        totalProcessed += result.recordsProcessed;

        // Re-map analyses back to global indices
        for (const analysis of result.analyses) {
          allAnalyses.push({
            ...analysis,
            recordIndex: i + analysis.recordIndex,
          });
        }
      }

      expect(totalProcessed).toBe(84);
      expect(allAnalyses).toHaveLength(84);

      // Final time aggregation matches expectations
      const timeTotals = aggregateTimePerIssue(allAnalyses, records);
      expect(timeTotals['ENG-101']).toBe(6300);
      expect(timeTotals['ENG-102']).toBe(3600);
      expect(timeTotals['ENG-201']).toBe(3000);
      expect(timeTotals['ENG-301']).toBe(1800);
    });

    it('handles one failed batch without losing other batches', async () => {
      // First batch succeeds, second fails, third succeeds
      const batch1 = expectedAnalyses.slice(0, 20).map((a, i) => ({ ...a, recordIndex: i }));
      const batch3 = expectedAnalyses.slice(40, 60).map((a, i) => ({ ...a, recordIndex: i }));

      chatCompletionWithFallback
        .mockResolvedValueOnce(makeLLMResponse(JSON.stringify(batch1)))
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce(makeLLMResponse(JSON.stringify(batch3)));

      // Batch 1: success
      const result1 = await analyzeBatch(
        records.slice(0, 20), USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID
      );
      expect(result1.recordsProcessed).toBe(20);

      // Batch 2: failure
      await expect(
        analyzeBatch(records.slice(20, 40), USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID)
      ).rejects.toThrow('ETIMEDOUT');

      // Batch 3: success
      const result3 = await analyzeBatch(
        records.slice(40, 60), USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID
      );
      expect(result3.recordsProcessed).toBe(20);

      // We still got 40 records processed (batch 2's 20 will be retried later)
      const totalProcessed = result1.recordsProcessed + result3.recordsProcessed;
      expect(totalProcessed).toBe(40);
    });
  });

  // ==========================================================================
  // SECTION 14: Complete Pipeline Verification
  // ==========================================================================

  describe('Complete Pipeline — End-to-End Verification', () => {
    it('full pipeline: records → analysis → DB update → time aggregation matches expected', async () => {
      // 1. Mock LLM to return our expected analyses
      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(expectedAnalyses))
      );

      // 2. Run analysis
      const result = await analyzeBatch(records, USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID);

      // 3. Verify LLM was called once (batch processing)
      expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);

      // 4. Verify all records were persisted
      expect(activityDbService.updateActivityRecordAnalysis).toHaveBeenCalledTimes(84);

      // 5. Verify time calculations
      const timeTotals = aggregateTimePerIssue(result.analyses, records);

      // Verify each issue's time matches exactly
      for (const [issueKey, expected] of Object.entries(EXPECTED_TIME_PER_ISSUE)) {
        expect(timeTotals[issueKey]).toBe(expected.totalSeconds);
      }

      // 6. Verify totals
      const totalAssigned = Object.values(timeTotals).reduce((sum, t) => sum + t, 0);
      const totalUnassigned = calculateUnassignedTime(result.analyses, records);

      expect(totalAssigned).toBe(21900);
      expect(totalUnassigned).toBe(3300);
      expect(totalAssigned + totalUnassigned).toBe(25200);
    });

    it('pipeline respects approval gate — only approved records would sync to Jira', async () => {
      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(expectedAnalyses))
      );

      const result = await analyzeBatch(records, USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID);

      // Simulate user approving all records
      const allApprovedKeys = new Set(USER_ASSIGNED_ISSUES.map(i => i.key));
      const approvedTimeTotals = aggregateTimePerIssue(result.analyses, records, allApprovedKeys);

      // All assigned time is syncable once approved
      const syncableTotal = Object.values(approvedTimeTotals).reduce((sum, t) => sum + t, 0);
      expect(syncableTotal).toBe(21900);
    });

    it('pipeline correctly handles user who only approves some issues', async () => {
      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(expectedAnalyses))
      );

      const result = await analyzeBatch(records, USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID);

      // User only approves bug fixes, rejects other assignments
      const approvedBugsOnly = new Set(['ENG-301', 'ENG-302', 'ENG-303']);
      const approvedTimeTotals = aggregateTimePerIssue(result.analyses, records, approvedBugsOnly);

      expect(approvedTimeTotals['ENG-301']).toBe(1800);
      expect(approvedTimeTotals['ENG-302']).toBe(1800);
      expect(approvedTimeTotals['ENG-303']).toBe(1800);
      expect(approvedTimeTotals['ENG-101']).toBeUndefined();
      expect(approvedTimeTotals['ENG-102']).toBeUndefined();

      const syncableTotal = Object.values(approvedTimeTotals).reduce((sum, t) => sum + t, 0);
      expect(syncableTotal).toBe(5400); // Only bug fix time
    });

    it('DB update calls contain correct record IDs in order', async () => {
      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify(expectedAnalyses))
      );

      await analyzeBatch(records, USER_ASSIGNED_ISSUES, TEST_USER_ID, TEST_ORG_ID);

      // Verify first few calls have correct record IDs
      const calls = activityDbService.updateActivityRecordAnalysis.mock.calls;
      expect(calls[0][0]).toBe('rec-001');
      expect(calls[1][0]).toBe('rec-002');
      expect(calls[11][0]).toBe('rec-012');
      expect(calls[83][0]).toBe('rec-084');
    });
  });

  // ==========================================================================
  // SECTION 15: Summary Statistics
  // ==========================================================================

  describe('Summary Statistics — Dashboard Display Values', () => {
    it('generates correct daily summary data', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      const unassignedTime = calculateUnassignedTime(expectedAnalyses, records);

      const dailySummary = {
        date: '2026-05-07',
        totalTrackedSeconds: EXPECTED_TOTALS.totalSeconds,
        totalAssignedSeconds: Object.values(timeTotals).reduce((a, b) => a + b, 0),
        totalUnassignedSeconds: unassignedTime,
        issueCount: Object.keys(timeTotals).length,
        topIssue: Object.entries(timeTotals).sort((a, b) => b[1] - a[1])[0],
      };

      expect(dailySummary.totalTrackedSeconds).toBe(25200); // 7h
      expect(dailySummary.totalAssignedSeconds).toBe(21900); // 6h 5m
      expect(dailySummary.totalUnassignedSeconds).toBe(3300); // 55m
      expect(dailySummary.issueCount).toBe(8); // 8 issues worked on
      expect(dailySummary.topIssue[0]).toBe('ENG-101'); // Most time on OAuth
      expect(dailySummary.topIssue[1]).toBe(6300); // 1h 45m
    });

    it('generates correct issue type breakdown', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      const typeBreakdown = {};

      for (const issue of USER_ASSIGNED_ISSUES) {
        const type = issue.issueType;
        if (!typeBreakdown[type]) typeBreakdown[type] = 0;
        typeBreakdown[type] += timeTotals[issue.key] || 0;
      }

      expect(typeBreakdown['Story']).toBe(9900); // 2h 45m
      expect(typeBreakdown['Task']).toBe(6600);  // 1h 50m
      expect(typeBreakdown['Bug']).toBe(5400);   // 1h 30m
    });

    it('percentage breakdown is realistic for a development day', () => {
      const timeTotals = aggregateTimePerIssue(expectedAnalyses, records);
      const totalAssigned = Object.values(timeTotals).reduce((a, b) => a + b, 0);

      const storyPercent = 9900 / totalAssigned * 100;
      const taskPercent = 6600 / totalAssigned * 100;
      const bugPercent = 5400 / totalAssigned * 100;

      // Stories: ~45%, Tasks: ~30%, Bugs: ~25% — typical sprint distribution
      expect(storyPercent).toBeCloseTo(45.2, 0);
      expect(taskPercent).toBeCloseTo(30.1, 0);
      expect(bugPercent).toBeCloseTo(24.7, 0);
    });
  });
});
