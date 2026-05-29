/**
 * Application-wide constants
 */

// Jira Configuration
export const JQL_ACTIVE_STATUSES = 'statusCategory = "In Progress"';
export const MAX_JIRA_SEARCH_RESULTS = 50;
export const ISSUE_BATCH_SIZE = 20;

// Permission Configuration
export const REQUIRED_ADMIN_PERMISSION = 'ADMINISTER';
export const REQUIRED_PROJECT_ADMIN_PERMISSION = 'ADMINISTER_PROJECTS';
export const REQUIRED_CREATE_PERMISSION = 'CREATE_ISSUES';
export const REQUIRED_EDIT_PERMISSION = 'EDIT_ISSUES';

// Cache Configuration
export const ISSUE_CACHE_TTL = 120000; // 2 minutes in milliseconds
// Team analytics KVS cache TTL — 5 minutes balances freshness with latency savings
export const TEAM_ANALYTICS_CACHE_TTL_MS = 5 * 60 * 1000;
// Maximum number of 1,000-row pages fetched per paginated Supabase query.
// Pages are fired in parallel (see supabaseRequestPaginated), so this also caps
// concurrent egress per chunk. Forge's platform cap is 100 egress/runtime-minute;
// 30 leaves room for the export's other queries (org/user/permission lookups,
// project-team-analytics, and a second parallel chunk for non-productive data)
// while preventing silent data truncation on busy months.
export const MAX_PAGINATED_PAGES = 30;

// Default Settings (Global Admin Settings - stored in Forge storage)
// NOTE: Supabase credentials are now managed securely on the AI server
// Only AI server settings are configurable here (optional for custom deployments)
export const DEFAULT_SETTINGS = {
  aiServerUrl: '',
  aiServerApiKey: '',
  configured: false
};

// Default Tracking/Timesheet Settings (for screenshot monitoring, app lists, etc.)
export const DEFAULT_TRACKING_SETTINGS = {
  screenshotMonitoringEnabled: true,
  screenshotIntervalSeconds: 900, // 15 minutes
  intervalTrackingEnabled: true, // Capture at fixed intervals
  eventTrackingEnabled: false, // Capture on activity changes
  trackWindowChanges: true,
  trackIdleTime: true,
  idleThresholdSeconds: 300, // 5 minutes
  // DEPRECATED: whitelist/blacklist now use database-driven classification
  // See application_classifications table in Supabase
  whitelistEnabled: false, // DEPRECATED: Use classification_manager instead
  whitelistedApps: [], // DEPRECATED: Manage via application_classifications table
  blacklistEnabled: false, // DEPRECATED: Use classification_manager instead
  blacklistedApps: [], // DEPRECATED: Manage via application_classifications table
  nonWorkThresholdPercent: 30,
  flagExcessiveNonWork: true,
  privateSitesEnabled: true,
  privateSites: [],
  jiraWorklogSyncEnabled: true,
  showIdleInTimeline: true,
  workHoursStart: '09:00',
  workHoursEnd: '18:00',
  workDays: [1, 2, 3, 4, 5], // Monday=1 ... Sunday=7 (ISO weekday)
  desktopAdminPassword: ''
};

// Application Classification Types
export const CLASSIFICATION_TYPES = {
  PRODUCTIVE: 'productive',
  NON_PRODUCTIVE: 'non_productive',
  PRIVATE: 'private'
};

// Match By Types (how an app is identified)
export const MATCH_BY_TYPES = {
  PROCESS: 'process',   // Match by Windows process name (e.g., code.exe)
  URL: 'url'            // Match by domain pattern in browser window title (e.g., github.com)
};

// Browser process names (used to determine if URL-based matching should be used)
export const BROWSER_PROCESSES = [
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe',
  'opera.exe', 'vivaldi.exe', 'arc.exe'
];

// Default Classification Settings
export const DEFAULT_CLASSIFICATION_SETTINGS = {
  batchUploadInterval: 300,      // 5 minutes in seconds
  autoWorklogEnabled: false,
  nonWorkThreshold: 30           // 30% non-work threshold
};

// Pagination
export const DEFAULT_PAGINATION_LIMIT = 50;
export const DEFAULT_PAGINATION_OFFSET = 0;

// Time Analytics
export const MAX_DAILY_SUMMARY_DAYS = 30;
export const MAX_WEEKLY_SUMMARY_WEEKS = 12;
export const MAX_ISSUES_IN_ANALYTICS = 50;
