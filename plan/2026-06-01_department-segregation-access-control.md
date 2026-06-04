# Department-Based Segregation & Access Control — Technical Design Document

**Date:** 2026-06-01
**Status:** Planning
**Components:** Supabase (schema), ai-server (portal backend + API), forge-app (Jira UI), portal frontend (React SPA)

---

## 1. Current Architecture Analysis

### 1.1 The `organizations` Table IS the Departments Model

The existing `organizations` table already serves as the department entity. Each row represents a department/team (ATG, Evoke Systems, Wellgistics, ITracker, etc.) with its own Jira Cloud instance:

```sql
CREATE TABLE public.organizations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jira_cloud_id       TEXT UNIQUE NOT NULL,  -- Each dept has its own Jira Cloud site
    jira_instance_url   TEXT NOT NULL,
    org_name            TEXT NOT NULL,          -- Department name
    subscription_status TEXT DEFAULT 'active',
    subscription_tier   TEXT DEFAULT 'free',
    settings            JSONB DEFAULT '{}',
    is_active           BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);
```

**Production data (8 departments):**

| org_name | jira_cloud_id | jira_instance_url |
|----------|---------------|-------------------|
| Evoke Systems | evoke-cloud-id | evokesystems.atlassian.net |
| amzur | 5b434ae7... | amzur.atlassian.net |
| evoke | a537792d... | evoke.atlassian.net |
| timetracker | b2d8d08c... | timetracker.atlassian.net |
| Amzur Technologies | amzur-cloud-id | amzur.atlassian.net |
| itracker-amzur | bef59fad... | itracker-amzur.atlassian.net |
| ITracker | itracker-cloud-id | itracker.atlassian.net |
| amzur-itracker | fe6c4580... | amzur-itracker.atlassian.net |

**No new departments table is needed.** The solution reuses `organizations` as-is.

### 1.2 Existing Tables Analysis

#### Tables WITH `organization_id` — Already Department-Scoped

| Table | organization_id | Nullable | Notes |
|-------|----------------|----------|-------|
| `users` | YES | YES (FK, ON DELETE SET NULL) | Single FK — user's "primary" department |
| `organization_members` | YES | NO (FK) | **Many-to-many junction** — UNIQUE(user_id, org_id) |
| `activity_records` | YES | YES (FK) | All activity already dept-scoped |
| `screenshots` | YES | YES (FK) | All screenshots already dept-scoped |
| `application_classifications` | YES | YES (nullable for globals) | 3-tier: global → org → project |
| `tracking_settings` | YES | YES | Org-level + project-level config |
| `project_settings` | YES | NOT NULL | UNIQUE(org_id, project_key) |
| `organization_settings` | YES | NOT NULL (UNIQUE 1:1) | AI server config, intervals |
| `analysis_results` | YES | YES | Legacy pipeline results |
| `worklogs` | YES | YES | Synced Jira worklogs |
| `worklog_sync` | YES | YES | UNIQUE(org_id, user_id, issue_key) |
| `unassigned_activity` | YES | YES | Unclassified work sessions |
| `unassigned_work_groups` | YES | YES | Grouped unassigned work |
| `user_jira_issues_cache` | YES | YES | UNIQUE(user_id, org_id, issue_key) |
| `notification_logs` | YES | NOT NULL | Notification history |
| `notification_preferences` | YES | NOT NULL | UNIQUE(user_id) |
| `created_issues_log` | YES | YES | Issues created via app |
| `documents` | YES | YES | Uploaded documents |
| `feedback` | YES | YES (+ jira_cloud_id) | User feedback |
| `dashboard_header_metrics` | YES | NOT NULL | UNIQUE(org_id, metric_key) |
| `dashboard_organizations` | YES | NOT NULL | Admin dashboard orgs |
| `dashboard_tickets_per_team` | YES | NOT NULL | Dashboard team tickets |
| `dashboard_ticket_status` | YES | NOT NULL | Dashboard ticket status |
| `ai_accuracy_events` | YES | NOT NULL (no FK) | AI accuracy tracking |
| `portal_admin_users` | YES (`org_id`) | NOT NULL | Portal login accounts |

#### Tables WITHOUT `organization_id`

| Table | Scope | Notes |
|-------|-------|-------|
| `app_releases` | Global | Desktop app versions — not org-specific |
| `notification_cooldowns` | User-only | UNIQUE(user_id, type) — no org dimension |
| `accuracy_dashboard_users` | Global | Email allowlist for AI accuracy dashboard |
| `unassigned_group_members` | Via FK to group | Inherits org via `unassigned_work_groups` |
| `description_quality_cache` | TEXT `org_id` | Uses TEXT not UUID FK — inconsistency |
| `description_quality_events` | TEXT `org_id` | Same inconsistency |

#### Summary Views (Computed, Not Tables)

| View | Source | Has org_id? |
|------|--------|-------------|
| `daily_time_summary` | `analysis_results` JOIN `screenshots` | YES (inherited) |
| `weekly_time_summary` | Same | YES |
| `monthly_time_summary` | Same | YES |
| `project_time_summary` | Same | YES |
| `task_time_summary` | Same | YES |
| `unassigned_activity_summary` | `unassigned_activity` | YES |

### 1.3 `organization_members` — Already Many-to-Many

```sql
CREATE TABLE public.organization_members (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'member')),
    can_manage_settings       BOOLEAN DEFAULT false,
    can_view_team_analytics   BOOLEAN DEFAULT false,
    can_manage_members        BOOLEAN DEFAULT false,
    can_delete_screenshots    BOOLEAN DEFAULT false,
    can_manage_billing        BOOLEAN DEFAULT false,
    joined_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, organization_id)
);
```

**This table already supports:**
- ✅ A user belonging to multiple departments (many-to-many)
- ✅ Different roles per department (owner/admin/manager/member)
- ✅ Granular per-department permissions (`can_view_team_analytics`, etc.)

**Currently underutilized:** The `manager` role exists but has no department-scoped behavior — managers see the same data as members.

### 1.4 `application_classifications` — Already Supports Per-Department Rules

```sql
-- Global defaults (208 seeds):     organization_id IS NULL, is_default = TRUE
-- Department-specific override:     organization_id = 'ATG-uuid'
-- Project-specific override:        organization_id = 'ATG-uuid', project_key = 'PROJ'
```

**Already supports the requirement:** ATG can classify ChatGPT as productive while Wellgistics classifies it as non-productive. No schema change needed for this table.

### 1.5 Current Authorization Models (Two Parallel Systems)

