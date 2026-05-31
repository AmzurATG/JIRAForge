# App Classification Visibility — Implementation Plan

**Date:** 2026-05-29  
**Status:** Planning  
**Feature:** Desktop app publishes the list of whitelisted/blacklisted applications so users can view productive vs non-productive classifications.

---

## 1. Problem Statement

Currently, `AppClassificationManager` in `desktop_app.py` silently syncs application classifications from Supabase into a local SQLite cache and uses them to tag every activity record. The user **never sees** these classifications while the app is running. They cannot tell:

- Why an app was marked "non-productive"
- Which apps are considered "productive" for their organization
- What the current effective ruleset is (global defaults + org overrides + project overrides)
- Whether a new app they just opened is being tracked as productive or not

The requested feature is to **surface these classifications to the user**, both from the desktop app (live feedback) and from the web portal (management interface for admins).

---

## 2. Current Architecture

### 2.1 Classification Data Model

```
application_classifications (Supabase)
  ├── Tier 1: Global defaults       (organization_id IS NULL, is_default = TRUE)
  ├── Tier 2: Org-level overrides   (organization_id SET, project_key IS NULL)
  └── Tier 3: Project-level         (organization_id SET, project_key SET)

app_classifications_cache (SQLite — local per user)
  └── Merged snapshot of all 3 tiers, refreshed on sync
```

### 2.2 Classification Fields

| Field | Values | Meaning |
|---|---|---|
| `classification` | `productive`, `non_productive`, `private` | The label |
| `match_by` | `process`, `url` | How the rule matches |
| `identifier` | `chrome.exe`, `*.youtube.com`, etc. | What it matches |
| `display_name` | `Google Chrome`, `YouTube`, etc. | Human name |
| `is_default` | `true` / `false` | Global default vs custom |

### 2.3 Where Classifications Are Used

- `AppClassificationManager.classify(app_name, window_title)` is called for every window switch in `desktop_app.py`
- Result is written into `active_sessions.classification` in SQLite
- Uploaded to `activity_records.classification` in Supabase on each batch

### 2.4 What Does NOT Exist Yet

- No API endpoint to query the effective classification list for a user
- No UI (desktop or portal) to show users/admins the full list
- No tray menu item or local web page to show classification status
- No portal page for admins to manage (add/edit/delete) org-level classifications

---

## 3. Proposed Solution Overview

Three complementary surfaces are needed:

| Surface | Audience | Purpose |
|---|---|---|
| **Desktop app tray/local web** | End users (tracked employees) | See real-time classification of current app; browse full list |
| **Web portal — Classifications page** | Org admins | View and manage the org's classification rules |
| **Desktop app notification** | End users | Optionally notify when an unclassified app is first detected |

---

## 4. Phase-by-Phase Implementation Plan

---

### Phase 1: API Endpoint — Get Effective Classifications

**Goal:** Expose the merged (3-tier) classification list via the AI server so both the desktop app and portal can consume it.

#### 4.1.1 New Endpoint: `GET /api/portal/classifications`

**File:** `ai-server/src/controllers/portal-controller.js` (add handler) or new controller `classifications-controller.js`

**Request:**
```
GET /api/portal/classifications?type=process|url|all&classification=productive|non_productive|private|all
Authorization: Bearer <portal_token>
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "identifier": "code.exe",
      "display_name": "Visual Studio Code",
      "classification": "productive",
      "match_by": "process",
      "is_default": true,
      "source": "global",
      "organization_id": null,
      "project_key": null
    },
    {
      "id": "uuid",
      "identifier": "slack.exe",
      "display_name": "Slack",
      "classification": "productive",
      "match_by": "process",
      "is_default": false,
      "source": "organization",
      "organization_id": "org-uuid"
    }
  ],
  "summary": {
    "total": 208,
    "productive": 140,
    "non_productive": 48,
    "private": 20,
    "process_rules": 160,
    "url_rules": 48
  }
}
```

**Implementation notes:**
- Query strategy: fetch all 3 tiers, merge with the same precedence logic already in `AppClassificationManager.sync_classifications()` in `desktop_app.py`
- Add a `source` field (`global`, `organization`, `project`) so users can understand why a rule applies
- Filter by `organization_id` from the portal JWT — admins only see their org's effective list
- Pagination: support `page` and `limit` query params for large lists

