# Team Analytics Enhancement - Files Checklist

**Date:** April 8, 2026  
**Feature:** Enhanced Team Analytics with Drill-Down & Export Capabilities

This document provides a quick reference list of all files that need to be created or modified for the Team Analytics Enhancement feature.

---

## Files to CREATE (New Files)

### Frontend Components - Modals

#### 1. TeamMemberActivityModal.js
**Path:** `forge-app/static/main/src/components/modals/TeamMemberActivityModal.js`  
**Purpose:** Main modal component that displays detailed activity breakdown for a team member  
**Key Functions:**
- `TeamMemberActivityModal()` - Main modal component with tab management
- `TodayActivityView()` - Today's activity view with issue breakdown
- `WeekActivityView()` - Week's activity view with daily breakdown
- `MonthActivityView()` - Month's activity view with weekly breakdown
- `loadActivityData()` - Fetch data based on active tab
- `getWeekStartDate()` - Calculate Monday of current week

**Dependencies:**
- `@forge/bridge` - invoke
- `../../utils` - formatTime
- React hooks (useState, useEffect)

#### 2. TeamMemberActivityModal.css
**Path:** `forge-app/static/main/src/components/modals/TeamMemberActivityModal.css`  
**Purpose:** Styles for the team member activity modal  
**Key Classes:**
- `.modal-overlay` - Backdrop overlay
- `.team-member-modal` - Modal container
- `.modal-header`, `.modal-content`, `.modal-footer` - Modal sections
- `.modal-tabs`, `.tab-btn` - Tab navigation
- `.today-activity-view`, `.week-activity-view`, `.month-activity-view` - View containers
- `.issue-item`, `.issue-progress`, `.progress-bar` - Issue display
- `.summary-section`, `.summary-stats` - Summary statistics

#### 3. ExportTeamAnalyticsModal.js
**Path:** `forge-app/static/main/src/components/modals/ExportTeamAnalyticsModal.js`  
**Purpose:** Modal for exporting team analytics data  
**Key Functions:**
- `ExportTeamAnalyticsModal()` - Main export modal component
- `handleExport()` - Execute export with selected options
- `downloadFile()` - Trigger file download in browser

**Dependencies:**
- `@forge/bridge` - invoke
- React hooks (useState)

#### 4. ExportTeamAnalyticsModal.css
**Path:** `forge-app/static/main/src/components/modals/ExportTeamAnalyticsModal.css`  
**Purpose:** Styles for the export modal  
**Key Classes:**
- `.export-modal` - Modal container
- `.export-options` - Options container
- `.option-group` - Individual option group
- `.custom-date-range` - Custom date selector
- `.date-input` - Date input field

### Frontend Tests

#### 5. TeamMemberActivityModal.test.js
**Path:** `forge-app/static/main/src/components/modals/__tests__/TeamMemberActivityModal.test.js`  
**Purpose:** Unit tests for team member activity modal  
**Test Cases:**
- Modal open/close behavior
- Tab switching functionality
- Data loading states
- Error handling
- API call verification

#### 6. teamAnalyticsDetailService.test.js
**Path:** `forge-app/tests/services/teamAnalyticsDetailService.test.js`  
**Purpose:** Unit tests for backend service functions  
**Test Cases:**
- `fetchMemberDayDetails()` - various date scenarios
- `fetchMemberWeekDetails()` - week boundary cases
- `fetchMemberMonthDetails()` - month transitions
- `generateTeamExportData()` - data formatting
- `fetchIssueDetailsBatch()` - batch API calls

---

## Files to MODIFY (Existing Files)

### Backend - Service Layer

#### 1. teamAnalyticsService.js
**Path:** `forge-app/src/services/analytics/teamAnalyticsService.js`  
**Functions to ADD:**
- `fetchMemberDayDetails(accountId, cloudId, projectKey, userId, date)`
  - Query activity_records for specific user and date
  - Group by issue_key
  - Calculate time per issue
  - Fetch issue details from Jira
  - Return formatted breakdown with issue metadata

- `fetchMemberWeekDetails(accountId, cloudId, projectKey, userId, weekStartDate)`
  - Query activity_records for user for week range (Monday-Sunday)
  - Group by work_date and issue_key
  - Calculate daily totals and per-issue times
  - Return day-by-day breakdown with issues

- `fetchMemberMonthDetails(accountId, cloudId, projectKey, userId, month)`
  - Query activity_records for user for entire month
  - Group by week and day
  - Calculate weekly aggregations and daily breakdowns
  - Return week-by-week structure with drill-down data

- `generateTeamExportData(accountId, cloudId, projectKey, startDate, endDate)`
  - Fetch all team analytics data for date range
  - Fetch detailed breakdowns for each member
  - Format into exportable CSV/Excel structure
  - Include team summary, member breakdowns, and issue details

