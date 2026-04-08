# Team Analytics Enhancement - UI/UX Specifications

**Date:** April 8, 2026  
**Feature:** Enhanced Team Analytics with Drill-Down & Export Capabilities  
**Purpose:** Visual specifications for modal interfaces and interactions

---

## 1. User Interaction Flows

### Flow 1: Today's Activity Drill-Down
```
User sees: Team Member Activity table
Member: Iswarya Kolimalla | Today: 1.4h | Week: 10h | Month: 12.5h
                                    ↓ [Click on "1.4h"]
Modal opens: Today's Activity Detail
┌──────────────────────────────────────────────────────────────┐
│ Today's Activity - Iswarya Kolimalla            [Close X]    │
│ Tuesday, April 8, 2026                                       │
├──────────────────────────────────────────────────────────────┤
│ Summary                                                      │
│ ┌────────┐ ┌────────┐                                       │
│ │  1.4h  │ │   3    │                                       │
│ │ Total  │ │ Issues │                                       │
│ └────────┘ └────────┘                                       │
├──────────────────────────────────────────────────────────────┤
│ Issue Breakdown                                              │
│                                                              │
│ FEEDBACK-41 - UI Enhancement                      45m (54%)  │
│ ████████████████████████░░░░░░░                             │
│ Status: In Progress | 2 sessions                            │
│                                                              │
│ FEEDBACK-45 - API Integration                     30m (36%)  │
│ ████████████████░░░░░░░░░░░░░                               │
│ Status: In Progress | 1 session                             │
│                                                              │
│ FEEDBACK-44 - Bug Fix                              9m (10%)  │
│ ████░░░░░░░░░░░░░░░░░░░░░░░░░                               │
│ Status: Done | 1 session                                    │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                          [Close]     [Export Report]         │
└──────────────────────────────────────────────────────────────┘
```

### Flow 2: This Week's Activity Drill-Down
```
User sees: Team Member Activity table
Member: Iswarya Kolimalla | Today: 1.4h | Week: 10h | Month: 12.5h
                                               ↓ [Click on "10h"]
Modal opens: This Week's Activity Detail
┌──────────────────────────────────────────────────────────────┐
│ This Week's Activity - Iswarya Kolimalla        [Close X]    │
│ Week of April 6 - April 12, 2026                            │
├──────────────────────────────────────────────────────────────┤
│ Summary: 10h total across 5 days                            │
├──────────────────────────────────────────────────────────────┤
│ Daily Breakdown                                              │
│                                                              │
│ ┌──────────────────────────────────────────────────────┐    │
│ │ Monday, April 6                            2.5h      │    │
│ │ • FEEDBACK-41 (1.5h) - UI Enhancement               │    │
│ │ • FEEDBACK-45 (1h) - API Integration                │    │
│ └──────────────────────────────────────────────────────┘    │
│                                                              │
│ ┌──────────────────────────────────────────────────────┐    │
│ │ Tuesday, April 7                           2.1h      │    │
│ │ • FEEDBACK-45 (1.5h) - API Integration              │    │
│ │ • FEEDBACK-44 (0.6h) - Bug Fix                      │    │
│ └──────────────────────────────────────────────────────┘    │
│                                                              │
│ ┌──────────────────────────────────────────────────────┐    │
│ │ Wednesday, April 8                         1.4h ★    │    │
│ │ • FEEDBACK-41 (0.75h) - UI Enhancement              │    │
│ │ • FEEDBACK-45 (0.5h) - API Integration              │    │
│ │ • FEEDBACK-44 (0.15h) - Bug Fix                     │    │
│ └──────────────────────────────────────────────────────┘    │
│                                                              │
│ [... Thu, Fri, Sat, Sun ...]                                │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                          [Close]     [Export Report]         │
└──────────────────────────────────────────────────────────────┘
```