#### A. Forge App Auth (Jira-embedded UI)

| Source | How Used |
|--------|----------|
| `context.cloudId` (from Forge FIT token) | Maps to `organizations.jira_cloud_id` → determines department |
| `organization_members.role` | owner/admin/manager/member — checked by `getUserOrganizationMembership()` |
| Jira permissions API | `isJiraAdmin`, `projectAdminProjects[]` — checked by `getUserPermissions()` |

**Current forge-app visibility:**
- Jira Admin → Org Analytics, User Status, Team Analytics for all projects
- Project Admin → Team Analytics for administered projects
- Regular user → Own Time Analytics, My Focus only

**Each Jira site = one department.** The forge-app automatically resolves to the correct department via `cloudId`. Users in different departments use different Jira sites.

#### B. Portal Auth (Standalone Web Portal)

| Source | How Used |
|--------|----------|
| `portal_admin_users` table | `org_id` (single FK), `role` (superadmin/admin/viewer) |
| `portal-auth.js` middleware | Extracts `{userId, orgId, email, role}` from JWT |

**Current portal visibility:** All data queries in `portal-service.js` accept `orgId` but **don't consistently filter by it** — a pre-existing bug. Each portal admin is tied to ONE department.

### 1.6 Forge App Organization Provisioning Flow

```
Forge Request → context.cloudId (Jira Cloud site ID)
  → ai-server: getOrCreateOrganization(cloudId)
     → SELECT * FROM organizations WHERE jira_cloud_id = cloudId
     → Returns existing org or creates new one
  → ai-server: getOrCreateUser(accountId, organizationId)
     → Sets users.organization_id = resolved org
     → Ensures organization_members row exists (role='member')
```

**Each department's Jira site automatically provisions its organization.** No manual setup needed. Users are auto-assigned to their department when they first use the Forge app on their Jira site.

---

## 2. Gap Analysis

### 2.1 What Already Works

| Requirement | Status | Existing Support |
|-------------|--------|-----------------|
| Department entity | ✅ Done | `organizations` table with 8 departments |
| User-to-department mapping | ✅ Done | `organization_members` (many-to-many, with roles) |
| Department-specific data | ✅ Done | All data tables have `organization_id` |
| Department-specific app classifications | ✅ Done | `application_classifications.organization_id` supports per-dept overrides |
| Department-specific settings | ✅ Done | `tracking_settings` and `project_settings` scoped by org |
| Forge auto-provisioning | ✅ Done | cloudId → org mapping works per-department |

### 2.2 What's Missing

| Gap | Impact | Component |
|-----|--------|-----------|
| **Portal admin tied to single department** | `portal_admin_users.org_id` is single FK; email is globally unique — admin can manage only ONE department | Portal backend |
| **No cross-department super admin** | No portal user can see data across all departments simultaneously | Portal backend + frontend |
| **Portal queries don't filter by org_id** | `portal-service.js` methods ignore `orgId` parameter — data leak across departments | Portal backend |
| **No department switcher in portal UI** | Portal frontend has no mechanism to select/switch departments | Portal frontend |
| **No multi-department aggregation** | Cannot generate reports across multiple departments | Portal reports |
| **RLS policies use `users.organization_id` (single)** | Users can only see data from their primary department via RLS | Supabase |
| **Forge-app scoped to single site** | Each Forge instance sees only one department — no cross-department view | Forge-app |
| **No department management UI** | Cannot create/manage departments, assign users to departments | Both UIs |
| **`users.organization_id` is singular** | User's "primary" department; doesn't reflect multi-department membership | Schema |

---

## 3. Proposed Solution

### 3.1 Core Principle: Reuse Existing Schema

**No new `departments` table.** The `organizations` table IS departments. The solution adds:
1. A cross-department super admin concept via a new `portal_admin_departments` junction table
2. Department-aware queries in `portal-service.js`
3. A department selector/switcher in the portal UI
4. Cross-department aggregation capabilities

### 3.2 Authorization Model

#### Portal Roles (Enhanced)

| Role | Scope | Access |
|------|-------|--------|
| **superadmin** | All departments (cross-org) | Global visibility, department management, user assignment, all analytics, all reports, all exports |
| **admin** | Assigned departments (1+) | Analytics, app classifications, reports, exports for assigned departments |
| **viewer** | Assigned departments (1+) | Read-only analytics for assigned departments |

**Key change:** Admins and viewers can now be assigned to MULTIPLE departments via a junction table, instead of being locked to one via `portal_admin_users.org_id`.

#### Forge App Roles (Leveraging Existing `organization_members`)

| Role | Current Scope | Change |
|------|--------------|--------|
| **owner** | Single department (Jira site) | No change — full access to own department |
| **admin** | Single department | No change — admin within own department |
| **manager** | Same as member (unused) | **Activate:** scoped analytics visibility within own department |
| **member** | Own data only | No change |

**Forge-app remains single-department per instance.** This is inherent to the Forge architecture (each Jira site is independent). Cross-department views are a portal-only feature.

### 3.3 Data Flow After Change

```
Portal Super Admin (cross-department):
  ├── Selects "All Departments" → aggregated view
  ├── Selects "ATG" → filtered to ATG only
  └── Selects "ATG + Evoke" → filtered to selected departments

Portal Admin/Viewer (department-scoped):
  ├── Sees department selector with assigned departments only
  └── Data automatically filtered to assigned departments

Forge App (unchanged per-site):
  ├── User on ATG's Jira site → sees ATG data only
  └── User on Evoke's Jira site → sees Evoke data only
```

---

## 4. Database Schema Changes

### 4.1 New Table: `portal_admin_departments` (Junction)

```sql
-- Migration: supabase/migrations/20260602_add_portal_admin_departments.sql

-- Portal admin ↔ department (organization) junction table
-- Allows portal admins to be assigned to multiple departments
CREATE TABLE public.portal_admin_departments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id    UUID NOT NULL REFERENCES public.portal_admin_users(id) ON DELETE CASCADE,
    organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    assigned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_by      UUID REFERENCES public.portal_admin_users(id) ON DELETE SET NULL,

    CONSTRAINT portal_admin_dept_unique UNIQUE (admin_user_id, organization_id)
);

-- Indexes
CREATE INDEX idx_portal_admin_dept_admin ON public.portal_admin_departments(admin_user_id);
CREATE INDEX idx_portal_admin_dept_org   ON public.portal_admin_departments(organization_id);

-- RLS
ALTER TABLE public.portal_admin_departments ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_admin_dept_service_role ON public.portal_admin_departments
    FOR ALL USING (true) WITH CHECK (true);
-- Note: Portal uses service_role key; RLS policy is permissive for service_role
```