**Security:** Requires `portalAuthMiddleware.verifyPortalToken` (same as all other `/api/portal/*` routes).

---

#### 4.1.2 New Endpoint: `GET /api/classifications/summary` (desktop app use)

This is a lighter endpoint consumed by the desktop app (authenticated via Atlassian/user JWT, not portal JWT).

**File:** `ai-server/src/controllers/activity-controller.js` or a new `classifications-controller.js`

**Request:**
```
GET /api/classifications/summary
Authorization: Bearer <supabase_jwt>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "effective_count": 215,
    "productive_count": 142,
    "non_productive_count": 51,
    "private_count": 22,
    "last_synced_at": "2026-05-29T10:00:00Z",
    "top_productive": ["code.exe", "devenv.exe", "WINWORD.EXE"],
    "top_non_productive": ["steam.exe", "epicgameslauncher.exe"]
  }
}
```

This endpoint is only a **summary** — the full list is already in the local SQLite cache. Its purpose is to power the desktop tray UI without making large network requests.

---

#### 4.1.3 CRUD Endpoints (Admin Portal)

These allow portal admins to manage org-level classifications (not global defaults):

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/portal/classifications` | List all effective classifications (merged) |
| `POST` | `/api/portal/classifications` | Create a new org-level rule |
| `PUT` | `/api/portal/classifications/:id` | Update an existing org-level rule |
| `DELETE` | `/api/portal/classifications/:id` | Delete an org-level rule (cannot delete global defaults) |

**Create/Update body:**
```json
{
  "identifier": "steam.exe",
  "displayName": "Steam",
  "classification": "non_productive",
  "matchBy": "process",
  "projectKey": null
}
```

**Validation rules:**
- `identifier` must be non-empty, max 255 chars
- `classification` must be one of `productive`, `non_productive`, `private`
- `matchBy` must be `process` or `url`
- Cannot create a duplicate `(identifier, matchBy)` at the same scope
- Cannot modify or delete `is_default = true` global entries via the portal
- URL identifiers with wildcards must use `*` only (no regex)

---

### Phase 2: Desktop App — Classification Viewer

**Goal:** Let the tracked employee see the current classification list directly from the tray menu or a local web page, without opening the full portal.

#### 4.2.1 Option A: Tray Submenu (Lightweight)

Add a **"View App Rules"** item to the tray menu. On click, open the existing local Flask web server (`http://localhost:{web_port}/classifications`).

**Tray menu change in `desktop_app.py` — `_build_tray_menu()`:**

```python
# Add a new item after the separator
menu_items.append(item("📋 View App Classifications", self._open_classifications_page))
```

```python
def _open_classifications_page(self, icon, item):
    """Open the classifications viewer page in the browser"""
    import webbrowser
    webbrowser.open(f'http://localhost:{self.web_port}/classifications')
```

#### 4.2.2 Option B: Local Web Page Served by Flask (Recommended)

The desktop app already serves a local Flask web UI (used for OAuth callback, status pages). Add a new route `/classifications` to that server.

**New Flask route in the embedded web server section of `desktop_app.py`:**

The page renders from the local `app_classifications_cache` SQLite table — **no network request needed** because the data is already synced locally.

**Page features:**
- Tab bar: **All** | **Productive** | **Non-Productive** | **Private**
- Table columns: App/Site Name, Type (Process/URL), Classification badge, Source (Global/Org/Project)
- Search box to filter by name
- Count summary at the top: "142 productive · 51 non-productive · 22 private"
- Color-coded badges: green = productive, red = non-productive, gray = private
- "Last synced" timestamp
- "Refresh" button that triggers `classification_manager.sync_classifications()`

**Data source:** Query directly from `app_classifications_cache` in SQLite via the desktop app's `db_manager` — no new API calls needed for viewing.

**Flask endpoint skeleton:**
```python
@flask_app.route('/classifications')
def classifications_page():
    """Serve the app classifications viewer page."""
    # Read from local SQLite cache
    try:
        conn = tracker.db_manager.get_connection()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT identifier, display_name, classification, match_by
            FROM app_classifications_cache
            ORDER BY classification, match_by, identifier
        ''')
        rows = cursor.fetchall()
        # Render as simple HTML page (or return JSON if using SPA)
        ...
    except Exception as e:
        return f"Error loading classifications: {e}", 500
```