### Flow 3: Comprehensive User Report
```
User sees: Team Member Activity table
Member: Iswarya Kolimalla | Today: 1.4h | Week: 10h | Month: 12.5h
          ↓ [Click on "Iswarya Kolimalla"]
Modal opens: Comprehensive User Activity Report
┌──────────────────────────────────────────────────────────────┐
│ User Activity Report - Iswarya Kolimalla        [Close X]    │
├──────────────────────────────────────────────────────────────┤
│ [Today] [This Week] [This Month]              [Export Report]│
├──────────────────────────────────────────────────────────────┤
│ Summary Statistics                                           │
│ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────┐        │
│ │  12.5h  │ │    5    │ │  1.4h   │ │   Monday    │        │
│ │  Month  │ │ Issues  │ │  Avg    │ │ Most Active │        │
│ └─────────┘ └─────────┘ └─────────┘ └─────────────┘        │
├──────────────────────────────────────────────────────────────┤
│ [Content based on selected tab - Today/Week/Month]          │
│                                                              │
│ [Same content as Flow 1, 2, or 3 above]                     │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                          [Close]     [Export Report]         │
└──────────────────────────────────────────────────────────────┘
```

### Flow 4: Export Team Analytics
```
User sees: Team Analytics Dashboard header
┌──────────────────────────────────────────────┐
│ Team Analytics Dashboard      [Export Report] │ ← Click here
└──────────────────────────────────────────────┘
                    ↓
Modal opens: Export Options
┌──────────────────────────────────────────────────────────────┐
│ Export Team Analytics                           [Close X]    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Date Range:                                                  │
│ ┌──────────────────────────┐                                │
│ │ This Month          ▼    │                                │
│ └──────────────────────────┘                                │
│ Options: This Week | This Month | Custom Range              │
│                                                              │
│ Format:                                                      │
│ ┌──────────────────────────┐                                │
│ │ CSV                 ▼    │                                │
│ └──────────────────────────┘                                │
│ Options: CSV | Excel                                         │
│                                                              │
│ Include:                                                     │
│ ☑ Team Summary                                              │
│ ☑ Member Breakdowns                                         │
│ ☑ Issue Details                                             │
│ ☑ Daily Activity                                            │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                          [Cancel]    [Export]                │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Component Specifications

### 2.1 Team Member Activity Modal - Today View

**Component:** `TodayActivityView`

**Layout Structure:**
```
Modal (600px width, auto height, max 80vh)
├── Header (60px)
│   ├── Title: "[Member Name]'s Activity"
│   ├── Subtitle: "[Day, Date]"
│   └── Close Button (×)
│
├── Summary Section (100px)
│   ├── Total Time Card
│   │   ├── Value: "[X]h"
│   │   └── Label: "Total Time"
│   └── Issues Count Card
│       ├── Value: "[N]"
│       └── Label: "Issues Worked"
│
├── Issue Breakdown Section (scrollable)
│   └── Issue Item (repeated)
│       ├── Issue Header Row
│       │   ├── Issue Key (FEEDBACK-41)
│       │   ├── Issue Summary (truncate at 50 chars)
│       │   ├── Time Spent (45m)
│       │   └── Percentage (54%)
│       ├── Progress Bar
│       │   └── Filled portion (width = percentage)
│       └── Issue Meta Row
│           ├── Status badge
│           └── Session count
│
└── Footer (60px)
    ├── Close Button
    └── Export Button
```

**Visual Specifications:**

| Element | Style |
|---------|-------|
| Modal Background | rgba(0, 0, 0, 0.5) |
| Modal Container | White background, border-radius: 8px, box-shadow: 0 4px 20px rgba(0,0,0,0.15) |
| Header Title | Font: 18px bold, color: #172B4D |
| Header Subtitle | Font: 14px regular, color: #5E6C84 |
| Summary Cards | Background: #F4F5F7, padding: 16px, border-radius: 4px |
| Card Value | Font: 24px bold, color: #0052CC |
| Card Label | Font: 12px regular, color: #5E6C84 |
| Issue Key | Font: 14px mono, color: #0052CC, clickable |
| Issue Summary | Font: 14px regular, color: #172B4D |
| Progress Bar | Height: 8px, border-radius: 4px |
| Progress Fill | Background: linear-gradient(90deg, #0052CC, #0065FF) |
| Status Badge | Padding: 2px 8px, border-radius: 3px, font: 11px |
| Buttons | Height: 36px, padding: 0 16px, border-radius: 3px |

**Color Scheme for Progress Bars:**
- Issue 1: `#0052CC` (Blue)
- Issue 2: `#00875A` (Green)
- Issue 3: `#6554C0` (Purple)
- Issue 4: `#FF991F` (Orange)
- Issue 5+: Cycle through above colors