### 4.2 Modified Table: `portal_admin_users`

The existing `org_id` column remains as the admin's **primary/default** department. The new junction table extends this to multiple departments.

```sql
-- No schema change to portal_admin_users itself.
-- org_id remains as the default/primary department.
-- portal_admin_departments provides the multi-department association.
-- Superadmins bypass department filtering entirely.
```

**Migration also seeds the junction table from existing data:**

```sql
-- Seed portal_admin_departments from existing portal_admin_users
-- Each admin gets their current org_id as their initial department assignment
INSERT INTO public.portal_admin_departments (admin_user_id, organization_id)
SELECT id, org_id FROM public.portal_admin_users
ON CONFLICT DO NOTHING;
```

### 4.3 No Changes to These Tables

| Table | Reason |
|-------|--------|
| `organizations` | Already serves as departments — no changes needed |
| `organization_members` | Already many-to-many with roles — no changes needed |
| `application_classifications` | Already supports per-org classification overrides |
| `activity_records` | Already has `organization_id` for department scoping |
| `screenshots` | Already department-scoped |
| `tracking_settings` | Already department-scoped |
| `users` | `organization_id` remains as primary department; `organization_members` handles multi-dept |

### 4.4 RLS Policy Updates

Several RLS policies currently check `users.organization_id` (single FK) instead of `organization_members` (many-to-many). These should be updated for true multi-department access:

```sql
-- Update organizations RLS to use organization_members instead of users.organization_id
DROP POLICY IF EXISTS "organizations_select_member" ON public.organizations;
CREATE POLICY "organizations_select_member" ON public.organizations
    FOR SELECT USING (
        id IN (
            SELECT organization_id FROM public.organization_members
            WHERE user_id = (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
        )
    );

-- Update organization_members RLS similarly
DROP POLICY IF EXISTS "org_members_select" ON public.organization_members;
CREATE POLICY "org_members_select" ON public.organization_members
    FOR SELECT USING (
        organization_id IN (
            SELECT organization_id FROM public.organization_members
            WHERE user_id = (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
        )
    );
```

**Note:** Portal uses service_role key (bypasses RLS), so these changes primarily affect direct Supabase access from the desktop app and forge-app.

### 4.5 Entity Relationship Diagram

```
┌──────────────────────┐
│    organizations     │ (= Departments: ATG, Evoke, Wellgistics, etc.)
│──────────────────────│
│ id (PK)              │
│ jira_cloud_id (UQ)   │
│ org_name             │
│ subscription_status  │
│ is_active            │
└─────────┬────────────┘
          │ 1
          │
     ┌────┼──────────────────────────┐
     │    │ N                        │ N
     │    │                          │
     │ ┌──┴─────────────────────┐ ┌──┴────────────────────────────┐
     │ │  organization_members  │ │  portal_admin_departments     │ ← NEW
     │ │  (user ↔ dept M:N)    │ │  (portal admin ↔ dept M:N)   │
     │ │────────────────────────│ │────────────────────────────────│
     │ │ user_id (FK → users)  │ │ admin_user_id (FK → portal)  │
     │ │ organization_id (FK)  │ │ organization_id (FK → orgs)  │
     │ │ role (owner/admin/    │ └────────────────┬───────────────┘
     │ │   manager/member)     │                  │
     │ │ can_view_team_*       │                  │ N
     │ └──────────┬────────────┘                  │
     │            │ N                     ┌───────┴───────────────┐
     │            │                       │  portal_admin_users   │
     │       ┌────┴────┐                  │──────────────────────│
     │       │  users  │                  │ id (PK)              │
     │       │─────────│                  │ org_id (FK, primary) │
     │       │ id (PK) │                  │ email (UNIQUE)       │
     │       │ org_id  │ (primary dept)   │ role (super/admin/   │
     │       └─────────┘                  │   viewer)            │
     │                                    └──────────────────────┘
     │
     │ N (already scoped)
     │
┌────┴────────────────────────┐  ┌─────────────────────────────┐
│     activity_records        │  │  application_classifications│
│─────────────────────────────│  │─────────────────────────────│
│ user_id, organization_id   │  │ organization_id (nullable)  │
│ classification, duration    │  │ identifier, classification  │
│ work_date, application_name│  │ match_by, project_key       │
└─────────────────────────────┘  │ is_default                  │
                                 └─────────────────────────────┘
```

### 4.6 Migration Strategy

**Single migration file:** `supabase/migrations/20260602_add_portal_admin_departments.sql`

1. Create `portal_admin_departments` junction table
2. Seed from existing `portal_admin_users.org_id`
3. Update RLS policies on `organizations` and `organization_members` to use junction table
4. Add indexes

**Rollback:** Drop the junction table; RLS policies revert to `users.organization_id` check.

---

## 5. Backend Changes — ai-server (Portal API)

### 5.1 Core Change: Department-Scoped Portal Queries

**The fundamental fix:** Every method in `portal-service.js` currently ignores `orgId`. Each must be updated to:

1. Accept `orgIds` (array — one or more departments)
2. Filter queries by `.in('organization_id', orgIds)`

**New helper: Department scope resolution**

```javascript
// ai-server/src/services/portal-scope-service.js

async function resolvePortalScope(portalUser) {
    const supabase = getClient();

    // Superadmins see everything
    if (portalUser.role === 'superadmin') return null; // null = no filter

    // Look up assigned departments from junction table
    const { data } = await supabase
        .from('portal_admin_departments')
        .select('organization_id')
        .eq('admin_user_id', portalUser.userId);

    return data?.map(r => r.organization_id) || [];
}
```

### 5.2 Modified Service: `portal-service.js`

Every method receives `orgIds` (array or null for superadmin):

| Method | Current | Change |
|--------|---------|--------|
| `getDashboardData(orgId, from, to)` | No org filter on query | Add `.in('organization_id', orgIds)` to activity_records query |
| `getEmployeesList(orgId, search)` | No org filter | Add `.in('organization_id', orgIds)` to users query |
| `getEmployees(orgId, filters, pagination)` | No org filter | Filter users + activity by orgIds |
| `getEmployeeDetail(orgId, userId, from, to)` | No org filter | Validate user belongs to scoped orgs |
| `getTimeLogs(orgId, filters, pagination)` | No org filter | Add `.in('organization_id', orgIds)` to activity_records query |

**Example change for `getDashboardData`:**

