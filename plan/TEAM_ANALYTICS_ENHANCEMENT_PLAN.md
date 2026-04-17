# Team Analytics Enhancement - Implementation Plan

**Date:** April 8, 2026  
**Feature:** Enhanced Team Analytics with Drill-Down & Export Capabilities  
**Priority:** High  
**Estimated Effort:** 3-4 days

---

## 1. Overview

### 1.1 Problem Statement

The current Team Analytics Dashboard shows aggregate time data (Today/This Week/This Month) for each team member, but lacks drill-down capabilities to:
- View which issues a team member worked on for a specific time period
- See daily/weekly breakdowns when clicking on aggregate time values
- Access comprehensive user reports
- Export team analytics data for reporting/analysis

### 1.2 Goals

Enhance the Team Analytics Dashboard with:
1. **Clickable Time Values** - Click on Today/This Week/This Month hours to see detailed breakdown
2. **Clickable User Names** - Click on team member name to see comprehensive report
3. **Export Functionality** - Export entire team analytics to CSV/Excel
4. **Google Calendar-Inspired UI** - Modal/drawer interface for detailed views

### 1.3 User Stories

**As an Admin, I want to:**
- Click on a team member's "Today" hours (e.g., 1.4h) to see which issues they worked on and time per issue
- Click on "This Week" hours (e.g., 10h) to see daily breakdown with issues per day
- Click on "This Month" hours to see weekly/daily breakdown with issues
- Click on a team member's name to see all their activity reports (today, week, month)
- Export all team data to CSV for reporting to stakeholders
- See visual representations similar to Google Calendar's time breakdown

---

## 2. Feature Specifications

### 2.1 Feature 1: Clickable "Today" Time

**Trigger:** Admin clicks on a team member's "Today" hours (e.g., "1.4h")

**Behavior:**
- Opens a modal/drawer with detailed view
- Shows list of issues worked on today
- For each issue:
  - Issue key and summary
  - Time spent on that issue
  - Percentage of total day time
  - Visual progress bar
- Shows total time reconciliation
- Includes quick navigation to Jira issue

**Example Display:**
```
Today's Activity - Iswarya Kolimalla - April 8, 2026
Total Time: 1.4h (84 minutes)

Issue Breakdown:
┌─────────────────────────────────────────────────────────┐
│ FEEDBACK-41 - UI Enhancement                            │
│ ████████████████████░░░░░░  45m (54%)                  │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ FEEDBACK-45 - API Integration                           │
│ ████████████░░░░░░░░░░░░░░  30m (36%)                  │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ FEEDBACK-44 - Bug Fix                                   │
│ ████░░░░░░░░░░░░░░░░░░░░░░  9m (10%)                   │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Feature 2: Clickable "This Week" Time

**Trigger:** Admin clicks on a team member's "This Week" hours (e.g., "10h")

**Behavior:**
- Opens a modal/drawer with weekly breakdown
- Shows day-by-day breakdown (Monday through Sunday)
- For each day:
  - Date and day name
  - Total hours for that day
  - List of issues worked on
  - Time per issue
- Visual calendar-like representation
- Drill-down: Click on a specific day to see hourly breakdown

**Example Display:**
```
This Week's Activity - Iswarya Kolimalla
Week of April 6 - April 12, 2026
Total Time: 10h

Monday, April 6 - 2.5h
  • FEEDBACK-41 (1.5h) - UI Enhancement
  • FEEDBACK-45 (1h) - API Integration

Tuesday, April 7 - 2.1h
  • FEEDBACK-45 (1.5h) - API Integration
  • FEEDBACK-44 (0.6h) - Bug Fix

Wednesday, April 8 - 1.4h (Today)
  • FEEDBACK-41 (0.75h) - UI Enhancement
  • FEEDBACK-45 (0.5h) - API Integration
  • FEEDBACK-44 (0.15h) - Bug Fix

Thursday, April 9 - 0h
  No activity

[Continue for remaining days...]
```

### 2.3 Feature 3: Clickable "This Month" Time

**Trigger:** Admin clicks on a team member's "This Month" hours (e.g., "12.5h")

**Behavior:**
- Opens a modal/drawer with monthly breakdown
- Shows week-by-week aggregation
- For each week:
  - Week range
  - Total hours for that week
  - Day-by-day breakdown
  - Top issues worked on
- Calendar heatmap visualization showing activity intensity
- Drill-down: Click on a week to see daily details

**Example Display:**
```
This Month's Activity - Iswarya Kolimalla
April 2026
Total Time: 12.5h across 11 working days

Week 1 (Apr 1-5) - 2h
  • 3 issues worked
  • Most active: Wednesday (1.2h)
  
Week 2 (Apr 6-12) - 10h ← Current Week
  • 5 issues worked
  • Most active: Monday (2.5h)

Week 3 (Apr 13-19) - 0.5h
  • 1 issue worked