### 2.2 Team Member Activity Modal - Week View

**Component:** `WeekActivityView`

**Layout Structure:**
```
Modal (700px width, max 80vh)
├── Header (60px)
│   ├── Title: "[Member Name]'s Activity"
│   ├── Subtitle: "Week of [Start] - [End]"
│   └── Close Button
│
├── Summary Bar (50px)
│   └── "10h total across 5 days"
│
├── Daily Breakdown (scrollable)
│   └── Day Card (repeated for each day)
│       ├── Day Header
│       │   ├── Date: "Monday, April 6"
│       │   └── Total: "2.5h"
│       └── Issue List
│           └── Issue Item (compact)
│               ├── Bullet point
│               ├── Issue Key (FEEDBACK-41)
│               ├── Time (1.5h)
│               └── Summary
│
└── Footer (60px)
    ├── Close Button
    └── Export Button
```

**Day Card Styling:**
- Current day: Border-left: 4px solid #0052CC, background: #F4F5F7
- Past days: Border-left: 4px solid #DFE1E6, background: white
- Future days: Border-left: 4px solid #F4F5F7, background: #FAFBFC
- No activity: Opacity: 0.6, italic text

**Visual Indicator for Today:**
- Star icon (★) next to date
- Highlighted background
- Bold date text

### 2.3 Team Member Activity Modal - Month View

**Component:** `MonthActivityView`

**Layout Structure:**
```
Modal (750px width, max 85vh)
├── Header (60px)
│
├── Summary Cards (120px)
│   ├── Total Hours
│   ├── Active Days
│   ├── Issues Worked
│   └── Most Active Day
│
├── Weekly Breakdown (scrollable)
│   └── Week Section (repeated)
│       ├── Week Header
│       │   ├── Week range: "Week 1 (Apr 1-5)"
│       │   ├── Total hours: "2h"
│       │   └── Expand/Collapse icon
│       └── Week Details (collapsible)
│           ├── Statistics
│           │   ├── "3 issues worked"
│           │   └── "Most active: Wednesday (1.2h)"
│           └── Daily Breakdown (expandable)
│               └── Day entries...
│
└── Footer
```

**Week Section Styling:**
- Current week: Bold, border-left: 4px solid #0052CC
- Past weeks: Regular weight
- Expandable sections with smooth animation
- Activity heatmap visualization (optional)

### 2.4 Export Modal

**Component:** `ExportTeamAnalyticsModal`

**Layout Structure:**
```
Modal (500px width, auto height)
├── Header (60px)
│   ├── Title: "Export Team Analytics"
│   └── Close Button
│
├── Options Section (280px)
│   ├── Date Range Selector
│   │   ├── Label: "Date Range"
│   │   └── Dropdown: [This Week|This Month|Custom]
│   ├── Custom Date Inputs (conditional)
│   │   ├── Start Date Picker
│   │   └── End Date Picker
│   ├── Format Selector
│   │   ├── Label: "Format"
│   │   └── Dropdown: [CSV|Excel]
│   └── Include Options (checkboxes)
│       ├── ☑ Team Summary
│       ├── ☑ Member Breakdowns
│       ├── ☑ Issue Details
│       └── ☑ Daily Activity
│
├── Preview Section (optional, 100px)
│   └── "Exporting data for 2 members, 11 issues"
│
└── Footer (60px)
    ├── Cancel Button
    └── Export Button (primary)
```

