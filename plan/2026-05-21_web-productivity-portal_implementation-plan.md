# Web Productivity Portal — Fast-Track Implementation Plan

**Document Type:** Copilot Planning File  
**Created:** 2026-05-21  
**Target:** Rapid MVP Completion via Copilot-Driven Development  
**Status:** READY FOR EXECUTION

---

## 1. Requirement Summary

### Project Overview
Standalone web portal for HR/management to view employee productivity analytics. No Jira integration required — uses existing `activity_records` data from desktop app captures.

### Core Modules
| Module | Priority | Complexity |
|--------|----------|------------|
| Portal Authentication | P0 | Medium |
| Dashboard (KPIs + Charts) | P0 | Medium |
| Employees List | P0 | Simple |
| Employee Detail | P1 | Medium |
| Time Logs Table | P1 | Medium |
| Reports (CSV/PDF Export) | P2 | Medium |
| Admin User Management | P2 | Simple |

### Key Workflows
1. **Login Flow:** Email/password → JWT token → localStorage → API calls
2. **Dashboard Flow:** Load KPIs → Render charts → Date range filter updates
3. **Drill-down Flow:** Employee list → Click row → Detail page → Time logs
4. **Export Flow:** Apply filters → Preview → Download CSV/PDF

### Major Dependencies
- **Existing:** `activity_records` table, `aggregation-service.js`, Supabase client
- **New Required:** `portal_admin_users` table, bcrypt for passwords, PDF generation library

---

## 2. Recommended Architecture & Deployment Strategy

### Decision: Integrate into Existing AI Server ✅

**Justification:**
| Factor | Integrate (ai-server) | Separate Service |
|--------|----------------------|------------------|
| Setup time | 0 days (existing) | 2-3 days |
| Supabase client | Reuse existing | Duplicate setup |
| Logging/monitoring | Reuse Winston | New setup |
| Deployment | Single deploy | Two deployments |
| Aggregation logic | Reuse existing | Copy/duplicate |
| Auth patterns | Follow existing | Create new |