[Visual Heatmap]
Mo Tu We Th Fr Sa Su
□  □  ■  ■  □  □  □   Week 1
■■ ■■ ■  □  □  □  □   Week 2 (Current)
□  □  □  □  □  □  □   Week 3
```

### 2.4 Feature 4: Clickable User Name

**Trigger:** Admin clicks on a team member's name in the table

**Behavior:**
- Opens a comprehensive user activity report modal
- Consolidates all three views (Today, Week, Month) in tabs
- Includes:
  - Summary statistics (total hours, issues worked, productivity trends)
  - Tab 1: Today's Activity (same as Feature 1)
  - Tab 2: This Week's Activity (same as Feature 2)
  - Tab 3: This Month's Activity (same as Feature 3)
  - Visual charts (time trend line, issue distribution pie chart)
- Export button for individual user report

**Example Layout:**
```
╔════════════════════════════════════════════════════╗
║  User Activity Report - Iswarya Kolimalla    [X]  ║
╠════════════════════════════════════════════════════╣
║  [Today] [This Week] [This Month]      [Export]   ║
╠════════════════════════════════════════════════════╣
║  Summary Stats:                                    ║
║  • Total This Month: 12.5h                        ║
║  • Issues Worked: 5                               ║
║  • Average per Day: 1.4h                          ║
║  • Most Productive Day: Monday (2.5h)             ║
╠════════════════════════════════════════════════════╣
║  [Selected Tab Content Here]                      ║
║                                                    ║
╚════════════════════════════════════════════════════╝
```

### 2.5 Feature 5: Team Export Functionality

**Trigger:** Admin clicks "Export Report" button on Team Analytics Dashboard

**Behavior:**
- Exports comprehensive team analytics to CSV/Excel format
- Includes:
  - Team summary statistics
  - Member-by-member breakdown (Today/Week/Month)
  - Issue-level details for each member
  - Time distribution data
- Options for:
  - Date range selection
  - Export format (CSV, Excel, PDF)
  - Include/exclude specific data sections

**Export Format (CSV):**
```csv
Team Analytics Export - FEEDBACK Project
Generated: April 8, 2026 3:45 PM

TEAM SUMMARY
Active Members,Total Hours (Month),Issues Worked,Average Hours/Member
2,23.1h,11,11.5h

MEMBER BREAKDOWN
Member Name,Today,This Week,This Month,% of Total
Iswarya Kolimalla,1.4h,10h,12.5h,54%
Vishnu Sai Kanthamraju,2.7h,5.9h,10.6h,46%

DETAILED ISSUE BREAKDOWN - Iswarya Kolimalla
Date,Issue Key,Issue Summary,Time Spent,Status
2026-04-08,FEEDBACK-41,UI Enhancement,0.75h,In Progress
2026-04-08,FEEDBACK-45,API Integration,0.5h,In Progress
2026-04-08,FEEDBACK-44,Bug Fix,0.15h,Done
...
```

---

## 3. Architecture & Design

### 3.1 Component Structure

```
TeamAnalyticsTab.js (Modified)
├── TeamMemberActivityModal.js (NEW)
│   ├── TodayActivityView.js (NEW)
│   ├── WeekActivityView.js (NEW)
│   ├── MonthActivityView.js (NEW)
│   └── UserComprehensiveReport.js (NEW)
├── ExportModal.js (NEW)
└── Utility Components
    ├── IssueBreakdownList.js (NEW)
    ├── DailyActivityChart.js (NEW)
    ├── ActivityHeatmap.js (NEW)
    └── TimeProgressBar.js (NEW)
```

### 3.2 Data Flow

```
User Action (Click)
    ↓
TeamAnalyticsTab (State Update)
    ↓
Invoke Backend Resolver (if needed)
    ↓
Backend Service (Fetch detailed data)
    ↓
Supabase Query (Query daily_time_summary + activity_records)
    ↓
Format & Return Data
    ↓
Display in Modal Component
```

### 3.3 New Backend Resolvers

#### 3.3.1 `getMemberDayDetails`
- **Purpose:** Get detailed issue breakdown for a specific member on a specific day
- **Input:** `{ projectKey, userId, date }`
- **Output:** `{ userId, displayName, date, totalSeconds, issues: [...] }`

#### 3.3.2 `getMemberWeekDetails`
- **Purpose:** Get day-by-day breakdown for a specific member for the week
- **Input:** `{ projectKey, userId, weekStartDate }`
- **Output:** `{ userId, displayName, weekStart, totalSeconds, dailyBreakdown: [...] }`

#### 3.3.3 `getMemberMonthDetails`
- **Purpose:** Get week-by-week and day-by-day breakdown for the month
- **Input:** `{ projectKey, userId, month }`
- **Output:** `{ userId, displayName, month, totalSeconds, weeklyBreakdown: [...] }`

#### 3.3.4 `exportTeamAnalytics`
- **Purpose:** Generate exportable team analytics data
- **Input:** `{ projectKey, startDate, endDate, format }`
- **Output:** `{ data: [...], format: 'csv', filename: '...' }`

### 3.4 Database Queries

All queries will utilize existing views and tables:
- `daily_time_summary` - Primary source for aggregated data
- `activity_records` - Detailed interval data for issue-level breakdown
- `users` - User display names and metadata

**Example Query for Day Details:**
```sql
SELECT 
  ar.user_assigned_issue_key as issue_key,
  ar.project_key,
  SUM(ar.duration_seconds) as total_seconds,
  COUNT(DISTINCT ar.id) as session_count,
  MAX(ar.end_time) as last_worked