**Form Styling:**
- Labels: Font 12px, color: #5E6C84, margin-bottom: 4px
- Dropdowns: Height 36px, border: 1px solid #DFE1E6, border-radius: 3px
- Checkboxes: Atlassian checkbox style
- Buttons: Standard Atlassian button styles

---

## 3. Visual Design Specifications

### 3.1 Typography

| Element | Font | Size | Weight | Color |
|---------|------|------|--------|-------|
| Modal Title | Inter | 18px | 600 | #172B4D |
| Modal Subtitle | Inter | 14px | 400 | #5E6C84 |
| Section Heading | Inter | 16px | 600 | #172B4D |
| Body Text | Inter | 14px | 400 | #172B4D |
| Meta Text | Inter | 12px | 400 | #5E6C84 |
| Issue Key | Roboto Mono | 13px | 500 | #0052CC |
| Time Value | Inter | 14px | 600 | #172B4D |
| Card Value | Inter | 24px | 600 | #0052CC |
| Card Label | Inter | 12px | 400 | #5E6C84 |

### 3.2 Color Palette

**Primary Colors:**
- Primary Blue: `#0052CC`
- Success Green: `#00875A`
- Warning Orange: `#FF991F`
- Error Red: `#DE350B`
- Purple: `#6554C0`

**Neutral Colors:**
- Text Primary: `#172B4D`
- Text Secondary: `#5E6C84`
- Text Tertiary: `#97A0AF`
- Border: `#DFE1E6`
- Background: `#FFFFFF`
- Background Secondary: `#F4F5F7`
- Background Tertiary: `#FAFBFC`

**Status Colors:**
- In Progress: `#0052CC` (Blue)
- Done: `#00875A` (Green)
- To Do: `#5E6C84` (Gray)
- Blocked: `#DE350B` (Red)

### 3.3 Spacing System

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Icon padding, tiny gaps |
| sm | 8px | Button padding, small gaps |
| md | 12px | Section spacing |
| lg | 16px | Card padding, section gaps |
| xl | 24px | Modal padding |
| 2xl | 32px | Large section spacing |

### 3.4 Border Radius

| Element | Radius |
|---------|--------|
| Modal Container | 8px |
| Cards | 4px |
| Buttons | 3px |
| Badges | 3px |
| Progress Bars | 4px |
| Form Inputs | 3px |

### 3.5 Shadows

| Element | Shadow |
|---------|--------|
| Modal | `0 4px 20px rgba(0, 0, 0, 0.15)` |
| Hover Cards | `0 2px 8px rgba(0, 0, 0, 0.1)` |
| Buttons | `0 1px 2px rgba(0, 0, 0, 0.05)` |

---

## 4. Interaction States

### 4.1 Clickable Elements

**Team Member Table - Before Enhancement:**
```
Member Name          Today   This Week   This Month
Iswarya Kolimalla    1.4h    10h         12.5h
```

**Team Member Table - After Enhancement:**
```
Member Name          Today   This Week   This Month
[Iswarya Kolimalla]  [1.4h]  [10h]       [12.5h]
 ↑ Clickable         ↑↑↑ All clickable ↑↑↑
```

**Hover States:**

| Element | Normal | Hover | Active |
|---------|--------|-------|--------|
| Time Cell | Background: transparent | Background: #F4F5F7, Scale: 1.05 | Background: #DFE1E6 |
| Member Name | Color: #172B4D | Color: #0052CC, Underline | Color: #0747A6 |
| Issue Key | Color: #0052CC | Underline | Color: #0747A6 |
| Export Button | Background: #0052CC | Background: #0065FF | Background: #0747A6 |

### 4.2 Loading States

**Modal Loading:**
```
┌──────────────────────────────────────────────┐
│                                              │
│           ⟳ Loading icon (spinning)         │
│                                              │
│        Loading activity data...             │
│                                              │
└──────────────────────────────────────────────┘
```

