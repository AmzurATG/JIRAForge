# Web Productivity Portal — Requirements Document

**Version:** 1.0  
**Date:** 2026-05-21  
**Status:** DRAFT  
**Audience:** Development Team, Product Stakeholders

---

## 1. Executive Summary

The Web Productivity Portal is a standalone web application for non-Jira administrators to view employee productivity analytics based on captured desktop activity. It provides dashboards, detailed employee analytics, time logs, and exportable reports without requiring Jira accounts or any Jira integration. The portal uses a dedicated admin user model with role-based access control (RBAC).

---

## 2. Purpose & Goals

- **Primary Goal:** Enable HR/management teams to analyze employee productivity metrics without Jira access.
- **Secondary Goals:**
  - Provide actionable insights into productive vs. non-productive time allocation
  - Enable data-driven workforce planning and performance reviews
  - Support compliance and audit requirements via exportable reports
  - Maintain multi-tenant isolation and data security

---

## 3. Scope

### In Scope (v1)
- Dashboard with productivity KPIs
- Employee list with searchable/filterable view
- Employee detail pages with drill-down analytics
- Time logs table with full filtering and pagination
- Reports generation (CSV + PDF export)
- Portal admin user management (superadmin role only)
- Role-based endpoint access control (superadmin, admin, viewer)
- Multi-organization support via org_id scoping

### Out of Scope (v1)
- Department/team grouping (no schema support yet)
- Real-time updates or WebSocket support
- Jira issue mapping or worklog synchronization
- Mobile app or progressive web app (responsive web only)
- Third-party SSO (email/password auth only)
- Custom report builder (predefined report types only)

---

## 4. Functional Requirements

### 4.1 Authentication & Authorization

**FR-AUTH-1:** Portal Admin Login
- Portal admins log in via email and password (no Jira account required)
- Login POST to `/api/portal/auth/login` with email and password
- On success: session token issued and stored in localStorage
- On failure: 401 Unauthorized with clear error message
- Sessions expire after 24 hours of inactivity
- Password minimum 8 characters, no complexity rules (v1)

**FR-AUTH-2:** Session Management
- Session tokens stored in browser localStorage
- Token included in Authorization header for all API requests
- Expired/invalid tokens redirect user to login page
- Logout clears token and redirects to login

**FR-AUTH-3:** Role-Based Access Control
- Three roles: superadmin, admin, viewer
- **Superadmin:** Full portal access + user management
- **Admin:** View all data, export reports, cannot manage users
- **Viewer:** Read-only access (dashboard, employees, logs; no export)

---

### 4.2 Dashboard

**FR-DASH-1:** Productivity Summary KPIs
- Display four metric cards:
  1. Total productive hours (across all employees, date range)
  2. Total non-productive hours
  3. Overall productivity percentage
  4. Total employee count in org
- All metrics scoped by selected date range (default: last 30 days)
- Metrics update on date range change or org change

**FR-DASH-2:** Productivity Trend Chart
- Stacked bar chart: productive vs non-productive hours by day (last 30 days)
- Or donut chart showing percentage split (productive/non-productive/idle)
- Interactive legend; clicking toggles series visibility
- Tooltip on hover showing exact values

**FR-DASH-3:** Date Range Filter
- Dropdown/date picker: "Last 7 days", "Last 30 days", "Last 90 days", "Custom"
- Custom allows start/end date selection
- Filter persists across page navigation (in URL query params)

**FR-DASH-4:** Organization Selector
- Dropdown showing orgs the logged-in admin can access
- Default: first accessible org
- Changes dashboard data to selected org
- Only visible if admin has access to multiple orgs

---

### 4.3 Employees List

**FR-EMP-LIST-1:** Employee Table
- Columns: Name, Email, Productive Hours, Non-Productive Hours, Productivity %, Last Activity Timestamp
- Sortable by name, productivity %, last activity
- Default sort: Name ascending
- Pagination: 20 rows per page; show total count
- Click row to navigate to Employee Detail