- `fetchIssueDetailsBatch(issueKeys)`
  - Helper function to fetch issue details from Jira API
  - Batch requests in groups of 100
  - Return map of issueKey -> issue details (summary, status, priority, etc.)

**Modifications Required:**
- Import additional Jira API functions
- Add helper functions for date calculations
- Implement CSV/Excel formatting logic

#### 2. analyticsService.js
**Path:** `forge-app/src/services/analyticsService.js`  
**Changes:**
- Add exports for new functions from teamAnalyticsService.js:
  ```javascript
  export {
    // ... existing exports
    fetchMemberDayDetails,
    fetchMemberWeekDetails,
    fetchMemberMonthDetails,
    generateTeamExportData
  } from './analytics/teamAnalyticsService.js';
  ```

### Backend - Resolvers

#### 3. analyticsResolvers.js
**Path:** `forge-app/src/resolvers/analyticsResolvers.js`  
**Resolvers to ADD:**

1. **getMemberDayDetails**
   ```javascript
   resolver.define('getMemberDayDetails', async (req) => {
     // Extract projectKey, userId, date from payload
     // Verify admin/project admin permissions
     // Call fetchMemberDayDetails()
     // Return formatted response
   });
   ```

2. **getMemberWeekDetails**
   ```javascript
   resolver.define('getMemberWeekDetails', async (req) => {
     // Extract projectKey, userId, weekStartDate from payload
     // Verify permissions
     // Call fetchMemberWeekDetails()
     // Return formatted response
   });
   ```

3. **getMemberMonthDetails**
   ```javascript
   resolver.define('getMemberMonthDetails', async (req) => {
     // Extract projectKey, userId, month from payload
     // Verify permissions
     // Call fetchMemberMonthDetails()
     // Return formatted response
   });
   ```

4. **exportTeamAnalytics**
   ```javascript
   resolver.define('exportTeamAnalytics', async (req) => {
     // Extract projectKey, startDate, endDate, format from payload
     // Verify permissions
     // Call generateTeamExportData()
     // Return CSV/Excel data
   });
   ```

**Import Required:**
- Add imports for new service functions at top of file

### Frontend - Components

#### 4. TeamAnalyticsTab.js
**Path:** `forge-app/static/main/src/components/tabs/TeamAnalyticsTab.js`  
**Changes:**

**Imports to ADD (around line 1-5):**
```javascript
import TeamMemberActivityModal from '../modals/TeamMemberActivityModal';
import ExportTeamAnalyticsModal from '../modals/ExportTeamAnalyticsModal';
```

**State to ADD (around line 15):**
```javascript
const [activityModalOpen, setActivityModalOpen] = useState(false);
const [selectedMember, setSelectedMember] = useState(null);
const [activityViewType, setActivityViewType] = useState('today');
const [exportModalOpen, setExportModalOpen] = useState(false);
```

**Handler Functions to ADD (around line 130):**
```javascript
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
```

**Table Modifications (around lines 365-390):**
- **Line ~380: Make member name clickable**
  ```javascript
  <span 
    className="member-name clickable" 
    onClick={() => handleMemberNameClick(member)}
  >
    {member.displayName}
  </span>
  ```

- **Line ~387: Make "Today" hours clickable**
  ```javascript
  <td className="hours-cell clickable" onClick={() => handleTodayClick(member)}>
    <strong>{member.todayHours}h</strong>
  </td>
  ```

- **Line ~388: Make "This Week" hours clickable**
  ```javascript
  <td className="hours-cell clickable" onClick={() => handleWeekClick(member)}>
    <strong>{member.weekHours}h</strong>
  </td>
  ```

- **Line ~389: Make "This Month" hours clickable**
  ```javascript
  <td className="hours-cell clickable" onClick={() => handleMonthClick(member)}>
    <strong>{member.monthHours}h</strong>
  </td>
  ```

**Export Button to ADD (around line 140, in header section):**
```javascript
<button className="export-btn" onClick={handleExportClick}>
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M7 10L12 15L17 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
  Export Report
</button>
```

**Modal Components to ADD (at end of return statement, before closing div):**
```javascript
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

#### 5. TeamAnalyticsTab.css
**Path:** `forge-app/static/main/src/components/tabs/TeamAnalyticsTab.css`  
**Styles to ADD (at end of file):**

```css
/* Clickable elements */
.hours-cell.clickable,
.member-name.clickable {
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
}

.hours-cell.clickable:hover {
  background-color: var(--ds-background-neutral-hovered);
  transform: scale(1.05);
}

.member-name.clickable:hover {
  color: var(--ds-link);
  text-decoration: underline;
}

/* Export button */
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

.export-btn svg {
  flex-shrink: 0;
}