```javascript
async getDashboardData(orgIds, from, to) {
    const supabase = getClient();
    let query = supabase
        .from('activity_records')
        .select('classification, duration_seconds, user_id, work_date')
        .gte('work_date', from)
        .lte('work_date', to)
        .neq('is_idle', true);

    // Apply department scope (null = superadmin, all data)
    if (orgIds !== null) {
        query = query.in('organization_id', orgIds);
    }

    const { data: activities, error } = await query
        .order('start_time', { ascending: false })
        .limit(50000);
    // ... rest unchanged
}
```

### 5.3 Modified Controller: `portal-controller.js`

Each handler resolves scope before calling the service:

```javascript
const { resolvePortalScope } = require('../services/portal-scope-service');

async function getDashboard(req, res) {
    const { from, to, orgId } = req.query;  // orgId = optional filter from UI
    const scope = await resolvePortalScope(req.portalUser);

    // If orgId specified and user has access, use it; else use full scope
    let effectiveOrgIds = scope;
    if (orgId && scope !== null) {
        if (!scope.includes(orgId)) {
            return res.status(403).json({ success: false, error: 'Access denied to this department' });
        }
        effectiveOrgIds = [orgId];
    } else if (orgId && scope === null) {
        effectiveOrgIds = [orgId]; // superadmin filtering to specific dept
    }

    const data = await portalService.getDashboardData(effectiveOrgIds, from, to);
    return res.json({ success: true, ...data });
}
```

### 5.4 Modified Controller: `portal-reports-controller.js`

Report aggregation functions (`getDailySummaryData`, `getEmployeeSummaryData`, `getApplicationUsageData`) and export handlers (`exportCSV`, `exportPDF`, `exportXLSX`) must:

1. Resolve scope via `resolvePortalScope(req.portalUser)`
2. Accept optional `orgId` query param for filtering within scope
3. Pass `orgIds` to all data queries
4. Include department name in export metadata

### 5.5 Modified Controller: `portal-app-classifications-controller.js`

- **GET**: Show classifications for assigned departments (globals + department-specific overrides)
- **POST/PUT/DELETE**: Admins can manage classifications for their assigned departments only; superadmins for all
- Accept `organizationId` param to scope operations to a specific department

### 5.6 Modified Middleware: `portal-auth.js`

Attach department scope to `req.portalUser`:

```javascript
req.portalUser = {
    userId: decoded.userId,
    orgId: decoded.orgId,       // Primary/default department
    email: decoded.email,
    role: decoded.role,
    assignedOrgIds: null        // Populated below
};

// Eagerly load department assignments for non-superadmins
if (req.portalUser.role !== 'superadmin') {
    const { data } = await supabase
        .from('portal_admin_departments')
        .select('organization_id')
        .eq('admin_user_id', decoded.userId);
    req.portalUser.assignedOrgIds = data?.map(r => r.organization_id) || [];
} else {
    req.portalUser.assignedOrgIds = null; // null = unrestricted
}
```

### 5.7 New API Endpoints

| Endpoint | Method | Role | Purpose |
|----------|--------|------|---------|
| `GET /api/portal/departments` | GET | All | List departments (scoped to assigned) |
| `GET /api/portal/departments/:id` | GET | admin+ | Department detail + member count |
| `GET /api/portal/departments/:id/members` | GET | admin+ | List members of department |
| `POST /api/portal/departments/:id/members` | POST | superadmin | Add user to department |
| `DELETE /api/portal/departments/:id/members/:userId` | DELETE | superadmin | Remove user from department |
| `GET /api/portal/admin-users/:id/departments` | GET | superadmin | List departments for an admin |
| `POST /api/portal/admin-users/:id/departments` | POST | superadmin | Assign department to admin |
| `DELETE /api/portal/admin-users/:id/departments/:orgId` | DELETE | superadmin | Remove department from admin |

### 5.8 Modified Admin Users Controller

- **Create admin user**: Accept `departmentIds[]` array. Insert rows into `portal_admin_departments`.
- **Update admin user**: Allow modifying department assignments.
- **GET admin users list**: Include assigned department names in response.
- **Relax email uniqueness for multi-dept admins**: The `portal_admin_users.email` UNIQUE constraint prevents one person from having accounts in multiple departments. Instead of creating multiple rows, use the junction table approach (single admin row + multiple dept assignments).

### 5.9 All Portal APIs Requiring Department Filtering

| Endpoint | Current Filter | Required Change |
|----------|---------------|-----------------|
| `GET /api/portal/dashboard` | None | `.in('organization_id', scopedOrgIds)` |
| `GET /api/portal/employees/list` | None | `.in('organization_id', scopedOrgIds)` on users query |
| `GET /api/portal/employees` | None | `.in('organization_id', scopedOrgIds)` on users + activity |
| `GET /api/portal/employees/:userId` | None | Validate user belongs to scoped orgs |
| `GET /api/portal/employees/:userId/logs` | None | Validate user belongs to scoped orgs |
| `GET /api/portal/time-logs` | None | `.in('organization_id', scopedOrgIds)` on activity_records |
| `GET /api/portal/reports/data` | None | `.in('organization_id', scopedOrgIds)` |
| `GET /api/portal/reports/export/csv` | None | `.in('organization_id', scopedOrgIds)` |
| `GET /api/portal/reports/export/pdf` | None | `.in('organization_id', scopedOrgIds)` |
| `GET /api/portal/reports/export/xlsx` | None | `.in('organization_id', scopedOrgIds)` |
| `GET /api/portal/app-classifications` | org_id (partial) | `.in('organization_id', scopedOrgIds)` + globals |
| `POST /api/portal/app-classifications` | org_id | Validate org in scope |
| `PUT /api/portal/app-classifications/:id` | org_id | Validate org in scope |
| `DELETE /api/portal/app-classifications/:id` | org_id | Validate org in scope |
| `GET /api/portal/admin-users` | org_id | Superadmin: all; others: 403 |

### 5.10 Query Optimization

1. **Cache department scope**: `resolvePortalScope()` runs on every request. Cache in-memory with 60s TTL keyed by `adminUserId`.

2. **`.in()` clause performance**: With 8 departments, the `.in()` filter is negligible. Even with hundreds of departments, the `organization_id` indexes on all data tables ensure fast lookups.

3. **Aggregated queries**: For "All Departments" view, omit the `.in()` filter entirely (superadmin or when all assigned depts are selected). This avoids unnecessary filtering.

---

## 6. Backend Changes — forge-app (Jira Embedded UI)