**FR-EMP-LIST-2:** Search
- Search by employee name (substring match, case-insensitive)
- Search by email (substring match)
- Search resets pagination to page 1

**FR-EMP-LIST-3:** Filters
- Date range filter (same as dashboard)
- Productivity range filter: "All", "High (>80%)", "Medium (40-80%)", "Low (<40%)"
- Filters apply to aggregate metrics and list display

**FR-EMP-LIST-4:** Empty State
- Message if no employees or no data: "No employees found for this organization" / "No activity data available"

---

### 4.4 Employee Detail

**FR-EMP-DETAIL-1:** Summary Cards
- Display employee: name, email, department (TBD if schema supports)
- Four cards: productive hours, non-productive hours, idle hours (if available), productivity %
- Aggregate for date range

**FR-EMP-DETAIL-2:** Daily Productivity Trend Chart
- Line chart: productivity % by day (last 30 days, or custom range)
- Show both productive hours and total work hours on dual-axis if helpful
- Tooltip with exact values

**FR-EMP-DETAIL-3:** Productive Time Logs Tab
- Button/tab to show all "productive" activity records for employee, date range
- Paginated table (see FR-LOGS-1 below)

**FR-EMP-DETAIL-4:** Non-Productive Time Logs Tab
- Button/tab to show all "non-productive" activity records for employee, date range
- Same table structure as productive logs

**FR-EMP-DETAIL-5:** Activity Breakdown (Optional)
- Optional: show breakdown by application (top 5 apps by time)
- Example: "Chrome: 4h 30m (45%)", "Excel: 2h 15m (22%)", etc.

---

### 4.5 Time Logs

**FR-LOGS-1:** Time Logs Table
- Columns: Employee Name, Activity Title/Summary, Classification (Productive/Non-Productive), Start Time, End Time, Duration, Application, OCR Summary, Confidence Score
- Do NOT include Jira issue keys or project keys
- Sortable by any column
- Pagination: 20 rows per page
- Default sort: Start Time descending (most recent first)

**FR-LOGS-2:** Filters
- Date range (start/end date)
- Employee name (search/dropdown)
- Classification: "All", "Productive", "Non-Productive"
- Application: dropdown with list of apps from activity_records
- Minimum/maximum duration (in minutes)
- Confidence score range: 0-100% slider or dropdown
- Apply/Clear buttons

**FR-LOGS-3:** Column Visibility
- Optional: allow user to show/hide columns (e.g., hide OCR summary to reduce clutter)
- Save preference in localStorage

**FR-LOGS-4:** Export
- Button to export current filtered table as CSV (filename: `time_logs_YYYY-MM-DD.csv`)
- Role check: only admin/superadmin can export

---

### 4.6 Reports

**FR-REP-1:** Report Types
- **Employee Productivity Summary:** Employee name, total hours (productive/non-productive), productivity %
- **Daily Productivity Report:** By-day totals for all employees (or selected subset)
- **Detailed Time Logs Report:** Full table with all columns (equivalent to time logs export)
- **Team Productivity Report:** Aggregate across org, by department (TBD if schema supports v1)

**FR-REP-2:** Filter Panel
- Filters: date range, employee(s), productivity status (productive/non-productive/both), min/max duration, app type, confidence score
- "Preview" button to show filtered data sample (20 rows) in table
- No need to load all data before export

**FR-REP-3:** Export to CSV
- Button: "Download as CSV"
- Filename: `report_<type>_<org>_YYYY-MM-DD.csv`
- Include header row with column names
- Handle special characters (quotes, commas) properly

**FR-REP-4:** Export to PDF
- Button: "Download as PDF"
- Filename: `report_<type>_<org>_YYYY-MM-DD.pdf`
- Single-page landscape layout (if needed, multi-page table with headers on each page)
- Include: org name, report type, date range in header