The HTML template can be a simple self-contained page (inline CSS/JS) embedded as a Python string, consistent with how the existing local web pages work.

---

#### 4.2.3 Real-Time Classification Indicator (Current Window)

When the user right-clicks the tray icon, show the classification of the **currently active window** at the top of the tray menu.

**In `_build_tray_menu()` — add a status line:**

```python
# Get current classification for the topmost menu label
current_classification = self._get_current_window_classification()
if current_classification == 'productive':
    status_emoji = "🟢"
elif current_classification == 'non_productive':
    status_emoji = "🔴"
elif current_classification == 'private':
    status_emoji = "⚫"
else:
    status_emoji = "⚪"

menu_items.insert(0, item(
    lambda text: f"{status_emoji} {self._get_current_window_label()}",
    lambda: None,
    enabled=False
))
```

**Helper method `_get_current_window_classification()`:**
- Read the latest `active_sessions` row from SQLite for the current focus
- Return its `classification` value
- Falls back to `'unknown'` if no session exists

---

#### 4.2.4 Desktop Notification for Unknown Apps (Optional)

When the tracker encounters an application not in any classification tier (`classification == 'unknown'`), optionally show a **non-intrusive Windows toast notification**:

```
⚪ Unclassified app detected
"FooBar.exe" is not in your classification list.
Contact your admin to have it classified.
```

**Implementation:** Add a debounced notification in `ActiveSessionManager.on_window_switch()` — only fire once per unique `app_name`, cached in a set `self._notified_unknown_apps`.

**Throttling rules:**
- Only notify once per app per session (reset on restart)
- Only if `SHOW_UNKNOWN_APP_NOTIFICATIONS = True` (org-level setting, future)
- Suppress during the first 60 seconds after login (classification sync in progress)

---

### Phase 3: Portal Web UI — Classifications Management Page

**Goal:** Give portal admins a full management UI for viewing and overriding application classifications at the organization level.

#### 4.3.1 New Page: `ClassificationsPage.jsx`

**File:** `ai-server/src/portal/src/pages/ClassificationsPage.jsx`

**Route:** `/classifications` (add to `App.jsx`)

**Page sections:**

```
┌─────────────────────────────────────────────────────────────┐
│  App Classifications                          [+ Add Rule]  │
│                                                             │
│  [🔍 Search apps...]  [All ▼] [Process/URL ▼] [Export CSV] │
│                                                             │
│  Summary: 142 Productive · 51 Non-Productive · 22 Private  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Name           │ Identifier  │ Type  │ Class  │ Src │   │
│  ├────────────────┼─────────────┼───────┼────────┼─────┤   │
│  │ Visual Studio  │ code.exe    │ Proc  │ 🟢 Prod│ Gbl │   │
│  │ YouTube        │ youtube.com │ URL   │ 🔴 Non │ Org │   │
│  │ ...            │ ...         │ ...   │ ...    │ ... │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Note: Global defaults (Gbl) cannot be edited.             │
│  Org-level rules override global defaults.                 │
└─────────────────────────────────────────────────────────────┘
```

**Features:**
- Read-only for global defaults (show a lock icon 🔒)
- Edit/Delete actions only for org-level rules
- Filter by classification type
- Filter by match type (process vs URL)
- Search by identifier or display name
- Pagination (20 per page)
- CSV export of the full effective list

#### 4.3.2 API Module

**File:** `ai-server/src/portal/src/api/classifications.js`

```javascript
import apiClient from './client';

export const classificationsApi = {
  /**
   * Get all effective classifications (merged 3 tiers) for the org
   */
  getList: async (params = {}) => {
    const response = await apiClient.get('/api/portal/classifications', { params });
    return response.data;
  },

  /**
   * Create a new org-level classification rule
   */
  create: async (data) => {
    const response = await apiClient.post('/api/portal/classifications', data);
    return response.data;
  },

  /**
   * Update an existing org-level rule
   */
  update: async (id, data) => {
    const response = await apiClient.put(`/api/portal/classifications/${id}`, data);
    return response.data;
  },

  /**
   * Delete an org-level rule
   */
  delete: async (id) => {
    const response = await apiClient.delete(`/api/portal/classifications/${id}`);
    return response.data;
  }
};
```

#### 4.3.3 Add Route to `App.jsx`