/* Add to header section for export button positioning */
.team-analytics-header {
  /* Existing styles */
  justify-content: space-between;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
```

---

## Summary of Changes

### Backend Changes
- **1 file modified:** `teamAnalyticsService.js` - Add 4 new service functions + 1 helper
- **1 file modified:** `analyticsService.js` - Update exports
- **1 file modified:** `analyticsResolvers.js` - Add 4 new resolvers
- **1 file created:** `teamAnalyticsDetailService.test.js` - Backend tests

### Frontend Changes
- **2 files created:** TeamMemberActivityModal component + styles
- **2 files created:** ExportTeamAnalyticsModal component + styles
- **1 file modified:** `TeamAnalyticsTab.js` - Add handlers and modal integration
- **1 file modified:** `TeamAnalyticsTab.css` - Add clickable and export button styles
- **1 file created:** `TeamMemberActivityModal.test.js` - Frontend tests

### Total File Count
- **Files to CREATE:** 6
- **Files to MODIFY:** 5
- **Total:** 11 files

---

## Implementation Order

### Day 1: Backend Foundation
1. Modify `teamAnalyticsService.js` - Add all 5 functions
2. Modify `analyticsService.js` - Update exports
3. Modify `analyticsResolvers.js` - Add all 4 resolvers
4. Create `teamAnalyticsDetailService.test.js` - Add tests
5. Test backend functionality with Postman/curl

### Day 2: Frontend Modals
1. Create `TeamMemberActivityModal.js` - Implement all views
2. Create `TeamMemberActivityModal.css` - Style modal
3. Create `ExportTeamAnalyticsModal.js` - Implement export UI
4. Create `ExportTeamAnalyticsModal.css` - Style export modal
5. Create `TeamMemberActivityModal.test.js` - Add tests

### Day 3: Integration & Testing
1. Modify `TeamAnalyticsTab.js` - Integrate modals
2. Modify `TeamAnalyticsTab.css` - Add interactive styles
3. Test all click interactions
4. Test modal data loading
5. Test export functionality
6. Fix bugs and refine UX

### Day 4: Polish & Documentation
1. Performance optimization
2. Error handling refinement
3. Accessibility improvements
4. Update user documentation
5. Create demo videos/GIFs
6. Final testing and deployment

---

## Key Functions by File

### teamAnalyticsService.js
| Function | Purpose | Lines (est.) |
|----------|---------|--------------|
| `fetchMemberDayDetails` | Get day activity with issue breakdown | ~80 |
| `fetchMemberWeekDetails` | Get week activity with daily breakdown | ~120 |
| `fetchMemberMonthDetails` | Get month activity with weekly breakdown | ~150 |
| `generateTeamExportData` | Generate exportable team data | ~100 |
| `fetchIssueDetailsBatch` | Batch fetch issue details from Jira | ~60 |

### TeamAnalyticsTab.js
| Function | Purpose | Lines (est.) |
|----------|---------|--------------|
| `handleTodayClick` | Open modal for today view | ~5 |
| `handleWeekClick` | Open modal for week view | ~5 |
| `handleMonthClick` | Open modal for month view | ~5 |
| `handleMemberNameClick` | Open comprehensive report | ~5 |
| `handleExportClick` | Open export modal | ~3 |

### TeamMemberActivityModal.js
| Function | Purpose | Lines (est.) |
|----------|---------|--------------|
| `TeamMemberActivityModal` | Main modal component | ~80 |
| `loadActivityData` | Fetch data based on tab | ~40 |
| `TodayActivityView` | Render today's view | ~60 |
| `WeekActivityView` | Render week's view | ~80 |
| `MonthActivityView` | Render month's view | ~100 |
| `getWeekStartDate` | Calculate week start | ~8 |

---

## Testing Checklist

### Backend Tests
- [ ] `fetchMemberDayDetails` returns correct issue breakdown
- [ ] `fetchMemberWeekDetails` calculates week correctly
- [ ] `fetchMemberMonthDetails` handles month transitions
- [ ] `generateTeamExportData` formats CSV correctly
- [ ] `fetchIssueDetailsBatch` handles 100+ issues
- [ ] All resolvers verify permissions
- [ ] Error handling works for invalid inputs

### Frontend Tests
- [ ] Modals open/close correctly
- [ ] Tab switching works in comprehensive view
- [ ] Data loads correctly for all views
- [ ] Loading states display properly
- [ ] Error states display properly
- [ ] Export generates valid file
- [ ] Click handlers trigger correct actions
- [ ] Clickable elements have proper hover states

### Integration Tests
- [ ] End-to-end: Click → Load → Display → Close
- [ ] Export: Click → Select options → Download
- [ ] Multiple users can be viewed sequentially
- [ ] Data refreshes when switching projects
- [ ] No memory leaks after multiple modal opens

---

**End of Checklist**