### 6.1 Forge Architecture Constraint

**Each Forge app instance is inherently single-department.** The `cloudId` from the Forge FIT token maps to exactly one organization (department). This is a platform constraint — the Forge app cannot access data from another Jira site.

**Therefore:** Cross-department features (aggregated dashboards, multi-dept reports) are **portal-only**. The forge-app needs minimal changes.

### 6.2 Changes for `organization_members.role='manager'` Activation

The `manager` role in `organization_members` is defined but functionally identical to `member`. Activating it adds department-scoped visibility within the forge-app:

#### Modified Resolvers

| Resolver | Current | Change |
|----------|---------|--------|
| `analyticsResolvers.js` (`getAllAnalytics`) | Jira Admin only | Also allow `role='manager'` with `can_view_team_analytics=true` |
| `analyticsResolvers.js` (`getProjectTeamAnalytics`) | Jira Admin or Project Admin | Also allow managers |
| `adminUserStatusResolvers.js` (`getAdminUserStatus`) | Jira Admin only | Also allow managers |
| `permissionsResolvers.js` (`getUserPermissions`) | Returns `isJiraAdmin`, `projectAdminProjects` | Also return `orgRole`, `canViewTeamAnalytics` from `organization_members` |

#### Modified `AppContext.js` (Forge Frontend)

```javascript
// Extended permissions:
{
    isJiraAdmin: false,
    projectAdminProjects: [],
    allProjectKeys: [],
    orgRole: 'manager',                // NEW — from organization_members
    canViewTeamAnalytics: true,        // NEW — from organization_members
}
```

#### Sidebar Visibility Changes

```
Current:
  Team Analytics  → isJiraAdmin OR projectAdminProjects.length > 0
  Org Analytics   → COMMENTED OUT
  User Status     → isJiraAdmin

Proposed:
  Team Analytics  → isJiraAdmin OR projectAdmin OR canViewTeamAnalytics
  Org Analytics   → isJiraAdmin OR orgRole IN ('owner','admin','manager')
  User Status     → isJiraAdmin OR orgRole IN ('owner','admin','manager')
```

### 6.3 Forge App — No Cross-Department Changes Needed

The forge-app already works correctly in a multi-department world:
- Each department has its own Jira Cloud site
- Each site has its own Forge app instance
- Data is automatically scoped by `organization_id` (set during provisioning)
- Users on ATG's Jira only see ATG data; users on Evoke's Jira only see Evoke data

---

## 7. Frontend Changes — Portal Web App

### 7.1 New Components

| Component | Purpose | Access |
|-----------|---------|--------|
| **DepartmentSelector.jsx** | Dropdown/multi-select to filter by department | All roles (scoped to assigned depts) |
| **DepartmentManagementPage.jsx** | List departments, member counts, manage assignments | superadmin |
| **DepartmentMembersModal.jsx** | View/add/remove users in a department | superadmin |
| **AdminDepartmentAssignment.jsx** | Assign departments to portal admin users | superadmin (Settings page) |

### 7.2 Department Selector Design

**`DepartmentSelector.jsx`** — Global filter in the header bar (or sidebar), persisted in localStorage:

- **superadmin**: Shows "All Departments" + all departments. Default: "All Departments"
- **admin**: Shows only assigned departments. Default: all assigned
- **viewer**: Shows only assigned departments. Default: all assigned
- Single-department admin: Auto-selected, no dropdown shown

When selection changes, all API calls include `orgId` (single) or `orgIds` (array) query parameter.

### 7.3 Existing Pages Requiring Updates

| Page | Changes |
|------|---------|
| **DashboardPage** | Respect DepartmentSelector; KPIs + charts aggregate selected department(s) |
| **EmployeesPage** | Add "Department" column showing org_name; filter by selected department(s); show department badges |
| **EmployeeDetailPage** | Show department membership; restrict access to scoped departments |
| **TimeLogsPage** | Add "Department" column; filter by selected department(s) |
| **ReportsPage** | Department filter in report config; include department in exports |
| **AppClassificationsPage** | Department filter for viewing/editing classifications; admins manage only assigned dept classifications |
| **SettingsPage** | Department assignment UI when creating/editing admin users |
| **Sidebar** | Add "Departments" nav item (superadmin only) |

### 7.4 New API Client Methods

**File:** `ai-server/src/portal/src/api/departments.js`

```javascript
export const departmentsApi = {
    list(params),                           // GET /api/portal/departments
    getDetail(id),                          // GET /api/portal/departments/:id
    listMembers(id, params),               // GET /api/portal/departments/:id/members
    addMember(id, userId),                 // POST /api/portal/departments/:id/members
    removeMember(id, userId),              // DELETE /api/portal/departments/:id/members/:userId
    getAdminDepartments(adminId),          // GET /api/portal/admin-users/:id/departments
    assignAdminDepartment(adminId, orgId), // POST /api/portal/admin-users/:id/departments
    removeAdminDepartment(adminId, orgId), // DELETE /api/portal/admin-users/:id/departments/:orgId
};
```

### 7.5 Auth Context Changes

```javascript
// Extended user object in AuthContext:
{
    id: string,
    email: string,
    displayName: string,
    role: 'superadmin' | 'admin' | 'viewer',
    orgId: string,                    // Primary department
    assignedOrgIds: string[] | null,  // null = all (superadmin)
    assignedOrgNames: string[] | null // For display
}
```

### 7.6 Department Management UI (Superadmin Only)

**DepartmentManagementPage.jsx:**
- DataTable: Department Name, Jira Instance URL, Member Count, Active Status, Actions
- Click row → modal showing department members
- "Manage Members" → modal with searchable employee list, add/remove
- No create/delete — departments are auto-provisioned from Jira Cloud sites

---

## 8. Security & Permission Matrix

### 8.1 Portal Permissions

| Resource | superadmin | admin | viewer |
|----------|-----------|-------|--------|
| **Department list** | All departments | Assigned only | Assigned only |
| **Department members** | View/Add/Remove | View only | View only |
| **Dashboard KPIs** | All depts or selected | Assigned depts | Assigned depts |
| **Employee List** | All employees | Assigned dept employees | Assigned dept employees |
| **Employee Detail** | Any employee | Assigned dept employees | Assigned dept employees |
| **Time Logs** | All logs | Assigned dept logs | Assigned dept logs |
| **Reports (view)** | All data | Assigned dept data | ❌ No access |
| **Reports (export)** | All data | Assigned dept data | ❌ No access |
| **App Classifications** | All depts + globals | Assigned dept overrides | ❌ No access |
| **Admin User Management** | Full CRUD + dept assignment | ❌ No access | ❌ No access |