FROM activity_records ar
WHERE ar.organization_id = ?
  AND ar.user_id = ?
  AND ar.work_date = ?
  AND ar.user_assigned_issue_key IS NOT NULL
  AND ar.classification IN ('productive', 'unknown')
GROUP BY ar.user_assigned_issue_key, ar.project_key
ORDER BY total_seconds DESC;
```

---

## 4. Implementation Plan

### Phase 1: Backend Implementation (Day 1-2)

#### Step 1.1: Create New Service Functions
**File:** `forge-app/src/services/analytics/teamAnalyticsService.js`

**New Functions to Create:**
1. `fetchMemberDayDetails(accountId, cloudId, projectKey, userId, date)`
   - Query activity_records for specific user and date
   - Group by issue_key
   - Calculate time per issue
   - Fetch issue summaries from Jira API
   - Return formatted breakdown

2. `fetchMemberWeekDetails(accountId, cloudId, projectKey, userId, weekStartDate)`
   - Query activity_records for user for week range
   - Group by work_date and issue_key
   - Calculate daily totals and per-issue times
   - Return day-by-day breakdown with issues

3. `fetchMemberMonthDetails(accountId, cloudId, projectKey, userId, month)`
   - Query activity_records for user for entire month
   - Group by week and day
   - Calculate weekly aggregations and daily breakdowns
   - Return week-by-week structure with drill-down data

4. `generateTeamExportData(accountId, cloudId, projectKey, startDate, endDate)`
   - Fetch all team analytics data
   - Fetch detailed breakdowns for each member
   - Format into exportable structure
   - Support multiple output formats (CSV, JSON)

**Implementation Details:**
```javascript
/**
 * Fetch detailed day activity for a team member
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} projectKey - Project key (null for all projects)
 * @param {string} userId - User ID
 * @param {string} date - Date string (YYYY-MM-DD)
 * @returns {Promise<Object>} Day activity details with issue breakdown
 */
export async function fetchMemberDayDetails(accountId, cloudId, projectKey, userId, date) {
  const { supabaseConfig, organization } = await initializeContext(accountId, cloudId);
  
  // Build query for activity records for the specific date
  let query = `activity_records?organization_id=eq.${organization.id}&user_id=eq.${userId}&work_date=eq.${date}&classification=in.(productive,unknown)&user_assigned_issue_key=not.is.null&select=user_assigned_issue_key,project_key,duration_seconds,start_time,end_time&order=start_time.asc`;
  
  // Add project filter if provided
  if (projectKey) {
    query += `&project_key=eq.${projectKey}`;
  }
  
  const records = await supabaseRequest(supabaseConfig, query);
  
  // Group by issue
  const issueMap = {};
  records.forEach(record => {
    const key = record.user_assigned_issue_key;
    if (!issueMap[key]) {
      issueMap[key] = {
        issueKey: key,
        projectKey: record.project_key,
        totalSeconds: 0,
        sessionCount: 0,
        sessions: []
      };
    }
    issueMap[key].totalSeconds += record.duration_seconds || 0;
    issueMap[key].sessionCount++;
    issueMap[key].sessions.push({
      startTime: record.start_time,
      endTime: record.end_time,
      seconds: record.duration_seconds
    });
  });
  
  // Sort by time spent (descending)
  const issues = Object.values(issueMap).sort((a, b) => b.totalSeconds - a.totalSeconds);
  
  // Fetch issue details from Jira (summary, status, etc.)
  const issueKeys = issues.map(i => i.issueKey);
  const issueDetails = await fetchIssueDetailsBatch(issueKeys);
  
  // Merge Jira details with time data
  issues.forEach(issue => {
    const jiraIssue = issueDetails[issue.issueKey];
    if (jiraIssue) {
      issue.summary = jiraIssue.summary;
      issue.status = jiraIssue.status;
      issue.statusCategory = jiraIssue.statusCategory;
      issue.priority = jiraIssue.priority;
      issue.issueType = jiraIssue.issueType;
    }
  });
  
  // Calculate totals
  const totalSeconds = issues.reduce((sum, i) => sum + i.totalSeconds, 0);
  
  // Get user info
  const userInfo = await supabaseRequest(
    supabaseConfig,
    `users?id=eq.${userId}&select=display_name,email`
  );
  const displayName = userInfo[0]?.display_name || userInfo[0]?.email || 'Unknown User';
  
  return {
    userId,
    displayName,
    date,
    totalSeconds,
    totalHours: Math.round(totalSeconds / 3600 * 10) / 10,
    issueCount: issues.length,
    issues
  };
}

// Similar implementations for fetchMemberWeekDetails and fetchMemberMonthDetails
```

#### Step 1.2: Create Helper Function for Batch Issue Details
**File:** `forge-app/src/services/analytics/teamAnalyticsService.js`

```javascript
/**
 * Fetch issue details from Jira in batch
 * @param {Array<string>} issueKeys - Array of issue keys
 * @returns {Promise<Object>} Map of issueKey -> issue details
 */