```jsx
// In App.jsx
const ClassificationsPage = lazy(() => import('./pages/ClassificationsPage'));

// In the Route tree:
<Route path="classifications" element={<ClassificationsPage />} />
```

#### 4.3.4 Add Nav Link

**File:** `ai-server/src/portal/src/components/layout/PageWrapper.jsx` (or wherever the sidebar nav is defined)

Add:
```jsx
<NavLink to="/classifications">
  <AppWindowIcon className="w-4 h-4" />
  App Classifications
</NavLink>
```

---

### Phase 4: Sync Trigger — Desktop App Reports Unclassified Apps (Optional Enhancement)

**Goal:** When the desktop app encounters apps with `classification == 'unknown'`, it can report them to the AI server so portal admins are notified about unclassified apps in their organization.

#### 4.4.1 New API Endpoint

```
POST /api/activity/unclassified-apps
Authorization: Bearer <supabase_jwt>
Body: {
  "apps": [
    { "identifier": "foobar.exe", "displayName": "FooBar", "matchBy": "process" },
    { "identifier": "newapp.exe", "displayName": "New App", "matchBy": "process" }
  ]
}
```

This endpoint:
1. Checks if each identifier already exists in `application_classifications` for the org
2. Inserts unknown ones into a new `unclassified_apps` table (or uses a `pending_classification` flag)
3. Triggers an admin notification (if notification preferences allow)

#### 4.4.2 New Supabase Table (Optional)

```sql
CREATE TABLE IF NOT EXISTS public.pending_classifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id),
    identifier TEXT NOT NULL,
    display_name TEXT,
    match_by TEXT NOT NULL CHECK (match_by IN ('process', 'url')),
    first_seen_by UUID REFERENCES public.users(id),
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    seen_count INTEGER DEFAULT 1,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'classified', 'ignored')),
    UNIQUE (organization_id, identifier, match_by)
);
```

#### 4.4.3 Desktop App Change

In `AppClassificationManager.classify()`, when classification result is `'unknown'`, queue the app for batch reporting:

```python
# In AppClassificationManager
def __init__(self, db_manager):
    ...
    self._unknown_apps_queue = set()    # (identifier, match_by) pairs to report
    self._reported_unknowns = set()     # already reported this session

def classify(self, app_name, window_title=''):
    ...
    # If no match found, queue for reporting
    if result[0] == 'unknown' and app_name:
        key = (app_name.lower(), 'process')
        if key not in self._reported_unknowns:
            self._unknown_apps_queue.add(key)
    return result

def flush_unknown_apps(self, ai_server_url, supabase_token):
    """Report newly seen unclassified apps to the AI server."""
    if not self._unknown_apps_queue:
        return
    batch = list(self._unknown_apps_queue)
    self._unknown_apps_queue.clear()
    self._reported_unknowns.update(batch)
    # POST to /api/activity/unclassified-apps
    ...
```

---

### Phase 5: Portal Dashboard — Classifications Widget (Optional Enhancement)

Add a summary widget to the portal dashboard showing:
- Top 5 apps by time spent today (with classification badges)
- Unclassified apps count (with link to Classifications page)
- Quick classification breakdown pie chart

This reuses data already available from the `activity_records` table and the new classifications endpoint.

---

## 5. Data Flow After Implementation

```
Supabase (application_classifications)
        │
        │ sync_classifications() — called on login + every 6h
        ▼
SQLite (app_classifications_cache) — desktop local cache
        │
        ├─► AppClassificationManager.classify()
        │       └─► activity_records.classification (uploaded per batch)
        │
        ├─► Flask route /classifications
        │       └─► Desktop tray → "View App Classifications" page
        │
        └─► Tray menu — live badge on current window title

Supabase (application_classifications)
        │
        │ GET /api/portal/classifications
        ▼
Portal React App (ClassificationsPage)
        │
        ├─► View merged rules (admins)
        └─► Add / Edit / Delete org-level rules
```

---

## 6. File Change Summary

### New Files

| File | Purpose |
|---|---|
| `ai-server/src/controllers/classifications-controller.js` | CRUD + list API handlers |
| `ai-server/src/portal/src/pages/ClassificationsPage.jsx` | Portal management UI |
| `ai-server/src/portal/src/api/classifications.js` | Portal API client module |

### Modified Files