**FR-REP-5:** Role Check
- Only admin/superadmin can generate/download reports
- Viewer role sees reports page but buttons disabled or hidden

---

### 4.7 Settings (Superadmin Only)

**FR-SETT-1:** Portal Admin User Management
- List all portal admins in org: name, email, role, last login, created date
- Sortable, paginated

**FR-SETT-2:** Add Portal Admin
- Form: email, display name, role (superadmin/admin/viewer), initial password
- Email uniqueness check per org
- Send password via email or display once (TBD)

**FR-SETT-3:** Edit Portal Admin
- Change: display name, role
- Cannot change email (unique constraint)

**FR-SETT-4:** Delete Portal Admin
- Confirm dialog before delete
- Superadmin cannot delete self (error message)

**FR-SETT-5:** Change Own Password
- Current admin can change their own password
- Require current password to verify
- New password must be ≥8 characters

**FR-SETT-6:** Audit Trail (Future)
- Out of scope v1; placeholder for future compliance tracking

---

## 5. Non-Functional Requirements

### 5.1 Performance
- **Dashboard load time:** <2 seconds (30-day aggregation)
- **Employee list load time:** <3 seconds (1000+ employees)
- **Search response:** <500ms
- **Export generation:** <5 seconds for CSV, <10 seconds for PDF (1000+ rows)

### 5.2 Scalability
- Support 10,000+ employees per org
- Support 100+ organizations
- Database indexes on: org_id, user_id, work_date, start_time, classification

### 5.3 Security
- All API routes require valid portal admin session
- All queries scoped by org_id (prevent cross-org data leakage)
- No sensitive data (OCR text, window titles, tokens) logged above info level
- Password hashing: bcrypt with salt (minimum 10 rounds)
- HTTPS only (enforced at infrastructure level)
- CORS: allow same-origin requests only (or explicitly list ai-server domain)

### 5.4 Reliability
- API error responses: 400/401/403/500 with descriptive message
- Graceful degradation: if one metric fails to load, show error but allow rest of dashboard to render
- Retry logic: client-side retry for transient 5xx errors (max 3 attempts)

### 5.5 Usability
- Responsive design (1920px desktop, 1366px tablet minimum)
- Dark/light theme toggle (localStorage preference)
- Loading spinners/skeletons for async data
- Empty states for no data scenarios
- Tooltips on hover for non-obvious UI elements

### 5.6 Accessibility
- WCAG 2.1 AA compliance (keyboard navigation, screen reader support, color contrast)
- Semantic HTML
- ARIA labels on charts and dynamic content

---

## 6. Data Models

### 6.1 Portal Admin Users (new table)

```
portal_admin_users
├── id: UUID (primary key)
├── org_id: UUID (foreign key → organizations)
├── email: VARCHAR (unique per org)
├── password_hash: VARCHAR (bcrypt)
├── display_name: VARCHAR
├── role: ENUM ('superadmin', 'admin', 'viewer')
├── created_at: TIMESTAMPTZ (default NOW())
├── updated_at: TIMESTAMPTZ (default NOW())
└── last_login_at: TIMESTAMPTZ (nullable)
```

### 6.2 Data Sources (existing tables)

**activity_records** (primary data source)
- Fields used: user_id, organization_id, window_title, application_name, classification, start_time, end_time, duration_seconds, ocr_text, ocr_confidence, work_date

**users**
- Fields used: id, display_name, email

**organizations**
- Fields used: id, org_name

**daily_time_summary, weekly_time_summary** (pre-aggregated views)
- Used for dashboard KPI cards (faster than aggregating activity_records on each request)

---

## 7. API Specifications

### 7.1 Authentication Endpoint

```
POST /api/portal/auth/login
Body: { email, password }
Response 200: { token, user: { id, email, display_name, role, org_id } }
Response 401: { error: "Invalid email or password" }
```

### 7.2 Dashboard Endpoint