async function fetchIssueDetailsBatch(issueKeys) {
  if (!issueKeys || issueKeys.length === 0) return {};
  
  try {
    // Jira JQL search - fetch in batches of 100
    const results = {};
    const batchSize = 100;
    
    for (let i = 0; i < issueKeys.length; i += batchSize) {
      const batch = issueKeys.slice(i, i + batchSize);
      const jql = `key in (${batch.join(',')})`;
      
      const response = await api.asApp().requestJira(route`/rest/api/3/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jql,
          fields: ['summary', 'status', 'priority', 'issuetype'],
          maxResults: batchSize
        })
      });
      
      const data = await response.json();
      data.issues?.forEach(issue => {
        results[issue.key] = {
          summary: issue.fields.summary,
          status: issue.fields.status?.name,
          statusCategory: issue.fields.status?.statusCategory?.key,
          priority: issue.fields.priority?.name,
          issueType: issue.fields.issuetype?.name
        };
      });
    }
    
    return results;
  } catch (error) {
    console.error('Error fetching issue details:', error);
    return {};
  }
}
```

#### Step 1.3: Register New Resolvers
**File:** `forge-app/src/resolvers/analyticsResolvers.js`

**Functions to Add:**
```javascript
/**
 * Resolver for fetching member day details
 */
resolver.define('getMemberDayDetails', async (req) => {
  const { payload, context } = req;
  const accountId = context.accountId;
  const cloudId = context.cloudId;
  const { projectKey, userId, date } = payload;

  try {
    // Verify admin permissions
    const isAdmin = await isJiraAdmin(accountId);
    const permissions = await checkUserPermissions(accountId);
    const isProjectAdmin = permissions.projectAdminProjects?.includes(projectKey);

    if (!isAdmin && !isProjectAdmin) {
      return {
        success: false,
        error: 'Insufficient permissions'
      };
    }

    const data = await fetchMemberDayDetails(accountId, cloudId, projectKey, userId, date);
    return { success: true, data };
  } catch (error) {
    console.error('Error fetching member day details:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Resolver for fetching member week details
 */
resolver.define('getMemberWeekDetails', async (req) => {
  const { payload, context } = req;
  const accountId = context.accountId;
  const cloudId = context.cloudId;
  const { projectKey, userId, weekStartDate } = payload;

  try {
    const isAdmin = await isJiraAdmin(accountId);
    const permissions = await checkUserPermissions(accountId);
    const isProjectAdmin = permissions.projectAdminProjects?.includes(projectKey);

    if (!isAdmin && !isProjectAdmin) {
      return { success: false, error: 'Insufficient permissions' };
    }

    const data = await fetchMemberWeekDetails(accountId, cloudId, projectKey, userId, weekStartDate);
    return { success: true, data };
  } catch (error) {
    console.error('Error fetching member week details:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Resolver for fetching member month details
 */
resolver.define('getMemberMonthDetails', async (req) => {
  const { payload, context } = req;
  const accountId = context.accountId;
  const cloudId = context.cloudId;
  const { projectKey, userId, month } = payload;

  try {
    const isAdmin = await isJiraAdmin(accountId);
    const permissions = await checkUserPermissions(accountId);
    const isProjectAdmin = permissions.projectAdminProjects?.includes(projectKey);

    if (!isAdmin && !isProjectAdmin) {
      return { success: false, error: 'Insufficient permissions' };
    }

    const data = await fetchMemberMonthDetails(accountId, cloudId, projectKey, userId, month);
    return { success: true, data };
  } catch (error) {
    console.error('Error fetching member month details:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Resolver for exporting team analytics
 */
resolver.define('exportTeamAnalytics', async (req) => {
  const { payload, context } = req;
  const accountId = context.accountId;
  const cloudId = context.cloudId;
  const { projectKey, startDate, endDate, format } = payload;

  try {
    const isAdmin = await isJiraAdmin(accountId);
    const permissions = await checkUserPermissions(accountId);
    const isProjectAdmin = permissions.projectAdminProjects?.includes(projectKey);

    if (!isAdmin && !isProjectAdmin) {
      return { success: false, error: 'Insufficient permissions' };
    }

    const data = await generateTeamExportData(accountId, cloudId, projectKey, startDate, endDate);
    return { success: true, data, format: format || 'csv' };
  } catch (error) {
    console.error('Error exporting team analytics:', error);
    return { success: false, error: error.message };
  }
});
```

#### Step 1.4: Update Service Exports
**File:** `forge-app/src/services/analyticsService.js`

Add exports for new functions:
```javascript
export {
  // ... existing exports
  fetchMemberDayDetails,
  fetchMemberWeekDetails,
  fetchMemberMonthDetails,
  generateTeamExportData
} from './analytics/teamAnalyticsService.js';
```

### Phase 2: Frontend Components (Day 2-3)

#### Step 2.1: Create Modal Component Structure
**File:** `forge-app/static/main/src/components/modals/TeamMemberActivityModal.js` (NEW)

```javascript
import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';
import { formatTime } from '../../utils';
import './TeamMemberActivityModal.css';

/**
 * Team Member Activity Modal
 * Displays detailed activity breakdown for a team member
 * Supports multiple views: Today, Week, Month, Comprehensive
 */
function TeamMemberActivityModal({
  isOpen,
  onClose,
  member,           // { userId, displayName, todayHours, weekHours, monthHours }
  projectKey,
  viewType,         // 'today' | 'week' | 'month' | 'comprehensive'
  initialDate       // For specific day/week/month view
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activityData, setActivityData] = useState(null);
  const [activeTab, setActiveTab] = useState(viewType || 'today');

  useEffect(() => {
    if (isOpen && member) {
      loadActivityData();
    }
  }, [isOpen, member, activeTab]);

  const loadActivityData = async () => {
    setLoading(true);
    setError(null);

    try {
      let result;
      const today = new Date().toISOString().split('T')[0];

      switch (activeTab) {
        case 'today':
          result = await invoke('getMemberDayDetails', {
            projectKey,
            userId: member.userId,
            date: initialDate || today
          });
          break;

        case 'week':
          const weekStart = getWeekStartDate(initialDate || today);
          result = await invoke('getMemberWeekDetails', {
            projectKey,
            userId: member.userId,
            weekStartDate: weekStart
          });
          break;

        case 'month':
          const month = initialDate ? initialDate.substring(0, 7) : today.substring(0, 7);
          result = await invoke('getMemberMonthDetails', {
            projectKey,
            userId: member.userId,
            month
          });
          break;

        default:
          throw new Error('Invalid view type');
      }

      if (result.success) {
        setActivityData(result.data);
      } else {
        setError(result.error || 'Failed to load activity data');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const getWeekStartDate = (dateStr) => {
    const date = new Date(dateStr);
    const dayOfWeek = date.getDay();
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(date);
    monday.setDate(date.getDate() - daysToMonday);
    return monday.toISOString().split('T')[0];
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="team-member-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-content">
            <h2>{member.displayName}'s Activity</h2>
            <p className="modal-subtitle">
              {viewType === 'comprehensive' ? 'Comprehensive Report' : 'Detailed Breakdown'}
            </p>
          </div>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        {viewType === 'comprehensive' ? (
          <div className="modal-tabs">
            <button
              className={`tab-btn ${activeTab === 'today' ? 'active' : ''}`}
              onClick={() => setActiveTab('today')}
            >
              Today
            </button>
            <button
              className={`tab-btn ${activeTab === 'week' ? 'active' : ''}`}
              onClick={() => setActiveTab('week')}
            >
              This Week
            </button>
            <button
              className={`tab-btn ${activeTab === 'month' ? 'active' : ''}`}
              onClick={() => setActiveTab('month')}
            >
              This Month
            </button>
          </div>
        ) : null}

        <div className="modal-content">
          {loading ? (
            <div className="loading-state">
              <div className="loading-spinner"></div>
              <p>Loading activity data...</p>
            </div>
          ) : error ? (
            <div className="error-state">
              <p>Error: {error}</p>
            </div>
          ) : (
            <>
              {activeTab === 'today' && <TodayActivityView data={activityData} />}
              {activeTab === 'week' && <WeekActivityView data={activityData} />}
              {activeTab === 'month' && <MonthActivityView data={activityData} />}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="secondary-btn" onClick={onClose}>Close</button>
          <button className="primary-btn" onClick={() => handleExport(activityData)}>
            Export Report
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Today Activity View Component
 */
function TodayActivityView({ data }) {
  if (!data || !data.issues || data.issues.length === 0) {
    return <p className="empty-state">No activity for this day</p>;
  }

  const totalSeconds = data.totalSeconds;

  return (
    <div className="today-activity-view">
      <div className="summary-section">
        <h3>Today's Summary</h3>
        <div className="summary-stats">
          <div className="stat-item">
            <div className="stat-value">{formatTime(totalSeconds)}</div>
            <div className="stat-label">Total Time</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{data.issueCount}</div>
            <div className="stat-label">Issues Worked</div>
          </div>
        </div>
      </div>

      <div className="issue-breakdown-section">
        <h3>Issue Breakdown</h3>
        <div className="issue-list">
          {data.issues.map((issue, idx) => {
            const percentage = Math.round((issue.totalSeconds / totalSeconds) * 100);
            const hours = Math.round(issue.totalSeconds / 3600 * 10) / 10;

            return (
              <div key={idx} className="issue-item">
                <div className="issue-header">
                  <div className="issue-key-summary">
                    <span className="issue-key">{issue.issueKey}</span>
                    <span className="issue-summary">{issue.summary || 'No summary'}</span>
                  </div>
                  <div className="issue-time">
                    <strong>{formatTime(issue.totalSeconds)}</strong>
                    <span className="issue-percentage">({percentage}%)</span>
                  </div>
                </div>
                <div className="issue-progress">
                  <div 
                    className="progress-bar" 
                    style={{ width: `${percentage}%` }}
                  ></div>
                </div>
                <div className="issue-meta">
                  <span className="meta-item">Status: {issue.status || 'Unknown'}</span>
                  <span className="meta-item">Sessions: {issue.sessionCount}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Week Activity View Component (Placeholder - implement based on TodayActivityView)
 */
function WeekActivityView({ data }) {
  // Similar structure to TodayActivityView but with daily breakdown
  return <div>Week view implementation</div>;
}

/**
 * Month Activity View Component (Placeholder - implement based on TodayActivityView)
 */
function MonthActivityView({ data }) {
  // Similar structure with weekly/daily breakdown
  return <div>Month view implementation</div>;
}

export default TeamMemberActivityModal;
```

#### Step 2.2: Create Export Modal Component
**File:** `forge-app/static/main/src/components/modals/ExportTeamAnalyticsModal.js` (NEW)

```javascript
import React, { useState } from 'react';
import { invoke } from '@forge/bridge';
import './ExportTeamAnalyticsModal.css';

/**
 * Export Team Analytics Modal
 * Allows admin to export team analytics data
 */
function ExportTeamAnalyticsModal({ isOpen, onClose, projectKey, teamAnalytics }) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState(null);
  const [dateRange, setDateRange] = useState('month'); // 'week' | 'month' | 'custom'
  const [format, setFormat] = useState('csv'); // 'csv' | 'excel'
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');

  const handleExport = async () => {
    setExporting(true);
    setError(null);

    try {
      // Calculate date range
      let startDate, endDate;
      const today = new Date();

      switch (dateRange) {
        case 'week':
          const weekStart = new Date(today);
          const dayOfWeek = weekStart.getDay();
          const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
          weekStart.setDate(today.getDate() - daysToMonday);
          startDate = weekStart.toISOString().split('T')[0];
          endDate = today.toISOString().split('T')[0];
          break;

        case 'month':
          startDate = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
          endDate = today.toISOString().split('T')[0];
          break;

        case 'custom':
          startDate = customStartDate;
          endDate = customEndDate;
          break;

        default:
          throw new Error('Invalid date range');
      }

      const result = await invoke('exportTeamAnalytics', {
        projectKey,
        startDate,
        endDate,
        format
      });

      if (result.success) {
        // Convert data to CSV/Excel and download
        downloadFile(result.data, format, projectKey);
        onClose();
      } else {
        setError(result.error || 'Export failed');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  };

  const downloadFile = (data, format, projectKey) => {
    const blob = new Blob([data], { type: format === 'csv' ? 'text/csv' : 'application/vnd.ms-excel' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `team-analytics-${projectKey}-${new Date().toISOString().split('T')[0]}.${format}`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Export Team Analytics</h2>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-content">
          <div className="export-options">
            <div className="option-group">
              <label>Date Range:</label>
              <select value={dateRange} onChange={(e) => setDateRange(e.target.value)}>
                <option value="week">This Week</option>
                <option value="month">This Month</option>
                <option value="custom">Custom Range</option>
              </select>
            </div>

            {dateRange === 'custom' && (
              <div className="custom-date-range">
                <div className="date-input">
                  <label>Start Date:</label>
                  <input type="date" value={customStartDate} onChange={(e) => setCustomStartDate(e.target.value)} />
                </div>
                <div className="date-input">
                  <label>End Date:</label>
                  <input type="date" value={customEndDate} onChange={(e) => setCustomEndDate(e.target.value)} />
                </div>
              </div>
            )}

            <div className="option-group">
              <label>Format:</label>
              <select value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="csv">CSV</option>
                <option value="excel">Excel</option>
              </select>
            </div>
          </div>

          {error && <div className="error-message">{error}</div>}
        </div>

        <div className="modal-footer">
          <button className="secondary-btn" onClick={onClose} disabled={exporting}>
            Cancel
          </button>
          <button className="primary-btn" onClick={handleExport} disabled={exporting}>
            {exporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ExportTeamAnalyticsModal;
```

#### Step 2.3: Modify TeamAnalyticsTab Component
**File:** `forge-app/static/main/src/components/tabs/TeamAnalyticsTab.js` (MODIFY)

**Changes to make:**
1. Add state for modals
2. Add click handlers for time values and user names
3. Add export button
4. Import new modal components

```javascript
// Add imports
import TeamMemberActivityModal from '../modals/TeamMemberActivityModal';
import ExportTeamAnalyticsModal from '../modals/ExportTeamAnalyticsModal';

// Add state (around line 15)
const [activityModalOpen, setActivityModalOpen] = useState(false);
const [selectedMember, setSelectedMember] = useState(null);
const [activityViewType, setActivityViewType] = useState('today');
const [exportModalOpen, setExportModalOpen] = useState(false);

// Add handler functions (around line 130)
const handleTodayClick = (member) => {
  setSelectedMember(member);
  setActivityViewType('today');
  setActivityModalOpen(true);
};

const handleWeekClick = (member) => {
  setSelectedMember(member);
  setActivityViewType('week');
  setActivityModalOpen(true);
};

const handleMonthClick = (member) => {
  setSelectedMember(member);
  setActivityViewType('month');
  setActivityModalOpen(true);
};

const handleMemberNameClick = (member) => {
  setSelectedMember(member);
  setActivityViewType('comprehensive');
  setActivityModalOpen(true);
};

const handleExportClick = () => {
  setExportModalOpen(true);
};

// Modify the team member table (around line 365-390)
// Change from:
// <td className="hours-cell"><strong>{member.todayHours}h</strong></td>
// To:
<td className="hours-cell clickable" onClick={() => handleTodayClick(member)}>
  <strong>{member.todayHours}h</strong>
</td>

// Similar changes for week and month columns

// Change member name to clickable (around line 380)
<span 
  className="member-name clickable" 
  onClick={() => handleMemberNameClick(member)}
>
  {member.displayName}
</span>

// Add Export button in header (around line 140)
<button className="export-btn" onClick={handleExportClick}>
  <svg>...</svg> Export Report
</button>

// Add modals before closing div (end of component)
<TeamMemberActivityModal
  isOpen={activityModalOpen}
  onClose={() => setActivityModalOpen(false)}
  member={selectedMember}
  projectKey={selectedProjectKey}
  viewType={activityViewType}
/>

<ExportTeamAnalyticsModal
  isOpen={exportModalOpen}
  onClose={() => setExportModalOpen(false)}
  projectKey={selectedProjectKey}
  teamAnalytics={teamAnalytics}
/>
```

#### Step 2.4: Create CSS Styles
**File:** `forge-app/static/main/src/components/modals/TeamMemberActivityModal.css` (NEW)
**File:** `forge-app/static/main/src/components/modals/ExportTeamAnalyticsModal.css` (NEW)
**File:** `forge-app/static/main/src/components/tabs/TeamAnalyticsTab.css` (MODIFY - add clickable styles)

```css
/* Add to TeamAnalyticsTab.css */
.hours-cell.clickable,
.member-name.clickable {
  cursor: pointer;
  transition: all 0.2s ease;
}

.hours-cell.clickable:hover {
  background-color: var(--ds-background-neutral-hovered);
  transform: scale(1.05);
}

.member-name.clickable:hover {
  color: var(--ds-link);
  text-decoration: underline;
}

.export-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background-color: var(--ds-background-brand-bold);
  color: white;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: background-color 0.2s;
}

.export-btn:hover {
  background-color: var(--ds-background-brand-bold-hovered);
}
```

### Phase 3: Testing & Refinement (Day 3-4)

#### Step 3.1: Unit Tests
**File:** `forge-app/tests/services/teamAnalyticsDetailService.test.js` (NEW)

Test cases for:
- `fetchMemberDayDetails` - various scenarios
- `fetchMemberWeekDetails` - week boundary cases
- `fetchMemberMonthDetails` - month transitions
- `generateTeamExportData` - data formatting

#### Step 3.2: Integration Tests
**File:** `forge-app/static/main/src/components/modals/__tests__/TeamMemberActivityModal.test.js` (NEW)

Test cases for:
- Modal open/close behavior
- Tab switching in comprehensive view
- Data loading and error states
- Export functionality

#### Step 3.3: Manual Testing Checklist

- [ ] Click on "Today" hours - verify modal opens with correct data
- [ ] Click on "This Week" hours - verify day-by-day breakdown
- [ ] Click on "This Month" hours - verify weekly breakdown
- [ ] Click on user name - verify comprehensive report loads
- [ ] Test export functionality - verify CSV download
- [ ] Test with different date ranges
- [ ] Test with users having no activity
- [ ] Test with users having many issues (pagination)
- [ ] Test permission restrictions (non-admin users)
- [ ] Test error handling and edge cases

---

## 5. Files to Create or Modify

### Files to CREATE:

1. **Backend Service Functions:**
   - No new files, add functions to existing `teamAnalyticsService.js`

2. **Frontend Components:**
   - `forge-app/static/main/src/components/modals/TeamMemberActivityModal.js`
   - `forge-app/static/main/src/components/modals/TeamMemberActivityModal.css`
   - `forge-app/static/main/src/components/modals/ExportTeamAnalyticsModal.js`
   - `forge-app/static/main/src/components/modals/ExportTeamAnalyticsModal.css`

3. **Tests:**
   - `forge-app/tests/services/teamAnalyticsDetailService.test.js`
   - `forge-app/static/main/src/components/modals/__tests__/TeamMemberActivityModal.test.js`

### Files to MODIFY:

1. **Backend:**
   - `forge-app/src/services/analytics/teamAnalyticsService.js`
     - Add `fetchMemberDayDetails()`
     - Add `fetchMemberWeekDetails()`
     - Add `fetchMemberMonthDetails()`
     - Add `generateTeamExportData()`
     - Add `fetchIssueDetailsBatch()` helper

   - `forge-app/src/services/analyticsService.js`
     - Export new functions

   - `forge-app/src/resolvers/analyticsResolvers.js`
     - Add `resolver.define('getMemberDayDetails', ...)`
     - Add `resolver.define('getMemberWeekDetails', ...)`
     - Add `resolver.define('getMemberMonthDetails', ...)`
     - Add `resolver.define('exportTeamAnalytics', ...)`

2. **Frontend:**
   - `forge-app/static/main/src/components/tabs/TeamAnalyticsTab.js`
     - Add modal state
     - Add click handlers
     - Add export button
     - Make time cells and member names clickable
     - Import and render modals

   - `forge-app/static/main/src/components/tabs/TeamAnalyticsTab.css`
     - Add clickable styles
     - Add export button styles

---

## 6. API Specifications

### 6.1 getMemberDayDetails

**Input:**
```javascript
{
  projectKey: string,  // e.g., "FEEDBACK"
  userId: string,      // UUID
  date: string         // "YYYY-MM-DD"
}
```

**Output:**
```javascript
{
  success: boolean,
  data: {
    userId: string,
    displayName: string,
    date: string,
    totalSeconds: number,
    totalHours: number,
    issueCount: number,
    issues: [
      {
        issueKey: string,
        projectKey: string,
        summary: string,
        status: string,
        statusCategory: string,
        priority: string,
        issueType: string,
        totalSeconds: number,
        sessionCount: number,
        sessions: [
          {
            startTime: string,
            endTime: string,
            seconds: number
          }
        ]
      }
    ]
  }
}
```

### 6.2 getMemberWeekDetails

**Input:**
```javascript
{
  projectKey: string,
  userId: string,
  weekStartDate: string  // Monday date "YYYY-MM-DD"
}
```

**Output:**
```javascript
{
  success: boolean,
  data: {
    userId: string,
    displayName: string,
    weekStart: string,
    weekEnd: string,
    totalSeconds: number,
    dailyBreakdown: [
      {
        date: string,
        dayOfWeek: string,
        totalSeconds: number,
        issues: [...]  // Same structure as day details
      }
    ]
  }
}
```

### 6.3 getMemberMonthDetails

**Input:**
```javascript
{
  projectKey: string,
  userId: string,
  month: string  // "YYYY-MM"
}
```

**Output:**
```javascript
{
  success: boolean,
  data: {
    userId: string,
    displayName: string,
    month: string,
    totalSeconds: number,
    weeklyBreakdown: [
      {
        weekStart: string,
        weekEnd: string,
        totalSeconds: number,
        dailyBreakdown: [...]  // Same as week details
      }
    ]
  }
}
```

### 6.4 exportTeamAnalytics

**Input:**
```javascript
{
  projectKey: string,
  startDate: string,  // "YYYY-MM-DD"
  endDate: string,    // "YYYY-MM-DD"
  format: string      // "csv" | "excel"
}
```

**Output:**
```javascript
{
  success: boolean,
  data: string,  // CSV/Excel data as string
  format: string,
  filename: string
}
```

---

## 7. Performance Considerations

### 7.1 Database Query Optimization
- Use indexed columns (`organization_id`, `user_id`, `work_date`, `user_assigned_issue_key`)
- Limit result sets appropriately
- Use batch Jira API calls for issue details (max 100 per request)

### 7.2 Frontend Optimization
- Lazy load modal content (only fetch when modal opens)
- Cache previously loaded data for same time periods
- Use loading states and skeleton screens
- Debounce export operations

### 7.3 Expected Performance
- Day details: < 1s load time
- Week details: < 2s load time
- Month details: < 3s load time
- Export: 3-5s for typical team size (5-10 members)

---

## 8. Future Enhancements

### 8.1 Phase 2 Features (Future)
- Real-time collaboration indicators
- Comparison view (compare week-to-week, month-to-month)
- Team productivity trends over time
- Issue velocity metrics
- Automated reports (scheduled email exports)

### 8.2 Advanced Analytics
- Burndown charts
- Velocity tracking
- Issue complexity analysis
- Time estimation accuracy
- Team capacity planning

---

## 9. Success Metrics

### 9.1 Functional Metrics
- All click interactions work correctly
- Modal loads data within performance targets
- Export generates valid CSV/Excel files
- No errors in console
- All tests pass

### 9.2 User Experience Metrics
- Admin can drill down into any time value
- Clear visual hierarchy in modals
- Intuitive navigation
- Fast response times
- Professional export format

---

## 10. Rollout Plan

### 10.1 Development
- Day 1-2: Backend implementation and testing
- Day 2-3: Frontend components and integration
- Day 3-4: Testing, refinement, and documentation

### 10.2 Deployment
- Deploy to staging environment
- Conduct UAT with product team
- Fix any identified issues
- Deploy to production
- Monitor for errors and performance

### 10.3 Documentation
- Update user guide with new features
- Create video tutorial/GIF demonstrations
- Update API documentation
- Add inline help tooltips

---

## 11. Risk Assessment

### 11.1 Technical Risks
- **Performance with large datasets:** Mitigate with pagination and query optimization
- **Jira API rate limits:** Implement caching and batch requests
- **Complex state management:** Use React best practices and proper effect cleanup

### 11.2 UX Risks
- **Information overload:** Use progressive disclosure and clear visual hierarchy
- **Confusing navigation:** Provide breadcrumbs and clear back buttons
- **Slow load times:** Show loading states and skeleton screens

---

## 12. Appendix

### 12.1 Design References
- Google Calendar time breakdown UI
- Atlassian design system components
- Existing modal patterns in the application

### 12.2 Related Documentation
- `docs/COMPREHENSIVE_FEATURE_DOCUMENTATION.md`
- `docs/AI_ANALYSIS_FLOW.md`
- `docs/ARCHITECTURE_VALIDATION.md`

---

**End of Implementation Plan**