**Loading Skeleton (alternative):**
- Show gray placeholder bars for issue items
- Animated shimmer effect
- Maintain layout to prevent content shift

### 4.3 Empty States

**No Activity Today:**
```
┌──────────────────────────────────────────────┐
│ Today's Activity - John Doe                  │
├──────────────────────────────────────────────┤
│                                              │
│           📅 Calendar icon                   │
│                                              │
│        No activity recorded today            │
│                                              │
│   Work on an issue to see it here           │
│                                              │
└──────────────────────────────────────────────┘
```

### 4.4 Error States

**Failed to Load:**
```
┌──────────────────────────────────────────────┐
│ Today's Activity - John Doe                  │
├──────────────────────────────────────────────┤
│                                              │
│           ⚠️ Warning icon                    │
│                                              │
│     Failed to load activity data             │
│                                              │
│     Error: [error message]                   │
│                                              │
│           [Retry Button]                     │
│                                              │
└──────────────────────────────────────────────┘
```

---

## 5. Animation Specifications

### 5.1 Modal Animations

**Modal Open:**
- Duration: 200ms
- Easing: cubic-bezier(0.4, 0.0, 0.2, 1)
- Transform: scale(0.95) → scale(1)
- Opacity: 0 → 1

**Modal Close:**
- Duration: 150ms
- Easing: cubic-bezier(0.4, 0.0, 1, 1)
- Transform: scale(1) → scale(0.95)
- Opacity: 1 → 0

**Backdrop:**
- Fade in/out: 200ms
- Opacity: 0 → 0.5 (on open)

### 5.2 Content Animations

**Tab Switch:**
- Duration: 150ms
- Easing: ease-in-out
- Fade out old content, fade in new content
- No slide animation (too distracting)

**Expand/Collapse:**
- Duration: 250ms
- Easing: ease-in-out
- Height transition with overflow: hidden
- Rotate icon: 0deg → 180deg

**Progress Bar Fill:**
- Duration: 400ms
- Easing: cubic-bezier(0.4, 0.0, 0.2, 1)
- Width: 0% → final%
- Stagger delay: 50ms per bar

### 5.3 Hover Transitions

**All Clickable Elements:**
- Duration: 150ms
- Easing: ease-in-out
- Properties: color, background-color, transform, box-shadow

---

## 6. Responsive Behavior

### 6.1 Modal Sizing

| Viewport Width | Modal Width | Modal Padding |
|----------------|-------------|---------------|
| < 768px (Mobile) | 95vw | 16px |
| 768px - 1024px (Tablet) | 600px | 24px |
| > 1024px (Desktop) | 700px | 32px |

### 6.2 Mobile Adaptations

**Stack Layout:**
- Summary cards stack vertically
- Issue items use full width
- Reduce font sizes by 1-2px
- Increase touch target sizes to 44px min

**Bottom Sheet Pattern (Mobile):**
- Modal slides up from bottom instead of center
- Swipe down to close
- Full-width on mobile with rounded top corners

---

## 7. Accessibility Specifications

### 7.1 ARIA Attributes

| Element | ARIA Role | ARIA Labels |
|---------|-----------|-------------|
| Modal | dialog | aria-modal="true" |
| Modal Header | heading | aria-level="2" |
| Close Button | button | aria-label="Close modal" |
| Tab Buttons | tab | aria-selected="true/false" |
| Tab Panels | tabpanel | aria-labelledby="[tab-id]" |
| Progress Bars | progressbar | aria-valuenow, aria-valuemin, aria-valuemax |

### 7.2 Keyboard Navigation

| Key | Action |
|-----|--------|
| Escape | Close modal |
| Tab | Focus next interactive element |
| Shift+Tab | Focus previous interactive element |
| Enter/Space | Activate button/link |
| Arrow Left/Right | Switch tabs (in comprehensive view) |

### 7.3 Focus Management