| File | Change |
|---|---|
| `ai-server/src/index.js` | Register new classification routes |
| `ai-server/src/portal/src/App.jsx` | Add `/classifications` route |
| `ai-server/src/portal/src/components/layout/PageWrapper.jsx` | Add sidebar nav link |
| `python-desktop-app/desktop_app.py` | Add tray menu item, Flask route, unknown app queueing |

### Optional New Files

| File | Purpose |
|---|---|
| `supabase/migrations/20260529_add_pending_classifications.sql` | Table for unclassified app reporting |
| `ai-server/src/controllers/activity-controller.js` | Add `reportUnclassifiedApps` handler |

---

## 7. Detailed Backend Implementation

### 7.1 `classifications-controller.js` (key logic)

```javascript
/**
 * GET /api/portal/classifications
 * Returns the effective merged classification list for the org.
 */
async function listClassifications(req, res) {
  const { orgId } = req.portalUser;
  const { type, classification, page = 1, limit = 50, search } = req.query;

  const supabase = getClient();

  // Tier 1: Global defaults
  let query = supabase
    .from('application_classifications')
    .select('*')
    .eq('is_default', true)
    .is('organization_id', null);
  const { data: globals } = await query.execute();

  // Tier 2: Org overrides
  const { data: orgRules } = await supabase
    .from('application_classifications')
    .select('*')
    .eq('organization_id', orgId)
    .is('project_key', null)
    .execute();

  // Merge: org rules override globals by (identifier, match_by)
  const merged = new Map();
  for (const row of globals) {
    merged.set(`${row.identifier}::${row.match_by}`, { ...row, source: 'global' });
  }
  for (const row of orgRules) {
    merged.set(`${row.identifier}::${row.match_by}`, { ...row, source: 'organization' });
  }

  let results = Array.from(merged.values());

  // Apply filters
  if (type && type !== 'all') results = results.filter(r => r.match_by === type);
  if (classification && classification !== 'all') {
    results = results.filter(r => r.classification === classification);
  }
  if (search) {
    const q = search.toLowerCase();
    results = results.filter(r =>
      r.identifier.toLowerCase().includes(q) ||
      (r.display_name || '').toLowerCase().includes(q)
    );
  }

  // Summary counts
  const summary = {
    total: merged.size,
    productive: [...merged.values()].filter(r => r.classification === 'productive').length,
    non_productive: [...merged.values()].filter(r => r.classification === 'non_productive').length,
    private: [...merged.values()].filter(r => r.classification === 'private').length,
    process_rules: [...merged.values()].filter(r => r.match_by === 'process').length,
    url_rules: [...merged.values()].filter(r => r.match_by === 'url').length,
  };

  // Paginate
  const total = results.length;
  const offset = (page - 1) * limit;
  const paginated = results
    .sort((a, b) => a.classification.localeCompare(b.classification) || a.identifier.localeCompare(b.identifier))
    .slice(offset, offset + parseInt(limit));

  return res.json({
    success: true,
    data: paginated,
    summary,
    pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / limit) }
  });
}

/**
 * POST /api/portal/classifications
 * Create a new org-level classification rule.
 */
async function createClassification(req, res) {
  const { orgId } = req.portalUser;
  const { identifier, displayName, classification, matchBy, projectKey = null } = req.body;

  // Input validation
  if (!identifier || !classification || !matchBy) {
    return res.status(400).json({ success: false, error: 'identifier, classification, and matchBy are required' });
  }
  if (!['productive', 'non_productive', 'private'].includes(classification)) {
    return res.status(400).json({ success: false, error: 'Invalid classification value' });
  }
  if (!['process', 'url'].includes(matchBy)) {
    return res.status(400).json({ success: false, error: 'matchBy must be process or url' });
  }

  const supabase = getClient();
  const { data, error } = await supabase
    .from('application_classifications')
    .insert({
      organization_id: orgId,
      project_key: projectKey,
      identifier: identifier.trim(),
      display_name: displayName || identifier.trim(),
      classification,
      match_by: matchBy,
      is_default: false,
      created_by: req.portalUser.email
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {  // unique violation
      return res.status(409).json({ success: false, error: 'A rule for this identifier already exists at this scope' });
    }
    throw error;
  }

  return res.status(201).json({ success: true, data });
}
```

---

## 8. Desktop App HTML Page