### 8.2 Forge App Permissions

| Resource | Jira Admin / Owner | Org Admin | Manager | Member |
|----------|--------------------|-----------|---------|--------|
| **Own Time Analytics** | ✅ | ✅ | ✅ | ✅ |
| **Team Analytics** | ✅ All projects | ✅ All projects | ✅ (if can_view_team_analytics) | ❌ |
| **Org Analytics** | ✅ | ✅ | ✅ (scoped) | ❌ |
| **User Status** | ✅ All users | ✅ All users | ✅ (if can_view_team_analytics) | ❌ |
| **App Classifications** | ✅ Full CRUD | ✅ Full CRUD | ❌ | ❌ |
| **Unassigned Work** | ✅ Approve all | ✅ Approve all | ❌ | Own only |

### 8.3 Data Visibility Rules

| Role | Data Scope | Implementation |
|------|-----------|----------------|
| Portal superadmin | All departments | `orgIds = null` (skip filter) |
| Portal admin/viewer | Assigned departments | `orgIds = [assigned dept UUIDs]` via junction table |
| Forge owner/admin | Own department (Jira site) | Auto-scoped via `cloudId → organization_id` |
| Forge manager | Own department | Same auto-scoping + `can_view_team_analytics` gate |
| Forge member | Own data only | User-level queries only |

### 8.4 Multi-Department Employee Handling

A user in `organization_members` with rows for ATG and Wellgistics:
- Their `users.organization_id` points to their **primary** department
- They have activity records in BOTH departments (recorded during work on each Jira site)
- Portal admin assigned to ATG sees this user's ATG activity only
- Portal admin assigned to both ATG + Wellgistics sees all their activity
- Portal superadmin sees everything
- No data duplication — `activity_records.organization_id` already differentiates

### 8.5 Edge Cases

| Scenario | Behavior |
|----------|----------|
| Admin with no department assignments | Sees empty dashboards — must be assigned at least one department |
| User with no `organization_members` row | Visible only to superadmin; auto-fixed when user visits Forge app |
| Department with no employees | Shows in department list with zero metrics |
| New department auto-provisioned from Jira | Appears in portal after first user visits Forge app on that Jira site |
| Admin removed from a department | Loses access immediately; cached scope refreshes on next request |

---

## 9. Reporting & Analytics Impact

### 9.1 Dashboard KPIs

All metrics filtered by `orgIds`:
- Total Productive Hours → sum from scoped departments
- Total Non-Productive Hours → sum from scoped departments
- Productivity Rate → calculated from scoped data
- Active Employees → count of unique users in scoped departments
- Daily Trend → aggregated from scoped departments

### 9.2 Reports

| Report Type | Department Impact |
|-------------|------------------|
| Daily Summary | Aggregated per day for scoped department employees |
| Employee Summary | Only employees from scoped departments |
| Application Usage | Only sessions from scoped departments |
| Activity Logs | Only records from scoped departments |

### 9.3 Exports (CSV, PDF, XLSX)

All export handlers share `getReportDataByType()`. Adding `orgIds` filter propagates to all formats:
- PDF header includes: "Department(s): ATG, Evoke" (or "All Departments")
- CSV/XLSX add a "Department" column showing `org_name` per row

### 9.4 Cross-Department Aggregation (Superadmin)

When "All Departments" is selected:
- Employee summary shows employees from ALL departments
- An employee in multiple departments appears once with aggregated hours
- Application usage aggregates across all departments
- Daily summary combines all department data

---

## 10. Application Classification — Department-Specific Design

### 10.1 Current State — Already Supports Per-Department Classifications

The existing `application_classifications` table already supports this:

```
Global defaults (organization_id IS NULL, is_default=TRUE)  ← 208 seeds
  └── Department overrides (organization_id = ATG-uuid)
        └── Project overrides (organization_id = ATG-uuid, project_key = 'PROJ')
```

**Example already possible today:**

| Department | App | Classification |
|-----------|-----|---------------|
| (global default) | ChatGPT | non_productive |
| ATG (override) | ChatGPT | productive |
| Wellgistics | ChatGPT | (inherits global: non_productive) |

### 10.2 What Needs to Change

| Component | Change |
|-----------|--------|
| **Portal UI** | Add department selector to AppClassificationsPage — show "Global", "ATG", "Evoke" etc. Filter table by selected department. Create/Edit modal includes department selector. |
| **Portal API** | `GET /api/portal/app-classifications?orgId=X` — filter by department. Admins see only their assigned departments' overrides + globals. |
| **Forge App** | Already works — `classificationResolvers.js` queries by `organization_id` which is the department |
| **AI Pipeline** | Already works — `activity-service.js` resolves classifications using `organization_id` from the activity record |

### 10.3 No Schema Changes Needed

The `application_classifications` table already has:
- `organization_id` (nullable FK) for department-level overrides
- `project_key` for project-level overrides
- `is_default` for global defaults
- Unique indexes preventing duplicate entries per scope level

---

## 11. Employee Directory & Department Mapping

### 11.1 Current State

| Table | Purpose | Multi-Dept Support |
|-------|---------|-------------------|
| `users` | Employee records | `organization_id` = primary dept (single FK) |
| `organization_members` | User ↔ dept junction | ✅ UNIQUE(user_id, org_id) — supports many-to-many |

**`organization_members` already supports multi-department assignment.** A user can have rows in multiple departments with different roles.

### 11.2 Employee Directory Feature (Superadmin Portal)

New capabilities via existing tables:

| Action | Implementation |
|--------|---------------|
| View all employees | `SELECT * FROM users` (superadmin only) |
| View department memberships | `JOIN organization_members ON user_id` |
| Add employee to department | `INSERT INTO organization_members (user_id, organization_id, role)` |
| Remove from department | `DELETE FROM organization_members WHERE user_id AND organization_id` |
| View employee department history | `SELECT * FROM organization_members WHERE user_id ORDER BY joined_at` |

### 11.3 No Schema Changes Needed

The `organization_members` table already has:
- Many-to-many structure
- `role` per membership (owner/admin/manager/member)
- `joined_at` timestamp for history
- Granular permissions (`can_manage_settings`, etc.)

---

## 12. Forge App Impact Analysis

### 12.1 Synchronization Flow — No Changes Needed