```
GET /api/portal/dashboard?org_id=&from=&to=
Query: org_id (UUID), from (YYYY-MM-DD), to (YYYY-MM-DD)
Response 200: {
  summary: {
    total_productive_hours: number,
    total_non_productive_hours: number,
    productivity_percentage: number,
    employee_count: number
  },
  daily_trend: [
    { date, productive_hours, non_productive_hours },
    ...
  ]
}
```

### 7.3 Employees List Endpoint

```
GET /api/portal/employees?org_id=&search=&productivity_range=&from=&to=&page=&limit=
Query: org_id, search (name/email), productivity_range (all|high|medium|low), from, to, page (1-indexed), limit (20)
Response 200: {
  data: [
    { 
      user_id, 
      name, 
      email, 
      productive_hours, 
      non_productive_hours, 
      productivity_percentage,
      last_activity_at
    },
    ...
  ],
  pagination: { page, limit, total_count }
}
```

### 7.4 Employee Detail Endpoint

```
GET /api/portal/employees/:userId?org_id=
Response 200: {
  user: { user_id, name, email },
  summary: { 
    productive_hours, 
    non_productive_hours,
    idle_hours,
    productivity_percentage 
  },
  daily_trend: [
    { date, productivity_percentage, productive_hours, total_hours },
    ...
  ]
}
```

### 7.5 Employee Logs Endpoint

```
GET /api/portal/employees/:userId/logs?org_id=&classification=&from=&to=&page=&limit=
Query: org_id, classification (productive|non_productive|all), from, to, page, limit
Response 200: {
  data: [
    {
      record_id,
      activity_summary,
      classification,
      start_time,
      end_time,
      duration_seconds,
      application_name,
      window_title,
      ocr_text (optional),
      confidence_score
    },
    ...
  ],
  pagination: { page, limit, total_count }
}
```

### 7.6 Time Logs Endpoint

```
GET /api/portal/time-logs?org_id=&classification=&employee=&app=&duration_min=&duration_max=&confidence_min=&confidence_max=&from=&to=&page=&limit=
Response 200: {
  data: [
    {
      record_id,
      employee_name,
      activity_summary,
      classification,
      start_time,
      end_time,
      duration_seconds,
      application_name,
      confidence_score
    },
    ...
  ],
  pagination: { page, limit, total_count }
}
```

### 7.7 Reports Endpoints

```
GET /api/portal/reports/data?org_id=&type=&filters...&limit=20
Response 200: {
  report_type,
  data: [...],  // Preview data (first 20 rows)
  total_rows
}

GET /api/portal/reports/export/csv?org_id=&type=&filters...
Response: CSV file (Content-Type: text/csv)

GET /api/portal/reports/export/pdf?org_id=&type=&filters...
Response: PDF file (Content-Type: application/pdf)
```

### 7.8 Admin User Management Endpoints (Superadmin Only)

```
GET /api/portal/admin-users?org_id=&page=&limit=
Response 200: {
  data: [ { id, email, display_name, role, last_login_at, created_at }, ... ],
  pagination: { page, limit, total_count }
}

POST /api/portal/admin-users?org_id=
Body: { email, display_name, role }
Response 201: { id, email, display_name, role, created_at }
Response 400: { error: "Email already in use" }

PUT /api/portal/admin-users/:userId?org_id=
Body: { display_name, role }
Response 200: { id, email, display_name, role, updated_at }

DELETE /api/portal/admin-users/:userId?org_id=
Response 204

POST /api/portal/admin-users/:userId/change-password?org_id=
Body: { current_password, new_password }
Response 200: { success: true }
Response 401: { error: "Current password incorrect" }
```

---

## 8. UI/UX Requirements

### 8.1 Layout

- **Sidebar Navigation (left):**
  - Logo/app name
  - Menu items: Dashboard, Employees, Time Logs, Reports, Settings (superadmin only)
  - Current org name
  - User profile dropdown (change password, logout)