The local classifications viewer is a self-contained HTML page returned by the Flask route. Key design principles:
- Consistent with existing local pages (dark background, same color palette)
- Loads instantly from local SQLite — no network dependency
- Tabs for productive / non-productive / private / all
- Search filter
- Shows the timestamp of the last sync with a "Refresh Now" button

**Flask route (to add to desktop_app.py):**

```python
@flask_app.route('/classifications')
def show_classifications():
    """Display the app classification list from local SQLite cache."""
    tracker_ref = flask_app.config.get('tracker')
    if not tracker_ref:
        return "Tracker not initialized", 503

    try:
        conn = tracker_ref.db_manager.get_connection()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT identifier, display_name, classification, match_by, cached_at
            FROM app_classifications_cache
            ORDER BY classification ASC, match_by ASC, identifier ASC
        ''')
        rows = cursor.fetchall()
        
        productive = [r for r in rows if r[2] == 'productive']
        non_productive = [r for r in rows if r[2] == 'non_productive']
        private = [r for r in rows if r[2] == 'private']
        last_cached = rows[0][4] if rows else 'Never'

        # Return JSON for use by SPA-style page
        return jsonify({
            'success': True,
            'data': [
                {'identifier': r[0], 'displayName': r[1] or r[0], 'classification': r[2], 'matchBy': r[3]}
                for r in rows
            ],
            'summary': {
                'total': len(rows),
                'productive': len(productive),
                'non_productive': len(non_productive),
                'private': len(private),
                'lastSyncedAt': last_cached
            }
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
```

The actual HTML page can be a static file bundled with the app at `python-desktop-app/web/classifications.html`, served at `/classifications/ui`. The `/classifications` endpoint returns JSON consumed by that page.

---

## 9. Security Considerations

| Concern | Mitigation |
|---|---|
| Portal classification CRUD must be org-scoped | `req.portalUser.orgId` always applied as filter; no cross-org access |
| Cannot delete global defaults | `is_default = true` check in DELETE handler; return 403 |
| Identifier injection (URL wildcards) | Server-side validation: allow only `[a-zA-Z0-9.*_-]` pattern |
| Desktop page is local-only | Flask binds to `127.0.0.1` only; not exposed over LAN |
| Unknown app reporting | Only identifiers (no OCR text, no window content) sent in the report payload |

---

## 10. Testing Checklist

### Backend
- [ ] `GET /api/portal/classifications` returns merged 3-tier list
- [ ] Org-level rules override global defaults with same identifier
- [ ] Filter by `type=process` returns only process rules
- [ ] Filter by `classification=productive` returns only productive rules
- [ ] `POST` creates new org-level rule
- [ ] `POST` returns 409 on duplicate
- [ ] `PUT` updates org-level rule
- [ ] `DELETE` returns 403 when attempting to delete a global default
- [ ] All endpoints require valid portal JWT

### Desktop App
- [ ] Tray menu shows "View App Classifications" item when logged in
- [ ] Clicking opens browser at `http://localhost:{port}/classifications/ui`
- [ ] Classifications page lists all cached rules
- [ ] Tabs filter correctly by classification type
- [ ] "Last synced" timestamp is shown
- [ ] "Refresh" button triggers sync and reloads data
- [ ] Current-window classification badge shows in tray label
- [ ] Unknown app notification fires (if enabled) only once per app per session

### Portal UI
- [ ] Classifications page lists all effective rules with correct source badge
- [ ] Global defaults are read-only (edit/delete buttons disabled or hidden)
- [ ] Search works on identifier and display name
- [ ] Add Rule modal validates inputs
- [ ] Edit saves and updates list
- [ ] Delete prompts confirmation before removing

---

## 11. Out of Scope

- Per-user classification overrides (future RBAC)
- Mobile app classification viewer
- Auto-classifying unknown apps using AI/LLM
- Exporting classification rules to JSON for import into another org
- Browser extension for URL-based tracking (separate project)

---

## 12. Implementation Order (Recommended)

1. **Phase 1 first** — backend API endpoint for GET (read-only). Unblocks both desktop and portal UI work.
2. **Phase 2 (Option B)** — desktop local web page. Quick win for end users; uses already-cached local data.
3. **Phase 3** — portal management page with read + edit/create/delete.
4. **Phase 4** (optional) — unclassified app reporting. Lower priority; useful for admin operations.
5. **Phase 5** (optional) — dashboard widget. Polish pass after core features are stable.

---

**End of Implementation Plan**