```
User visits Jira site (ATG) → Forge FIT token includes cloudId
  → getOrCreateOrganization(cloudId) → returns ATG org row
  → getOrCreateUser(accountId, ATG-org-id)
     → Sets users.organization_id = ATG
     → Ensures organization_members row (user_id, ATG-org-id, role='member')
  → All activity captured with organization_id = ATG
```

**This flow already correctly assigns users to departments.** When a user uses a different Jira site (Evoke), a separate provisioning creates the Evoke org and membership.

### 12.2 Activity Collection — Already Department-Aware

The desktop app authenticates via Atlassian OAuth, gets the user's cloud resources, uses the first Jira site's `cloudId` to resolve the organization. All activity records are stored with that `organization_id`.

If a user switches between Jira sites (departments) during the day, their desktop app tracks to their **primary** organization. This is existing behavior and doesn't change.

### 12.3 Reporting in Forge — Already Department-Scoped

All analytics queries in `orgAnalyticsService.js` and `teamAnalyticsService.js` filter by `organization_id` from the resolved org. Each Forge instance only sees its own department's data. No change needed.

### 12.4 Classification in Forge — Already Department-Aware

`classificationResolvers.js` queries `application_classifications` with the resolved `organization_id`. Department-specific overrides are already picked up.

### 12.5 Summary: Forge Changes Required

| Area | Change Needed | Effort |
|------|--------------|--------|
| Organization provisioning | None | — |
| User provisioning | None | — |
| Activity collection | None | — |
| Analytics resolvers | Minor — allow `manager` role to view team analytics | Low |
| Classification | None | — |
| Permissions resolver | Minor — return `orgRole` from `organization_members` | Low |
| Frontend (App.js) | Minor — update sidebar visibility for manager role | Low |

---

## 13. Supabase Considerations

### 13.1 RLS Policy Updates Required

| Table | Current Policy | Change |
|-------|---------------|--------|
| `organizations` | Checks `users.organization_id` (single) | Check `organization_members` (multi) |
| `organization_members` | Checks `users.organization_id` (single) | Check `organization_members` self-join |
| `organization_settings` | Checks `users.organization_id` (single) | Check `organization_members` |
| Other tables | Various patterns | Most already use service_role (bypasses RLS) |

**Impact is limited** because the portal uses service_role key (bypasses RLS entirely). The forge-app also routes through service_role via `supabaseRequest()`. The RLS changes primarily affect direct Supabase client access from the desktop app.

### 13.2 Performance Strategy

1. **Existing indexes sufficient**: All data tables already have indexes on `organization_id`. The `.in('organization_id', orgIds)` filter uses these efficiently.

2. **No new materialized views needed**: With only 8 departments, query performance is not a concern. The `.in()` clause on a UUID column with an index is O(log n) per row.

3. **Cache department scope**: Portal middleware caches `assignedOrgIds` for 60 seconds per admin user to avoid repeated junction table lookups.

### 13.3 Recommended Indexes (New)

```sql
-- Already exist:
--   idx_org_members_user_id ON organization_members(user_id)
--   idx_org_members_org_id ON organization_members(organization_id)

-- New:
CREATE INDEX idx_portal_admin_dept_admin ON portal_admin_departments(admin_user_id);
CREATE INDEX idx_portal_admin_dept_org   ON portal_admin_departments(organization_id);
```

### 13.4 Backward Compatibility

| Area | Compatible? | Notes |
|------|------------|-------|
| Existing customer data | ✅ | No data migration needed — all data already has correct `organization_id` |
| Existing portal admins | ✅ | Migration seeds junction table from existing `org_id` — no access loss |
| Existing Forge app behavior | ✅ | No forge-app provisioning changes |
| Existing desktop app | ✅ | No desktop app changes needed |
| Existing API consumers | ✅ | New `orgId` query param is optional; omitting it preserves current behavior |
| Existing RLS policies | ✅ | Service_role bypasses RLS; updated policies are additive |

---

## 14. Implementation Roadmap

### Phase 1: Schema Updates

**Tasks:**
1. Create migration `20260602_add_portal_admin_departments.sql`
2. Create `portal_admin_departments` junction table
3. Seed junction from existing `portal_admin_users.org_id`
4. Update RLS policies on `organizations`, `organization_members`, `organization_settings`
5. Add indexes

**Dependencies:** None
**Risk:** Low — additive schema change, no existing data modified
**Effort:** Small

### Phase 2: Portal Backend Updates

**Tasks:**
1. Create `portal-scope-service.js` — department scope resolution helper
2. Modify `portal-auth.js` — attach `assignedOrgIds` to `req.portalUser`
3. Modify `portal-service.js` — add `orgIds` filtering to all 5 query methods
4. Modify `portal-controller.js` — resolve scope, pass `orgIds` to service
5. Modify `portal-reports-controller.js` — add org filtering to report data + exports
6. Modify `portal-app-classifications-controller.js` — department scope for CRUD
7. Create department management endpoints (list, members, admin assignments)
8. Modify `portal-admin-users-controller.js` — department assignment in admin CRUD
9. Write tests for all scoped queries

**Dependencies:** Phase 1
**Risk:** Medium — fixing the existing org_id bug while adding scoping
**Effort:** Medium

### Phase 3: Forge App Updates

**Tasks:**
1. Modify `permissionsResolvers.js` — return `orgRole` + `canViewTeamAnalytics`
2. Modify `analyticsResolvers.js` — allow `manager` role with team analytics permission
3. Modify `adminUserStatusResolvers.js` — allow manager access
4. Update `AppContext.js` — add `orgRole`, `canViewTeamAnalytics` to state
5. Update sidebar visibility in `App.js` for manager role
6. Uncomment and enable OrgAnalyticsTab for managers
7. Write tests for permission changes

**Dependencies:** Phase 1 (for `organization_members` role activation)
**Risk:** Low — minimal changes, additive permissions
**Effort:** Small

### Phase 4: Portal Frontend Updates

**Tasks:**
1. Create `DepartmentSelector.jsx` — global department filter
2. Create `departments.js` API client
3. Create `DepartmentManagementPage.jsx` — department list + member management
4. Update `AuthContext.jsx` — add `assignedOrgIds`, `assignedOrgNames`
5. Update `Sidebar.jsx` — add Departments nav item
6. Add `DepartmentSelector` to DashboardPage, EmployeesPage, TimeLogsPage, ReportsPage
7. Add "Department" column to EmployeesPage and TimeLogsPage tables
8. Update AppClassificationsPage — department filter for classification management
9. Update SettingsPage — department assignment UI for admin users

**Dependencies:** Phases 2
**Risk:** Medium — UI changes across many pages
**Effort:** Medium-Large