**Winner:** Integration saves 3-5 days and reduces maintenance overhead.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        AI Server (Express)                       │
├─────────────────────────────────────────────────────────────────┤
│  Existing Routes              │  NEW: Portal Routes              │
│  /api/activity/*              │  /api/portal/auth/*             │
│  /api/forge/*                 │  /api/portal/dashboard          │
│  /api/analytics/*             │  /api/portal/employees/*        │
│  /admin-dashboard/*           │  /api/portal/time-logs          │
│                               │  /api/portal/reports/*          │
│                               │  /api/portal/admin-users/*      │
├─────────────────────────────────────────────────────────────────┤
│  Middleware Layer                                                │
│  ├── auth.js (API key)                                          │
│  ├── forge-auth.js (FIT)                                        │
│  ├── dashboard-auth.js (Atlassian OAuth)                        │
│  └── portal-auth.js (NEW: JWT session)                          │
├─────────────────────────────────────────────────────────────────┤
│  Services Layer                                                  │
│  ├── db/aggregation-service.js (REUSE)                          │
│  ├── db/activity-db-service.js (REUSE)                          │
│  ├── db/portal-db-service.js (NEW)                              │
│  └── portal-service.js (NEW: business logic)                    │
├─────────────────────────────────────────────────────────────────┤
│                         Supabase                                 │
│  ├── activity_records (existing)                                │
│  ├── users (existing)                                           │
│  ├── organizations (existing)                                   │
│  └── portal_admin_users (NEW)                                   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    Portal Frontend (React)                       │
│  Served from: ai-server/src/portal/ (static build)              │
│  OR separate Vercel/Netlify deployment                          │
└─────────────────────────────────────────────────────────────────┘
```

### API Communication Flow
```
Browser → POST /api/portal/auth/login → JWT token
Browser → GET /api/portal/dashboard (Authorization: Bearer <JWT>)
         → portal-auth.js validates JWT
         → portal-controller.js calls portal-service.js
         → portal-service.js calls aggregation-service.js
         → Response with KPIs
```

### Authentication Approach
- **Method:** Email/password + stateless JWT
- **Token storage:** Browser localStorage
- **Token payload:** `{ userId, orgId, role, exp }`
- **Expiry:** 24 hours
- **Password hashing:** bcrypt (10 rounds)

### Database Considerations
- **New table:** `portal_admin_users` (single migration)
- **RLS:** Policies gated on `org_id` (standard pattern)
- **Indexes:** `org_id`, `email` (unique per org)

### Deployment Recommendation
- **Backend:** Deploy with existing ai-server (no new infrastructure)
- **Frontend:** Static build in `ai-server/src/portal/build/` OR separate Vercel deploy
- **Recommendation:** Start with static build in ai-server for simplicity; extract later if needed

---

## 3. Copilot-Driven Development Strategy

### Planning File Structure
```
plan/
├── 2026-05-21_web-productivity-portal_implementation-plan.md (this file)
├── portal/
│   ├── 01_database_migration.md
│   ├── 02_auth_backend.md
│   ├── 03_dashboard_api.md
│   ├── 04_employees_api.md
│   ├── 05_time_logs_api.md
│   ├── 06_reports_api.md
│   ├── 07_admin_users_api.md
│   ├── 08_frontend_setup.md
│   ├── 09_frontend_pages.md
│   └── 10_integration_testing.md
```

### Prompt Sequencing Strategy

**Phase 1 Prompts (Foundation):**
```
Prompt 1.1: "Create Supabase migration for portal_admin_users table with RLS"
Prompt 1.2: "Create portal-auth.js middleware following auth.js pattern"
Prompt 1.3: "Create portal-db-service.js for admin user CRUD"
Prompt 1.4: "Create portal auth controller with login/logout endpoints"
```

**Phase 2 Prompts (Core APIs):**
```
Prompt 2.1: "Create portal-service.js with dashboard aggregation methods"
Prompt 2.2: "Create portal-controller.js with dashboard endpoint"
Prompt 2.3: "Add employees list endpoint with search/filter/pagination"
Prompt 2.4: "Add employee detail endpoint with daily trend data"
```

**Phase 3 Prompts (Frontend):**
```
Prompt 3.1: "Create React portal app with Vite, React Router, Tailwind"
Prompt 3.2: "Create auth context and login page"
Prompt 3.3: "Create dashboard page with KPI cards and charts"
Prompt 3.4: "Create employees list page with DataTable component"
```

### Modular Development Approach

**Reusable Components (Build First):**
1. `DataTable` — Sortable, paginated table (used everywhere)
2. `DateRangePicker` — Filter component (used on every page)
3. `KPICard` — Metric display (dashboard, employee detail)
4. `FilterPanel` — Collapsible filter UI
5. `LoadingSpinner` / `ErrorBanner` — State indicators

**Build order for max reuse:**
```
1. DataTable + Pagination → used in Employees, Logs, Reports, Admin Users
2. DateRangePicker → used in Dashboard, Employees, Logs, Reports
3. KPICard → used in Dashboard, Employee Detail
4. Charts (Recharts) → used in Dashboard, Employee Detail
```

### Reducing Prompt Complexity

| Approach | Implementation |
|----------|----------------|
| Small focused prompts | One endpoint per prompt, one component per prompt |
| Reference existing code | "Follow the pattern in aggregation-service.js" |
| Provide schemas | Include TypeScript interfaces in prompts |
| Test-driven | Write test stub first, then implement |

### Parallelization Strategy

```
PARALLEL TRACK A (Backend Dev)     PARALLEL TRACK B (Frontend Dev)
──────────────────────────────     ─────────────────────────────────
Day 1: Migration + Auth middleware  Day 1: React setup + routing
Day 2: Auth controller + tests      Day 2: Auth context + login page
Day 3: Dashboard API + tests        Day 3: Reusable components
Day 4: Employees API                Day 4: Dashboard page
Day 5: Time Logs API                Day 5: Employees list page
Day 6: Reports API                  Day 6: Employee detail page
Day 7: Admin Users API              Day 7: Time logs page
Day 8: Integration                  Day 8: Reports page
```

---

## 4. Suggested Project Structure

### Backend Structure (ai-server additions)

```
ai-server/src/
├── middleware/
│   └── portal-auth.js              # NEW: JWT session validation
├── controllers/
│   ├── portal-auth-controller.js   # NEW: Login, logout, password change
│   ├── portal-controller.js        # NEW: Dashboard, employees, logs
│   └── portal-reports-controller.js # NEW: CSV/PDF export
├── services/
│   ├── portal-service.js           # NEW: Business logic aggregation
│   └── db/
│       └── portal-db-service.js    # NEW: portal_admin_users CRUD
├── portal/                         # NEW: React frontend
│   ├── build/                      # Production build (served statically)
│   ├── src/
│   │   ├── api/                    # API client functions
│   │   ├── components/             # Reusable UI components
│   │   ├── contexts/               # Auth context
│   │   ├── hooks/                  # Custom hooks
│   │   ├── pages/                  # Page components
│   │   ├── utils/                  # Helpers
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   └── tailwind.config.js
└── index.js                        # Add portal routes
```

### Frontend Module Structure

```
portal/src/
├── api/
│   ├── client.js                   # Axios instance with auth header
│   ├── auth.js                     # login(), logout()
│   ├── dashboard.js                # getDashboardData()
│   ├── employees.js                # getEmployees(), getEmployeeDetail()
│   ├── timeLogs.js                 # getTimeLogs()
│   ├── reports.js                  # getReportData(), exportCSV(), exportPDF()
│   └── adminUsers.js               # CRUD for portal admins
├── components/
│   ├── common/
│   │   ├── DataTable.jsx           # Sortable, paginated table
│   │   ├── DateRangePicker.jsx     # Date filter
│   │   ├── FilterPanel.jsx         # Collapsible filters
│   │   ├── KPICard.jsx             # Metric card
│   │   ├── LoadingSpinner.jsx
│   │   ├── ErrorBanner.jsx
│   │   └── ConfirmDialog.jsx
│   ├── charts/
│   │   ├── ProductivityTrendChart.jsx
│   │   ├── ProductivityDonutChart.jsx
│   │   └── DailyLineChart.jsx
│   └── layout/
│       ├── Sidebar.jsx
│       ├── Header.jsx
│       └── PageWrapper.jsx
├── contexts/
│   └── AuthContext.jsx             # User state, login/logout
├── hooks/
│   ├── useApi.js                   # Generic fetch hook
│   ├── useDateRange.js             # Date filter state
│   └── useDebounce.js              # Search debounce
├── pages/
│   ├── LoginPage.jsx
│   ├── DashboardPage.jsx
│   ├── EmployeesPage.jsx
│   ├── EmployeeDetailPage.jsx
│   ├── TimeLogsPage.jsx
│   ├── ReportsPage.jsx
│   └── SettingsPage.jsx            # Admin user management
├── utils/
│   ├── formatters.js               # Duration, date formatting
│   ├── constants.js                # API URLs, role enums
│   └── validators.js               # Form validation
├── App.jsx                         # Router + AuthProvider
└── main.jsx                        # Entry point
```

### API Organization

```
/api/portal/
├── auth/
│   ├── POST /login                 # { email, password } → { token, user }
│   ├── POST /logout                # Invalidate (optional for stateless JWT)
│   └── POST /change-password       # { current, new } → { success }
├── dashboard                       # GET ?org_id&from&to
├── employees                       # GET ?org_id&search&page&limit
├── employees/:userId               # GET ?org_id
├── employees/:userId/logs          # GET ?org_id&classification&from&to&page
├── time-logs                       # GET ?org_id&filters...&page&limit
├── reports/
│   ├── GET /data                   # Preview (20 rows)
│   ├── GET /export/csv             # Download CSV
│   └── GET /export/pdf             # Download PDF
└── admin-users/
    ├── GET /                       # List all
    ├── POST /                      # Create
    ├── PUT /:userId                # Update
    ├── DELETE /:userId             # Delete
    └── POST /:userId/change-password
```

### Naming Conventions
| Element | Convention | Example |
|---------|------------|---------|
| Files | kebab-case | `portal-auth-controller.js` |
| React components | PascalCase | `DataTable.jsx` |
| Functions | camelCase | `getDashboardData()` |
| API routes | kebab-case | `/api/portal/time-logs` |
| DB columns | snake_case | `portal_admin_users.org_id` |
| Constants | SCREAMING_SNAKE | `ROLES.SUPERADMIN` |

---

## 5. Fast-Track Implementation Plan

### Phase 1 — Foundation (Days 1-2)
**Deliverables:**
- [ ] Database migration for `portal_admin_users`
- [ ] `portal-auth.js` middleware
- [ ] `portal-db-service.js` (admin user CRUD)
- [ ] `portal-auth-controller.js` (login/logout endpoints)
- [ ] Unit tests for auth flow

**Dependencies:** None (first phase)  
**Priority:** P0 — Blocks everything  
**Duration:** 2 days

### Phase 2 — Core Backend APIs (Days 3-5)
**Deliverables:**
- [ ] `portal-service.js` (aggregation methods)
- [ ] Dashboard endpoint with KPIs + trend data
- [ ] Employees list endpoint with search/filter/pagination
- [ ] Employee detail endpoint with daily trend
- [ ] Time logs endpoint with full filtering
- [ ] Unit tests for each endpoint

**Dependencies:** Phase 1 complete  
**Priority:** P0  
**Duration:** 3 days

### Phase 3 — Frontend Foundation (Days 3-5, parallel)
**Deliverables:**
- [ ] React + Vite + Tailwind setup
- [ ] Routing with React Router
- [ ] Auth context + protected routes
- [ ] Login page
- [ ] Reusable components: DataTable, DateRangePicker, KPICard, FilterPanel

**Dependencies:** None (can start Day 1)  
**Priority:** P0  
**Duration:** 3 days (parallel with Phase 2)

### Phase 4 — Frontend Pages (Days 6-8)
**Deliverables:**
- [ ] Dashboard page with charts
- [ ] Employees list page
- [ ] Employee detail page
- [ ] Time logs page

**Dependencies:** Phase 2 + Phase 3 complete  
**Priority:** P0  
**Duration:** 3 days

### Phase 5 — Reports & Admin (Days 9-10)
**Deliverables:**
- [ ] Reports API (CSV + PDF export)
- [ ] Reports page with filters + preview + download
- [ ] Admin users API (CRUD)
- [ ] Settings page (admin user management)

**Dependencies:** Phase 4 complete  
**Priority:** P1  
**Duration:** 2 days

### Phase 6 — Polish & Deploy (Days 11-12)
**Deliverables:**
- [ ] Error handling improvements
- [ ] Loading states and empty states
- [ ] Dark/light theme toggle
- [ ] Responsive design fixes
- [ ] Integration testing
- [ ] Production deployment

**Dependencies:** Phase 5 complete  
**Priority:** P1  
**Duration:** 2 days

---

## 6. Detailed Task Breakdown

### Backend Tasks

| Task | Complexity | Effort | Phase |
|------|------------|--------|-------|
| Create `portal_admin_users` migration | Simple | 2h | 1 |
| Create `portal-auth.js` middleware | Medium | 3h | 1 |
| Create `portal-db-service.js` | Simple | 2h | 1 |
| Create `portal-auth-controller.js` | Medium | 3h | 1 |
| Write auth unit tests | Simple | 2h | 1 |
| Create `portal-service.js` base | Medium | 3h | 2 |
| Implement dashboard endpoint | Medium | 3h | 2 |
| Implement employees list endpoint | Medium | 3h | 2 |
| Implement employee detail endpoint | Medium | 2h | 2 |
| Implement time logs endpoint | Medium | 3h | 2 |
| Write API unit tests | Medium | 4h | 2 |
| Implement reports data endpoint | Medium | 2h | 5 |
| Implement CSV export | Simple | 2h | 5 |
| Implement PDF export | Medium | 4h | 5 |
| Implement admin users CRUD | Simple | 3h | 5 |
| **Backend Total** | | **~41h (5-6 days)** | |

### Frontend Tasks

| Task | Complexity | Effort | Phase |
|------|------------|--------|-------|
| React + Vite + Tailwind setup | Simple | 2h | 3 |
| Configure routing | Simple | 1h | 3 |
| Create API client + auth interceptor | Simple | 2h | 3 |
| Create AuthContext | Medium | 2h | 3 |
| Create LoginPage | Simple | 2h | 3 |
| Create DataTable component | Medium | 4h | 3 |
| Create DateRangePicker component | Medium | 3h | 3 |
| Create KPICard component | Simple | 1h | 3 |
| Create FilterPanel component | Medium | 2h | 3 |
| Create Sidebar + Header layout | Simple | 2h | 3 |
| Create DashboardPage | Medium | 4h | 4 |
| Integrate Recharts (bar/donut charts) | Medium | 3h | 4 |
| Create EmployeesPage | Medium | 3h | 4 |
| Create EmployeeDetailPage | Medium | 4h | 4 |
| Create TimeLogsPage | Medium | 3h | 4 |
| Create ReportsPage | Medium | 4h | 5 |
| Create SettingsPage | Medium | 3h | 5 |
| Add dark/light theme | Simple | 2h | 6 |
| Responsive design fixes | Simple | 3h | 6 |
| **Frontend Total** | | **~50h (6-7 days)** | |

### Database Tasks

| Task | Complexity | Effort | Phase |
|------|------------|--------|-------|
| Design `portal_admin_users` schema | Simple | 1h | 1 |
| Write migration SQL | Simple | 1h | 1 |
| Add RLS policies | Simple | 1h | 1 |
| Seed test admin user | Simple | 0.5h | 1 |
| **Database Total** | | **~3.5h** | |

### DevOps/Deployment Tasks

| Task | Complexity | Effort | Phase |
|------|------------|--------|-------|
| Add build script for portal frontend | Simple | 1h | 6 |
| Configure static file serving in Express | Simple | 1h | 6 |
| Update ai-server Dockerfile (if needed) | Simple | 1h | 6 |
| Test production build | Simple | 2h | 6 |
| Deploy to production | Simple | 2h | 6 |
| **DevOps Total** | | **~7h** | |

### Testing Tasks

| Task | Complexity | Effort | Phase |
|------|------------|--------|-------|
| Auth middleware tests | Simple | 2h | 1 |
| Auth controller tests | Simple | 2h | 1 |
| Dashboard API tests | Medium | 2h | 2 |
| Employees API tests | Medium | 2h | 2 |
| Time logs API tests | Medium | 2h | 2 |
| Reports API tests | Medium | 2h | 5 |
| Integration smoke tests | Medium | 4h | 6 |
| **Testing Total** | | **~16h** | |

---

## 7. Accelerated Timeline Estimation

### Assumptions
- Single focused developer (or 2-person team)
- Heavy Copilot usage (50-70% code generation)
- Existing patterns to follow
- Minimal documentation overhead
- 8-hour workdays

### Copilot Acceleration Factors
| Task Type | Manual Effort | With Copilot | Savings |
|-----------|---------------|--------------|---------|
| Boilerplate code | 4h | 1h | 75% |
| CRUD endpoints | 3h | 1h | 67% |
| React components | 4h | 2h | 50% |
| Unit tests | 3h | 1h | 67% |
| SQL migrations | 2h | 1h | 50% |

### Timeline Breakdown

| Phase | Effort (manual) | Effort (Copilot) | Duration |
|-------|-----------------|------------------|----------|
| Phase 1: Foundation | 16h | 10h | 1.5 days |
| Phase 2: Core Backend | 20h | 12h | 1.5 days |
| Phase 3: Frontend Foundation | 24h | 14h | 2 days |
| Phase 4: Frontend Pages | 20h | 12h | 2 days |
| Phase 5: Reports & Admin | 16h | 10h | 1.5 days |
| Phase 6: Polish & Deploy | 16h | 12h | 1.5 days |
| **Total** | **112h** | **70h** | **10 days** |

### Final Estimates

| Scenario | Duration | Notes |
|----------|----------|-------|
| **Best-case** | 8 days | Everything goes smoothly, no blockers |
| **Realistic fast-track** | 10-11 days | Some iteration, minor issues |
| **With buffer** | 12-14 days | Accounts for unknowns, testing gaps |

### Component Estimates

| Component | Best-case | Realistic |
|-----------|-----------|-----------|
| Backend APIs | 3 days | 4 days |
| Frontend UI | 4 days | 5 days |
| Integration | 1 day | 1.5 days |
| Testing | 1 day | 1.5 days |
| Deployment | 0.5 days | 1 day |

---

## 8. Recommended Development Order

### Day 1-2: Foundation (MUST START HERE)
```
1. Database migration (portal_admin_users)
   └── Unblocks: All auth, all queries
2. portal-auth.js middleware
   └── Unblocks: All protected endpoints
3. portal-auth-controller.js (login endpoint)
   └── Unblocks: Frontend auth integration
4. React project setup + AuthContext
   └── Unblocks: All frontend pages
```

### Day 3-4: Core Data APIs
```
5. portal-service.js (aggregation methods)
   └── Unblocks: Dashboard, employees
6. Dashboard endpoint
   └── Unblocks: Dashboard page
7. Employees list endpoint
   └── Unblocks: Employees page
8. Reusable components (DataTable, DateRangePicker)
   └── Unblocks: All list pages
```

### Day 5-6: Primary Pages
```
9. Dashboard page (uses KPICard, charts)
10. Employees page (uses DataTable, DateRangePicker)
11. Employee detail endpoint + page
12. Time logs endpoint
```

### Day 7-8: Secondary Features
```
13. Time logs page
14. Reports API (CSV/PDF)
15. Reports page
```

### Day 9-10: Admin & Polish
```
16. Admin users API
17. Settings page
18. Dark/light theme
19. Responsive fixes
20. Integration testing
```

### Parallel Development Chart

```
         Day 1   Day 2   Day 3   Day 4   Day 5   Day 6   Day 7   Day 8   Day 9   Day 10
Backend  [Auth]──[Auth]──[APIs]──[APIs]──[APIs]──[Logs]──[Rpts]──[Rpts]──[Admin]─[Test]
                    ↓       ↓       ↓       ↓       ↓
Frontend [Setup]─[Login]─[Comps]─[Dash]──[Emps]──[Dtl]──[Logs]──[Rpts]──[Set]───[Polish]
```

### Defer Until Later
- Department/team grouping (no schema)
- Audit trail (future compliance)
- Advanced SSO (v2 feature)
- Mobile optimization beyond basic responsive

---

## 9. Risks & Mitigation

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| PDF generation complexity | Medium | Medium | Use simple library (pdfkit or jspdf); template approach |
| Large dataset performance | Low | High | Add DB indexes upfront; paginate everything |
| Auth token security | Low | High | Follow existing patterns; short expiry; HTTPS only |
| Chart library learning curve | Low | Low | Use Recharts (well-documented); Copilot knows it |

### Integration Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Existing aggregation-service gaps | Medium | Medium | Review service early; extend if needed |
| RLS policy conflicts | Low | Medium | Test queries with org_id filtering first |
| Supabase rate limits | Low | Low | Batch queries where possible |

### Schedule Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Requirements ambiguity | Medium | Medium | Clarify edge cases early (empty states, error handling) |
| Scope creep | Medium | High | Strict MVP focus; defer nice-to-haves |
| Testing gaps | Medium | Medium | Write tests alongside code; don't defer |

### Deployment Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Static file serving issues | Low | Low | Test build locally first |
| Environment variable missing | Low | Low | Document all required vars |
| CORS issues (if separate deploy) | Medium | Low | Stick with same-origin initially |

---

## 10. Final Recommendation

### Recommended Architecture
**Integrate into existing ai-server** — leverages existing infrastructure, patterns, and deployment pipeline. Fastest path to production.

### Recommended Deployment Model
**Single deployment** — Portal frontend built as static files, served from ai-server. No additional infrastructure required.

### Fastest Implementation Strategy
1. **Start with auth + migration** (Day 1) — unblocks everything
2. **Parallel frontend/backend** (Day 2+) — maximize velocity
3. **Build reusable components first** — DataTable, DateRangePicker accelerate all pages
4. **Follow existing patterns** — reduces Copilot prompt complexity
5. **Test alongside implementation** — avoid testing debt

### Estimated Total Completion

| Scenario | Timeline |
|----------|----------|
| Aggressive (ideal conditions) | **8 working days** |
| Realistic fast-track | **10-11 working days** |
| With safety buffer | **12-14 working days** |

### Suggested Team Allocation

**Option A: Solo Developer (Recommended for speed)**
- One senior full-stack developer
- 10-11 days to complete
- Maximum Copilot leverage

**Option B: Two-Person Team**
- Backend developer: Auth + APIs + Tests
- Frontend developer: React app + Pages
- 6-7 days to complete (parallel work)
- Requires coordination overhead

---

## Appendix A: Copilot Prompt Templates

### Migration Prompt
```
Create a Supabase migration file for the portal_admin_users table.
Follow the naming convention: 20260521_add_portal_admin_users.sql

Schema:
- id: UUID primary key (gen_random_uuid())
- org_id: UUID foreign key to organizations
- email: VARCHAR(255) unique per org
- password_hash: VARCHAR(255)
- display_name: VARCHAR(255)
- role: VARCHAR(20) CHECK (role IN ('superadmin', 'admin', 'viewer'))
- created_at: TIMESTAMPTZ DEFAULT NOW()
- updated_at: TIMESTAMPTZ DEFAULT NOW()
- last_login_at: TIMESTAMPTZ nullable

Include:
- RLS enabled
- Policy for SELECT/INSERT/UPDATE/DELETE gated on org_id matching authenticated user's org
- Index on (org_id, email)
```

### Middleware Prompt
```
Create portal-auth.js middleware following the pattern in auth.js.

Requirements:
- Verify JWT from Authorization: Bearer header
- Extract userId, orgId, role from token payload
- Attach user object to req.portalUser
- Return 401 if token missing/invalid/expired
- Use jsonwebtoken library
- Environment variable: PORTAL_JWT_SECRET
```

### Controller Prompt
```
Create portal-auth-controller.js with login endpoint.

Follow the pattern in admin-dashboard-controller.js.

POST /api/portal/auth/login
- Body: { email, password }
- Validate email and password presence
- Query portal_admin_users by org_id and email
- Compare password with bcrypt
- Generate JWT with { userId, orgId, role, exp: 24h }
- Update last_login_at
- Return { token, user: { id, email, displayName, role, orgId } }
- Return 401 for invalid credentials
```

### React Component Prompt
```
Create a reusable DataTable component with:
- Sortable columns (click header to sort)
- Pagination controls (page size: 20, show total)
- Loading skeleton state
- Empty state message
- Row click handler (optional)

Props:
- columns: Array<{ key, label, sortable, render? }>
- data: Array<Record>
- loading: boolean
- emptyMessage: string
- onRowClick?: (row) => void
- pagination: { page, totalCount, onPageChange }

Use Tailwind CSS. Follow existing component patterns.
```

---

## Appendix B: File Creation Checklist

### Backend Files to Create
- [ ] `supabase/migrations/20260521_add_portal_admin_users.sql`
- [ ] `ai-server/src/middleware/portal-auth.js`
- [ ] `ai-server/src/services/db/portal-db-service.js`
- [ ] `ai-server/src/services/portal-service.js`
- [ ] `ai-server/src/controllers/portal-auth-controller.js`
- [ ] `ai-server/src/controllers/portal-controller.js`
- [ ] `ai-server/src/controllers/portal-reports-controller.js`
- [ ] `ai-server/tests/middleware/portal-auth.test.js`
- [ ] `ai-server/tests/controllers/portal-auth-controller.test.js`
- [ ] `ai-server/tests/controllers/portal-controller.test.js`
- [ ] `ai-server/tests/services/portal-service.test.js`

### Frontend Files to Create
- [ ] `ai-server/src/portal/package.json`
- [ ] `ai-server/src/portal/vite.config.js`
- [ ] `ai-server/src/portal/tailwind.config.js`
- [ ] `ai-server/src/portal/src/main.jsx`
- [ ] `ai-server/src/portal/src/App.jsx`
- [ ] `ai-server/src/portal/src/api/client.js`
- [ ] `ai-server/src/portal/src/api/auth.js`
- [ ] `ai-server/src/portal/src/api/dashboard.js`
- [ ] `ai-server/src/portal/src/api/employees.js`
- [ ] `ai-server/src/portal/src/api/timeLogs.js`
- [ ] `ai-server/src/portal/src/api/reports.js`
- [ ] `ai-server/src/portal/src/api/adminUsers.js`
- [ ] `ai-server/src/portal/src/contexts/AuthContext.jsx`
- [ ] `ai-server/src/portal/src/components/common/DataTable.jsx`
- [ ] `ai-server/src/portal/src/components/common/DateRangePicker.jsx`
- [ ] `ai-server/src/portal/src/components/common/KPICard.jsx`
- [ ] `ai-server/src/portal/src/components/common/FilterPanel.jsx`
- [ ] `ai-server/src/portal/src/components/common/LoadingSpinner.jsx`
- [ ] `ai-server/src/portal/src/components/common/ErrorBanner.jsx`
- [ ] `ai-server/src/portal/src/components/common/ConfirmDialog.jsx`
- [ ] `ai-server/src/portal/src/components/charts/ProductivityTrendChart.jsx`
- [ ] `ai-server/src/portal/src/components/charts/ProductivityDonutChart.jsx`
- [ ] `ai-server/src/portal/src/components/layout/Sidebar.jsx`
- [ ] `ai-server/src/portal/src/components/layout/Header.jsx`
- [ ] `ai-server/src/portal/src/pages/LoginPage.jsx`
- [ ] `ai-server/src/portal/src/pages/DashboardPage.jsx`
- [ ] `ai-server/src/portal/src/pages/EmployeesPage.jsx`
- [ ] `ai-server/src/portal/src/pages/EmployeeDetailPage.jsx`
- [ ] `ai-server/src/portal/src/pages/TimeLogsPage.jsx`
- [ ] `ai-server/src/portal/src/pages/ReportsPage.jsx`
- [ ] `ai-server/src/portal/src/pages/SettingsPage.jsx`

---

## Appendix C: Environment Variables

### New Variables Required

```bash
# Add to ai-server/.env
PORTAL_JWT_SECRET=<random-32-char-string>
PORTAL_JWT_EXPIRY=24h
```

### Existing Variables (already configured)
```bash
SUPABASE_URL=<existing>
SUPABASE_SERVICE_KEY=<existing>
```

---

**End of Implementation Plan**

*This document serves as the master planning file for Copilot-driven development. Each phase should generate specific prompt sequences following the templates in Appendix A.*