**On Modal Open:**
1. Trap focus within modal
2. Set focus to close button or first focusable element
3. Prevent body scrolling
4. Add `inert` attribute to background content

**On Modal Close:**
1. Return focus to trigger element (the clicked cell/name)
2. Remove focus trap
3. Re-enable body scrolling
4. Remove `inert` attribute from background

### 7.4 Screen Reader Support

**Announcements:**
- Modal opening: "Dialog opened: [User]'s Activity"
- Tab changes: "Showing [tab name] activity"
- Data loading: "Loading activity data"
- Data loaded: "[N] issues loaded"
- Errors: "Error: [message]"

---

## 8. Export File Format Specifications

### 8.1 CSV Format

**Filename:** `team-analytics-[PROJECT]-[DATE].csv`

**Structure:**
```csv
Team Analytics Export - FEEDBACK Project
Generated: April 8, 2026 3:45 PM

TEAM SUMMARY
Metric,Value
Active Members,2
Total Hours (Month),23.1h
Issues Worked,11
Average Hours/Member,11.5h

MEMBER BREAKDOWN
Member Name,User ID,Today,This Week,This Month,Percentage of Total
Iswarya Kolimalla,[uuid],1.4h,10h,12.5h,54%
Vishnu Sai Kanthamraju,[uuid],2.7h,5.9h,10.6h,46%

DETAILED ISSUE BREAKDOWN - Iswarya Kolimalla
Date,Issue Key,Issue Summary,Time Spent,Status,Priority,Issue Type
2026-04-08,FEEDBACK-41,UI Enhancement,0.75h,In Progress,High,Story
2026-04-08,FEEDBACK-45,API Integration,0.5h,In Progress,Medium,Task
2026-04-08,FEEDBACK-44,Bug Fix,0.15h,Done,High,Bug

DETAILED ISSUE BREAKDOWN - Vishnu Sai Kanthamraju
Date,Issue Key,Issue Summary,Time Spent,Status,Priority,Issue Type
[... similar structure ...]
```

### 8.2 Excel Format (XLSX)

**Sheets:**
1. **Team Summary** - KPI cards
2. **Member Breakdown** - Table with all members
3. **Detailed Activities** - One sheet per member with issues
4. **Daily Timeline** - Day-by-day breakdown for all members

**Formatting:**
- Header row: Bold, background color
- Metric columns: Number format with 1 decimal
- Date columns: Date format
- Conditional formatting on hours (color scale)

---

## 9. Performance Targets

### 9.1 Load Times

| Action | Target | Maximum |
|--------|--------|---------|
| Modal Open (UI only) | < 100ms | < 200ms |
| Data Fetch - Day | < 500ms | < 1s |
| Data Fetch - Week | < 800ms | < 1.5s |
| Data Fetch - Month | < 1.2s | < 2s |
| Export Generation | < 2s | < 5s |

### 9.2 Rendering Targets

| Metric | Target |
|--------|--------|
| First Contentful Paint | < 200ms |
| Time to Interactive | < 500ms |
| Smooth Animations | 60fps |
| Modal Rendering | < 16ms per frame |

---

## 10. Edge Cases & Special Scenarios

### 10.1 Data Edge Cases

**No Activity:**
- Show empty state with helpful message
- Provide navigation back to overview

**Single Issue:**
- Progress bar shows 100%
- Display "Only 1 issue worked" message

**Many Issues (>10):**
- Show top 10 by time
- Add "Show all issues" expandable section
- Paginate if >50 issues

**Very Long Issue Summary:**
- Truncate at 60 characters
- Add tooltip on hover with full text
- Ensure ellipsis (...)

### 10.2 Time Edge Cases

**Zero Hours:**
- Display "0h" or "No activity"
- Dim the row/cell
- Make non-clickable

**Partial Minutes:**
- Round to nearest minute
- Show seconds only in detailed view
- Format: "0.25h" or "15m"

**Cross-Midnight Work:**
- Attribute to start date
- Add footnote if crossing midnight

---

**End of UI/UX Specifications**