### Phase 5: Reporting Updates

**Tasks:**
1. Add department name to CSV/XLSX export rows
2. Add department metadata to PDF headers
3. Add department breakdown section to reports
4. Cross-department aggregation for superadmin "All Departments" view
5. Ensure no double-counting for multi-department employees

**Dependencies:** Phases 2 + 4
**Risk:** Low — additive data in exports
**Effort:** Small

### Phase 6: Data Migration

**Tasks:**
1. Verify existing `organization_members` data — ensure all active users have membership rows
2. Seed `portal_admin_departments` from existing admins (done in Phase 1 migration)
3. Verify existing `application_classifications` per-department overrides are correct
4. Assign initial department sets to portal admins via the new UI

**Dependencies:** Phases 1-4
**Risk:** Low — mostly verification, minimal data changes
**Effort:** Small

### Phase 7: Testing & Validation

**Tasks:**
1. Portal E2E: superadmin sees all departments, can switch between them
2. Portal E2E: admin sees only assigned departments, cannot access others
3. Portal E2E: viewer has read-only access to assigned departments
4. Report exports contain correct department-scoped data
5. App classifications: per-department overrides work correctly
6. Employee directory: multi-department users appear correctly
7. Forge app: manager role can view team analytics
8. Cross-department aggregation: no data duplication
9. Performance: verify query times with department filters
10. Backward compatibility: existing functionality unaffected

**Dependencies:** All phases
**Risk:** Medium — cross-component testing
**Effort:** Medium

### Implementation Order

```
Phase 1 (Schema) ──► Phase 2 (Portal Backend) ──► Phase 4 (Portal Frontend)
                 │                              │
                 └──► Phase 3 (Forge App) ◄─────┤──► Phase 5 (Reporting)
                                                │
                                                └──► Phase 6 (Data Migration)
                                                        │
                                                        └──► Phase 7 (Testing)
```

Phases 2 and 3 can run in parallel. Phase 4 depends on Phase 2. Phases 5 and 6 can overlap with Phase 4.

---

## 15. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| Portal `org_id` bug fix breaks existing queries | High | Medium | Fix incrementally; add org filtering alongside existing code; test each endpoint |
| Admin loses access after migration (junction table not properly seeded) | Medium | Low | Migration seeds from existing `org_id`; verify with integration test |
| Cross-department data aggregation performance | Medium | Low | Only 8 departments; existing indexes sufficient; add caching if needed |
| Portal auth middleware becomes async (scope lookup) | Medium | Medium | Cache scope resolution (60s TTL); lazy-load only when needed |
| Forge app `organization_members` RLS change breaks desktop sync | High | Low | Desktop uses service_role (bypasses RLS); test desktop app after RLS changes |
| Multi-department employee data appears in wrong department | Medium | Low | `activity_records.organization_id` already correctly scopes data; no data migration needed |
| New department auto-provisioned but portal admins unaware | Low | Medium | Add notification when new department appears; default: superadmin sees all |

---

## 16. Summary of All Changes

### New Files

| File | Purpose |
|------|---------|
| `supabase/migrations/20260602_add_portal_admin_departments.sql` | Schema: junction table + seed + RLS updates |
| `ai-server/src/services/portal-scope-service.js` | Department scope resolution for portal |
| `ai-server/src/controllers/portal-departments-controller.js` | Department management REST endpoints |
| `ai-server/tests/services/portal-scope-service.test.js` | Scope resolution tests |
| `ai-server/tests/controllers/portal-departments-controller.test.js` | Controller tests |
| `ai-server/src/portal/src/api/departments.js` | Frontend API client |
| `ai-server/src/portal/src/pages/DepartmentManagementPage.jsx` | Department list + member management |
| `ai-server/src/portal/src/components/common/DepartmentSelector.jsx` | Global department filter |

### Modified Files

#### ai-server (Portal Backend)
| File | Change |
|------|--------|
| `src/middleware/portal-auth.js` | Attach `assignedOrgIds` to `req.portalUser` |
| `src/services/portal-service.js` | Add `orgIds` filtering to all query methods |
| `src/controllers/portal-controller.js` | Resolve scope, accept `orgId` param |
| `src/controllers/portal-reports-controller.js` | Department-scoped reports + exports |
| `src/controllers/portal-app-classifications-controller.js` | Department scope for CRUD |
| `src/controllers/portal-admin-users-controller.js` | Department assignment in admin CRUD |
| `src/index.js` | Register department management routes |

#### Portal Frontend
| File | Change |
|------|--------|
| `src/portal/src/App.jsx` | Add department management route |
| `src/portal/src/contexts/AuthContext.jsx` | Add `assignedOrgIds`, `assignedOrgNames` |
| `src/portal/src/components/layout/Sidebar.jsx` | Add "Departments" nav item |
| `src/portal/src/pages/DashboardPage.jsx` | Add DepartmentSelector |
| `src/portal/src/pages/EmployeesPage.jsx` | Department column + filter |
| `src/portal/src/pages/TimeLogsPage.jsx` | Department column + filter |
| `src/portal/src/pages/ReportsPage.jsx` | Department filter in config |
| `src/portal/src/pages/AppClassificationsPage.jsx` | Department filter for classification management |
| `src/portal/src/pages/SettingsPage.jsx` | Department assignment for admin users |

#### forge-app
| File | Change |
|------|--------|
| `src/resolvers/permissionsResolvers.js` | Return `orgRole` + `canViewTeamAnalytics` |
| `src/resolvers/analyticsResolvers.js` | Allow manager role with team analytics permission |
| `src/resolvers/adminUserStatusResolvers.js` | Allow manager access |
| `static/main/src/App.js` | Update sidebar visibility for managers |
| `static/main/src/context/AppContext.js` | Add `orgRole`, `canViewTeamAnalytics` |

### Tables Created

| Table | Purpose |
|-------|---------|
| `portal_admin_departments` | Portal admin ↔ department (organization) junction — enables multi-department admin access |

### Tables Reused (No Changes)

| Table | Role in Solution |
|-------|-----------------|
| `organizations` | **IS the departments model** — no changes |
| `organization_members` | **IS the user-department junction** — no changes, multi-dept already supported |
| `application_classifications` | Already supports per-department overrides — no changes |
| `activity_records` | Already department-scoped via `organization_id` — no changes |
| `screenshots` | Already department-scoped — no changes |
| `users` | `organization_id` remains as primary department — no changes |
| `tracking_settings` | Already department-scoped — no changes |

---

*End of Technical Design Document*