- **Top Header (right section):**
  - Org selector dropdown (if multi-org)
  - Dark/light theme toggle
  - User avatar/icon

- **Main Content Area:**
  - Page title
  - Breadcrumbs (Dashboard > Employees > Detail)
  - Filters panel (collapsible on mobile)
  - Data (cards, charts, tables)

### 8.2 Pages

1. **Login Page:** Email input, password input, login button, error message display
2. **Dashboard:** KPI cards, trend chart, date range filter
3. **Employees:** Search box, filters panel, employee table, pagination
4. **Employee Detail:** Summary cards, trend chart, log tabs
5. **Time Logs:** Filter panel, table, pagination, export button
6. **Reports:** Filter panel, report type selector, preview table, export buttons
7. **Settings:** Admin user management (superadmin only), password change section

### 8.3 Components

- **DataTable:** Sortable columns, pagination controls, empty state, loading skeleton
- **DateRangePicker:** Preset options + custom date range
- **FilterPanel:** Collapsible with save/clear buttons
- **KPICard:** Icon, label, value, optional trend indicator
- **LineChart, BarChart, DonutChart:** Using Recharts
- **LoadingSpinner:** Full-page or inline
- **ErrorBanner:** Dismissible error/warning messages
- **ConfirmDialog:** For delete actions

---

## 9. Security & Compliance

### 9.1 Authentication
- Email/password login (no SSO v1)
- Session tokens stored in browser (httpOnly cookies preferred, but localStorage acceptable if no sensitive data in token)
- Token includes: user_id, org_id, role, exp (expiration)

### 9.2 Authorization
- RBAC enforced on backend: every endpoint checks user role
- Frontend hides/disables UI for unauthorized actions (e.g., export button for viewers)

### 9.3 Data Protection
- All queries filtered by org_id (prevent cross-org data access)
- No sensitive fields (OCR text, window titles, passwords) exposed in API responses
- HTTPS only (enforced at load balancer)

### 9.4 Audit & Compliance
- Optional (v1): log all admin user changes (add/edit/delete portal admins, password resets)
- Future: GDPR export/delete endpoints for portal admins

---

## 10. Success Criteria

- [ ] Portal loads without errors
- [ ] Login works for multiple admin roles
- [ ] Dashboard displays correct KPI aggregates (verified against SQL query)
- [ ] Employee list searchable and filterable
- [ ] Employee detail drill-down shows correct time logs
- [ ] CSV export contains all rows and columns
- [ ] PDF export is readable and properly formatted
- [ ] Portal admin user management works (add/edit/delete)
- [ ] All API routes require valid session (no unauthorized access)
- [ ] All queries include org_id filter (verified in code review)
- [ ] No Jira fields (project_key, issue_key) exposed in responses
- [ ] Performance: dashboard loads in <2 seconds, export in <10 seconds
- [ ] Responsive: works on desktop and tablet (1366px+)

---

## 11. Constraints & Assumptions

### Constraints
- No department/team schema in v1 (skip department filters)
- No Jira integration (productivity portal only, no worklog sync)
- Single password-based authentication (no SSO)
- Stateless backend (session tokens in browser, not server)

### Assumptions
- `activity_records` table is already populated with employee activity data
- `daily_time_summary` views exist and are up-to-date
- Portal will be served from same domain as ai-server (no CORS complexity)
- Admins are trusted users (no advanced access controls needed)

---

## 12. Timeline & Dependencies

- **Depends on:** Supabase migrations (new portal_admin_users table), ai-server setup
- **Blocks:** None (standalone feature)
- **Estimated effort:** 4-6 weeks (backend + frontend)

---

## 13. Open Questions & Future Work

1. Should portal admins receive email notifications for new users added? (Future)
2. Should we audit-log all admin actions? (Future)
3. Support for department hierarchy? (Requires schema migration + plan update)
4. Dark mode toggle preference storage? (Future: add to portal_admin_users preferences JSONB)
5. Mobile app or PWA? (Out of scope v1)
