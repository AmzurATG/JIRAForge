# App Classification Web Page — Detailed Implementation Plan

**Date:** 2026-05-29  
**Feature:** Display whitelisted/blacklisted applications (productive vs non-productive) on a local web page, accessible via the system tray icon, with full project-level classification breakdown.  
**Author:** Deep-dive analysis of `desktop_app.py`, `db_connection.py`, and `AppClassificationManager`

---

## 1. Current State Analysis

### 1.1 What Already Exists

| Component | File | Status |
|---|---|---|
| Flask server at `localhost:51777` | `desktop_app.py` → `run_web_server()` | ✅ Running |
| All routes in `setup_routes()` | `desktop_app.py` line ~5634 | ✅ Exists |
| `AppClassificationManager` class | `desktop_app.py` line 4203 | ✅ Fully working |
| `app_classifications_cache` SQLite table | `db_connection.py` line ~256 | ✅ Exists |
| 3-tier sync from Supabase | `sync_classifications()` line 4314 | ✅ Works |
| `_get_known_project_keys()` | `desktop_app.py` line 7800 | ✅ Returns all user project keys |
| In-memory `process_classifications` dict | `AppClassificationManager` | ✅ Used for classify() |
| Tray menu builder | `_build_tray_menu()` line 11421 | ✅ Minimal (login + update) |
| `current_project_key` instance var | `desktop_app.py` line 5147 | ✅ Tracks current project |
| Inline HTML page pattern | `render_admin_dashboard()` line 12978 | ✅ All pages use this pattern |

### 1.2 The Core Problem in the Cache

The current `sync_classifications()` **merges all 3 tiers into one flat list** before writing to SQLite:

```python
# Current: merge first, then write — source information is LOST
merged = {}  # key=(identifier_lower, match_by) → row dict
# Tier 1 fills merged, Tier 2 overwrites, Tier 3 overwrites
cursor.execute('DELETE FROM app_classifications_cache')
for (identifier_lower, match_by), row in merged.items():
    INSERT OR REPLACE INTO app_classifications_cache
    (organization_id, identifier, display_name, classification, match_by, cached_at)
    # ↑ project_key is NEVER stored — no way to tell which tier a rule came from
```

**Consequence:** The SQLite cache cannot tell you:
- Whether a rule came from global defaults, org overrides, or which project
- What the original Tier 1 rule was before Tier 3 overrode it
- Which project-specific rule applied to a given app

**Fix required:** Store all tiers separately with `source` and `source_project_key` columns. The in-memory merge at `reload_from_cache()` stays the same.

### 1.3 Current SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS app_classifications_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT,
    project_key TEXT,            -- currently always NULL (never written)
    identifier TEXT NOT NULL,
    display_name TEXT,
    classification TEXT NOT NULL,
    match_by TEXT NOT NULL,
    cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, project_key, identifier, match_by)
)
```

---

## 2. Proposed Changes Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    IMPLEMENTATION LAYERS                      │
├──────────────────────────────────────────────────────────────┤
│  Layer 1: DB Schema Migration                                │
│  • Add `source` TEXT column to app_classifications_cache     │
│  • Use `project_key` column to store source project          │
│  • Keep 3 separate rows per rule (not merged)                │
├──────────────────────────────────────────────────────────────┤
│  Layer 2: Sync Logic Update                                  │
│  • Store each tier with source tag                           │
│  • reload_from_cache() merge logic unchanged                 │
├──────────────────────────────────────────────────────────────┤
│  Layer 3: New API Endpoint /api/classifications              │
│  • Returns JSON grouped by source (global/org/project)       │
│  • Also returns current window's live classification         │
├──────────────────────────────────────────────────────────────┤
│  Layer 4: New Flask Route /classifications                   │
│  • Full HTML page with tabs, table, search                   │
│  • Reads from local SQLite (no network needed)               │
├──────────────────────────────────────────────────────────────┤
│  Layer 5: Tray Menu Entry                                    │
│  • "View App Rules" item opens the page                      │
│  • Live classification badge for current window              │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Layer 1 — DB Schema Migration

**File:** `db_connection.py` → `_init_schema()`

### 3.1 New Schema

Replace the existing `app_classifications_cache` table definition with:

```sql
CREATE TABLE IF NOT EXISTS app_classifications_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT,
    source TEXT NOT NULL DEFAULT 'global',
        -- Values: 'global' | 'organization' | 'project'
    source_project_key TEXT,
        -- NULL for global/org; actual project key (e.g., 'ATG') for project-level
    identifier TEXT NOT NULL,
    display_name TEXT,
    classification TEXT NOT NULL,
    match_by TEXT NOT NULL,
    cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, source, source_project_key, identifier, match_by)
)
```

**Key changes:**
- `source` column (new) — stores `'global'`, `'organization'`, or `'project'`
- `source_project_key` column (renamed from `project_key`) — stores the actual project key for project-level rules only, NULL otherwise
- UNIQUE constraint updated to include `source` and `source_project_key`

### 3.2 Migration Strategy

Since this is a local SQLite file on the user's machine and the data is re-synced from Supabase on every login, the safest approach is:

```python
def _migrate_app_classifications_schema(self, conn):
    """Add source/source_project_key columns if they don't exist yet.
    Called once during _init_schema(). Safe to run on an existing DB."""
    cursor = conn.cursor()
    # Check if 'source' column already exists
    cursor.execute("PRAGMA table_info(app_classifications_cache)")
    columns = {row[1] for row in cursor.fetchall()}
    if 'source' not in columns:
        # Drop and recreate — it's a cache; data will be re-synced
        cursor.execute('DROP TABLE IF EXISTS app_classifications_cache')
        # _init_schema() will recreate it with the new definition
        conn.commit()
```

Call `_migrate_app_classifications_schema()` **before** the `CREATE TABLE IF NOT EXISTS` statement in `_init_schema()`.

---

## 4. Layer 2 — Sync Logic Update

**File:** `desktop_app.py` → `AppClassificationManager.sync_classifications()`

### 4.1 What Changes

Instead of merging into a single dict and writing flat, store each tier separately with its source tag.

### 4.2 New Storage Strategy

```python
def sync_classifications(self, supabase_client, organization_id, project_key=None, all_project_keys=None):
    """
    Fetch all 3 tiers from Supabase and write to SQLite with source labels.
    Each tier's rows are stored separately — NOT merged in DB.
    The merge happens in-memory in reload_from_cache() at classify time.
    """
    try:
        all_rows = []  # List of (source, source_project_key, row_dict) tuples

        # Tier 1: Global defaults
        result = supabase_client.table('application_classifications').select(
            'identifier, display_name, classification, match_by'
        ).eq('is_default', True).is_('organization_id', 'null').execute()
        for row in (result.data or []):
            all_rows.append(('global', None, row))

        # Tier 2: Organization overrides
        if organization_id:
            result = supabase_client.table('application_classifications').select(
                'identifier, display_name, classification, match_by'
            ).eq('organization_id', organization_id).is_('project_key', 'null').execute()
            for row in (result.data or []):
                all_rows.append(('organization', None, row))

        # Tier 3: Project overrides — one set per known project key
        project_keys_to_load = set()
        if project_key:
            project_keys_to_load.add(project_key)
        if all_project_keys:
            project_keys_to_load.update(all_project_keys)

        if organization_id and project_keys_to_load:
            for pk in project_keys_to_load:
                try:
                    result = supabase_client.table('application_classifications').select(
                        'identifier, display_name, classification, match_by'
                    ).eq('organization_id', organization_id).eq('project_key', pk).execute()
                    for row in (result.data or []):
                        all_rows.append(('project', pk, row))  # ← source_project_key = pk
                except Exception as project_err:
                    print(f"[WARN] Project-level classification fetch failed for {pk}: {project_err}")

        # Write all tiers to SQLite with source info
        conn = self.db_manager.get_connection()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM app_classifications_cache')
        for (source, source_project_key, row) in all_rows:
            cursor.execute('''
                INSERT OR REPLACE INTO app_classifications_cache
                (organization_id, source, source_project_key, identifier,
                 display_name, classification, match_by, cached_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ''', (
                organization_id,
                source,
                source_project_key,       # NULL for global/org, 'ATG' etc for project
                row['identifier'],
                row.get('display_name', ''),
                row['classification'],
                row['match_by']
            ))
        conn.commit()
        self.reload_from_cache()

    except Exception as e:
        print(f"[WARN] Failed to sync classifications from Supabase: {e}")
```

### 4.3 Update `reload_from_cache()` (Merge Logic Unchanged)

The merge precedence (project > org > global) must be preserved for in-memory dicts. The `reload_from_cache()` method reads all rows and applies the same tier precedence:

```python
def reload_from_cache(self):
    """Load classifications from SQLite into memory, applying 3-tier merge precedence.
    Source priority: global < organization < project.
    """
    # Source priority for merge: higher number = higher priority
    SOURCE_PRIORITY = {'global': 0, 'organization': 1, 'project': 2}

    new_process = {}
    new_normalized = {}
    new_url = {}
    new_wildcard = []

    try:
        conn = self.db_manager.get_connection()
        cursor = conn.cursor()
        # Order by priority: global first, project last (later writes win)
        cursor.execute('''
            SELECT identifier, classification, match_by, source
            FROM app_classifications_cache
            ORDER BY
                CASE source
                    WHEN 'global' THEN 0
                    WHEN 'organization' THEN 1
                    WHEN 'project' THEN 2
                END ASC
        ''')
        # ... rest of existing merge logic unchanged
```

---

## 5. Layer 3 — New JSON API Endpoint

**File:** `desktop_app.py` → `setup_routes()`

### 5.1 `GET /api/classifications`

Returns all classification rules grouped by source, plus current window status.

```python
@self.app.route('/api/classifications')
def api_classifications():
    """Return all cached app classifications grouped by source tier."""
    if not self.current_user:
        return jsonify({'error': 'Not authenticated'}), 401

    try:
        conn = self.db_manager.get_connection()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT identifier, display_name, classification, match_by,
                   source, source_project_key, cached_at
            FROM app_classifications_cache
            ORDER BY source, classification, match_by, identifier
        ''')
        rows = cursor.fetchall()

        # Group by source tier
        grouped = {'global': [], 'organization': [], 'project': {}}
        for (identifier, display_name, classification, match_by,
             source, source_project_key, cached_at) in rows:
            entry = {
                'identifier': identifier,
                'display_name': display_name or identifier,
                'classification': classification,
                'match_by': match_by,
                'source': source
            }
            if source == 'project':
                pk = source_project_key or 'unknown'
                if pk not in grouped['project']:
                    grouped['project'][pk] = []
                grouped['project'][pk].append(entry)
            elif source == 'organization':
                grouped['organization'].append(entry)
            else:
                grouped['global'].append(entry)

        # Current window's live classification
        current_class = None
        current_app = None
        try:
            active_conn = self.db_manager.get_connection()
            active_cursor = active_conn.cursor()
            active_cursor.execute('''
                SELECT application_name, classification
                FROM active_sessions
                ORDER BY last_seen DESC
                LIMIT 1
            ''')
            row = active_cursor.fetchone()
            if row:
                current_app, current_class = row
        except Exception:
            pass

        # Summary counts (effective merged counts — from in-memory dicts)
        total_process = len(self.classification_manager.process_classifications)
        total_url = len(self.classification_manager.url_classifications) + \
                    len(self.classification_manager.url_wildcard_patterns)
        productive_count = sum(
            1 for v in self.classification_manager.process_classifications.values()
            if v == 'productive'
        )
        non_productive_count = sum(
            1 for v in self.classification_manager.process_classifications.values()
            if v == 'non_productive'
        )

        return jsonify({
            'success': True,
            'data': grouped,
            'current_window': {
                'app': current_app,
                'classification': current_class
            },
            'summary': {
                'total_effective': total_process + total_url,
                'productive': productive_count,
                'non_productive': non_productive_count,
                'process_rules': total_process,
                'url_rules': total_url
            },
            'current_project': self.current_project_key,
            'known_projects': list(self._get_known_project_keys()),
            'last_synced': self.last_classification_sync
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500
```

### 5.2 `POST /api/classifications/refresh`

Triggers a classification sync on demand.

```python
@self.app.route('/api/classifications/refresh', methods=['POST'])
def api_classifications_refresh():
    """Trigger an on-demand sync of classification rules from Supabase."""
    if not self.current_user:
        return jsonify({'error': 'Not authenticated'}), 401
    if not self.supabase:
        return jsonify({'error': 'Not connected to Supabase'}), 503

    try:
        self.classification_manager.sync_classifications(
            self.supabase,
            self.organization_id,
            self.current_project_key,
            all_project_keys=list(self._get_known_project_keys())
        )
        self.last_classification_sync = time.time()
        return jsonify({'success': True, 'message': 'Classifications refreshed'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
```

---

## 6. Layer 4 — New Flask Route `/classifications`

**File:** `desktop_app.py` → `setup_routes()` + new `render_classifications_page()` method

### 6.1 Route Registration

Add inside `setup_routes()`, near the other user-facing routes:

```python
@self.app.route('/classifications')
def classifications_page():
    """Serve the app classifications viewer page."""
    if not self.current_user:
        return redirect('/login')
    return self.render_classifications_page()
```

### 6.2 `render_classifications_page()` Method

Add as an instance method on the `TimeTracker` class alongside `render_success_page()`, `render_admin_dashboard()`, etc. This follows the exact same pattern: returns a raw HTML string via `render_template_string`.

The page structure:

```
┌─────────────────────────────────────────────────────────┐
│  NAVBAR: "App Classifications" + [← Back] [🔄 Refresh]  │
├─────────────────────────────────────────────────────────┤
│  CURRENT WINDOW STATUS BANNER                           │
│  "🟢 Visual Studio Code — Productive (process rule)"    │
├─────────────────────────────────────────────────────────┤
│  SUMMARY ROW: [142 Productive] [51 Non-Productive] [22 Private] │
├─────────────────────────────────────────────────────────┤
│  FILTER BAR:                                            │
│  Tab: [All] [Productive] [Non-Productive] [Private]     │
│  Source: [All Sources] [Global] [Organization] [Project ▼] │
│  Project: [All Projects] [ATG] [PROJ] [DEV]            │
│  Search: [🔍 Filter by app name...]                     │
├─────────────────────────────────────────────────────────┤
│  TABLE:                                                 │
│  App / Site | Type | Classification | Source | Project  │
│  ─────────────────────────────────────────────────────  │
│  code.exe   | Process | 🟢 Productive | Global | —      │
│  steam.exe  | Process | 🔴 Non-Productive | Org   | —   │
│  slack.exe  | Process | 🟢 Productive | Project| ATG    │
│  *.yt.com   | URL     | 🔴 Non-Productive | Global| —   │
├─────────────────────────────────────────────────────────┤
│  FOOTER: Last synced: 2 minutes ago | Project: ATG      │
└─────────────────────────────────────────────────────────┘
```

### 6.3 Full HTML Template Specification

The method renders a self-contained HTML page using inline CSS and vanilla JavaScript (no external dependencies — consistent with existing pages).

#### Color Coding
| Classification | Badge Color | Dot |
|---|---|---|
| `productive` | `#28A745` (green) | 🟢 |
| `non_productive` | `#DC3545` (red) | 🔴 |
| `private` | `#6C757D` (gray) | ⚫ |
| `unknown` | `#ADB5BD` (light gray) | ⚪ |

#### Source Badges
| Source | Badge Style | Label |
|---|---|---|
| `global` | Blue outline | Global Default |
| `organization` | Purple filled | Organization |
| `project` | Orange filled | Project: ATG |

#### Page Behavior
- **Data loading**: Page loads then immediately calls `GET /api/classifications` via `fetch()`. Shows a spinner during load.
- **Tab filtering**: Pure JS — shows/hides rows client-side based on `data-classification` attribute.
- **Source filtering**: Dropdown filters by `data-source` attribute.
- **Project filtering**: Dropdown filtered by `data-project` attribute (only visible when source includes project rules).
- **Search box**: Filters by `data-identifier` attribute (case-insensitive substring match).
- **Refresh button**: Calls `POST /api/classifications/refresh` then reloads the data.
- **Auto-refresh**: Calls `/api/classifications` every 30 seconds to update current window status.

#### Project-Level Section Highlight

Project-level rules are especially important. They should be visually distinct:

```
┌─── PROJECT OVERRIDES ────────────────────────────────────┐
│  Rules specific to your project (ATG) that override       │
│  the global and organization defaults.                    │
│                                                           │
│  slack.exe  | Process | 🟢 Productive | Project: ATG     │
│  twitter.com| URL     | 🟢 Productive | Project: ATG     │
│  (twitter is non-productive globally but productive       │
│   for the social media project "ATG")                     │
└───────────────────────────────────────────────────────────┘
```

A project-level rule that OVERRIDES a global default should show a tooltip or annotation:
- "⚠️ Overrides global default (Non-Productive)"

#### Effective Rule Indicator

For each rule, show whether it is the **effective** rule (the one that actually applies after merging), or if it is overridden by a higher-tier rule:

```
twitter.com | URL | 🟢 Productive | Global Default  ← [OVERRIDDEN by Project ATG]
twitter.com | URL | 🟢 Productive | Project: ATG    ← [EFFECTIVE] ✓
```

This requires the JS to build a "merged effective map" from the loaded data and cross-reference.

---

## 7. Layer 5 — Tray Menu Entry

**File:** `desktop_app.py` → `_build_tray_menu()`

### 7.1 Add "View App Rules" Menu Item

Insert between the user label and the separator:

```python
def _build_tray_menu(self):
    """Build the tray menu with current state"""

    def get_menu_label():
        if self.current_user:
            return f"Logged in as: {self.current_user.get('email', 'User')}"
        elif self.current_user_id and self.current_user_id.startswith('anonymous_'):
            return "Anonymous (Click to Login)"
        else:
            return "Login"

    def users_action():
        if not self.current_user:
            webbrowser.open(f'http://localhost:{self.web_port}/login')

    def open_classifications():
        """Open the classification viewer page in the default browser."""
        webbrowser.open(f'http://localhost:{self.web_port}/classifications')

    # ── Current window classification indicator (read-only label) ──
    def get_current_window_label():
        """Return a label showing the current window's classification."""
        try:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()
            cursor.execute('''
                SELECT application_name, classification
                FROM active_sessions
                ORDER BY last_seen DESC LIMIT 1
            ''')
            row = cursor.fetchone()
            if row:
                app_name, classification = row
                emoji = {'productive': '🟢', 'non_productive': '🔴',
                         'private': '⚫'}.get(classification, '⚪')
                short_name = (app_name or 'Unknown')[:25]
                return f"{emoji} {short_name}"
        except Exception:
            pass
        return "⚪ No active window"

    menu_items = [
        item(lambda text: get_menu_label(), users_action),
    ]

    # Current window status (shown only when logged in and tracking)
    if self.current_user and self.tracking_active:
        menu_items.append(pystray.Menu.SEPARATOR)
        menu_items.append(item(
            lambda text: get_current_window_label(),
            lambda icon, it: None,
            enabled=False   # display-only, not clickable
        ))
        menu_items.append(item(
            "  View All App Rules...",
            lambda icon, it: open_classifications()
        ))

    menu_items.append(pystray.Menu.SEPARATOR)

    # ... existing update status items unchanged ...
```

### 7.2 Visual Layout of New Tray Menu

```
┌─────────────────────────────────┐
│ john.doe@amzur.com              │
│─────────────────────────────────│
│ 🟢 Visual Studio Code           │  ← current window classification (not clickable)
│   View All App Rules...         │  ← opens /classifications in browser
│─────────────────────────────────│
│ ✓ Up to Date (v2.8.1)          │  ← existing update item
└─────────────────────────────────┘
```

---

## 8. Implementation Sequence (Step-by-Step)

Work through these in order. Each step is independently testable.

### Step 1 — DB Schema Migration (30 min)

**File:** `db_connection.py`

1. Add `_migrate_app_classifications_schema(conn)` method that drops and recreates the `app_classifications_cache` table if the `source` column doesn't exist.
2. Update `_init_schema()` to:
   - Call the migration helper first
   - Then create the table with the new schema (`source`, `source_project_key` columns, new UNIQUE constraint)
   - Recreate indexes

**Verify:** Run `python check_db.py` or `python verify_sqlite_tables.py` to confirm new schema.

---

### Step 2 — Update `sync_classifications()` (45 min)

**File:** `desktop_app.py` → `AppClassificationManager`

1. Change the storage loop to use `(source, source_project_key, row)` tuples.
2. Write each row with its source tag.
3. Keep the `merged` in-memory dict for counts only (or remove it entirely).

**Verify:**
- After login, check the SQLite table: `python view_sqlite_db.py`
- Confirm rows exist for source='global', source='organization', source='project'
- Confirm `reload_from_cache()` still produces the same `process_classifications` dict (tests in `test_productivity_tracking_system.py`)

---

### Step 3 — Update `reload_from_cache()` (20 min)

**File:** `desktop_app.py` → `AppClassificationManager`

1. Change the SQL query to `ORDER BY CASE source WHEN 'global' THEN 0 WHEN 'organization' THEN 1 WHEN 'project' THEN 2 END ASC` so that later inserts into the in-memory dicts override earlier ones.
2. Existing classify() logic remains unchanged.

**Verify:** Run `test_productivity_tracking_system.py::TestAppClassificationManager` — all existing tests must pass.

---

### Step 4 — Add `/api/classifications` Endpoint (30 min)

**File:** `desktop_app.py` → `setup_routes()`

1. Add `GET /api/classifications` returning the grouped JSON.
2. Add `POST /api/classifications/refresh` triggering sync.

**Verify:** While app is running, call `curl http://localhost:51777/api/classifications` and confirm JSON structure.

---

### Step 5 — Add `/classifications` Page (2–3 hours)

**File:** `desktop_app.py` → add `render_classifications_page()` method + route registration in `setup_routes()`

Build the page in sub-steps:
1. **Basic table** — render the data, no filters (30 min)
2. **Tab filters** — All / Productive / Non-Productive / Private (30 min)
3. **Source & Project filters** — dropdowns using data attributes (30 min)
4. **Search box** — live filter on identifier/display_name (20 min)
5. **Current window banner** — auto-refresh every 30s (20 min)
6. **Effective rule indicator** — JS computes merged map, highlights overridden rules (30 min)
7. **Visual polish** — match existing admin dashboard dark theme (20 min)

---

### Step 6 — Update Tray Menu (30 min)

**File:** `desktop_app.py` → `_build_tray_menu()`

1. Add `open_classifications()` helper function.
2. Add current window label (disabled item).
3. Add "View All App Rules..." clickable item.
4. Add separator before update items.

**Verify:** Right-click tray → confirm items appear → click "View All App Rules..." → confirm browser opens to correct page.

---

## 9. HTML Page — Full Data Flow

```
User right-clicks tray
        │
        ▼
"View All App Rules..." clicked
        │
        ▼
webbrowser.open('http://localhost:51777/classifications')
        │
        ▼
Flask /classifications route → render_classifications_page()
        │
        ▼
Returns HTML with <script> that calls fetch('/api/classifications')
        │
        ▼
/api/classifications queries app_classifications_cache (SQLite)
No network call — data is already locally cached
        │
        ▼
JSON returned → JS builds table rows with data-* attributes
        │
        ▼
Tab/source/project/search filters work client-side
        │
        ▼
Auto-refresh every 30s (for current window status banner)
        │
        ▼
"Refresh Rules" button → POST /api/classifications/refresh
        → triggers sync_classifications() → Supabase → SQLite → reload_from_cache()
        → then fetch('/api/classifications') to reload UI
```

---

## 10. Project-Level Rules — Special Display Logic

This is the most important new capability. The UI must make project-level rules easy to understand.

### 10.1 Scenario: Project Override Changes a Global Default

Example: `twitter.com` is globally `non_productive`, but for project `ATG` (social media), it's `productive`.

The page should show **both** rows when the source filter includes all:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Identifier    │ Type │ Classification      │ Source         │ Status  │
├──────────────────────────────────────────────────────────────────────┤
│ twitter.com   │ URL  │ 🔴 Non-Productive   │ Global Default │ Overridden ↑ │
│ twitter.com   │ URL  │ 🟢 Productive       │ Project: ATG   │ ✓ Effective  │
└──────────────────────────────────────────────────────────────────────┘
```

The "Effective" flag is computed in JavaScript:

```javascript
function buildEffectiveMap(data) {
    // data.data contains {global: [...], organization: [...], project: {ATG: [...], ...}}
    const effective = {};  // key: "identifier::match_by" → highest-priority source
    const SOURCE_PRIORITY = { global: 0, organization: 1, project: 2 };

    function processRows(rows, source) {
        for (const row of rows) {
            const key = `${row.identifier}::${row.match_by}`;
            const existing = effective[key];
            if (!existing || SOURCE_PRIORITY[source] > SOURCE_PRIORITY[existing.source]) {
                effective[key] = { ...row, source };
            }
        }
    }

    processRows(data.data.global, 'global');
    processRows(data.data.organization, 'organization');
    for (const [pk, rows] of Object.entries(data.data.project || {})) {
        processRows(rows.map(r => ({...r, source_project_key: pk})), 'project');
    }

    return effective;  // maps key → effective row
}
```

### 10.2 Project Filter Behavior

When user selects a specific project (e.g., "ATG"):
- Show ONLY the **effective** rules for that project
- This means: project-level rules for ATG + org rules NOT overridden by ATG + global rules NOT overridden by org or ATG
- Add a note: "Showing effective rules as seen by project ATG"

---

## 11. Files to Modify

| File | Section | Type of Change |
|---|---|---|
| `db_connection.py` | `_init_schema()` | Add migration helper + new schema |
| `desktop_app.py` | `AppClassificationManager.sync_classifications()` | Store tiers separately with source |
| `desktop_app.py` | `AppClassificationManager.reload_from_cache()` | ORDER BY source priority |
| `desktop_app.py` | `setup_routes()` | Add 3 new routes |
| `desktop_app.py` | Add `render_classifications_page()` method | New method ~300 lines of HTML |
| `desktop_app.py` | `_build_tray_menu()` | Add 3 new menu items |

---

## 12. Edge Cases to Handle

| Scenario | Handling |
|---|---|
| User not logged in | `/classifications` redirects to `/login` |
| No classifications synced yet | Page shows "No rules loaded — click Refresh" |
| Sync fails during refresh | Show error toast, keep existing data |
| User has no project-level rules | Project section hidden; no project filter shown |
| App name is empty in cache | Fall back to showing `identifier` |
| Very large rule sets (500+) | Add pagination or virtual scroll to table |
| SQLite locked (tracking thread writing) | Use `check_same_thread=False` (already set) + try/except |
| User switches project while page is open | Auto-refresh banner detects new `current_project` |
| Classification for current window is 'unknown' | Show ⚪ "Unknown — not in rules" |

---

## 13. Testing Plan

### 13.1 Unit Tests

Add to `test_productivity_tracking_system.py`:
- `TestAppClassificationManager.test_sync_stores_source_tags` — verify source column is populated
- `TestAppClassificationManager.test_reload_respects_tier_precedence` — global overridden by project
- `TestAppClassificationManager.test_reload_from_cache_merge_order` — project beats org beats global

### 13.2 Manual Tests

1. Login → open tray → verify current window label appears
2. Click "View All App Rules..." → browser opens at `localhost:51777/classifications`
3. Confirm tab filters work (All/Productive/Non-Productive/Private)
4. Confirm project filter shows only project-level rules for current project
5. Confirm search box filters by app name
6. Click "Refresh Rules" → spinner appears → rules reload
7. Switch windows → confirm tray badge updates within 2s (next tray menu build cycle)
8. Verify overridden rules show "Overridden" badge

---

## 14. Security Considerations

- The `/classifications` page and `/api/classifications` endpoint check `self.current_user` — unauthenticated requests get a 401 or redirect to `/login`.
- All data is read from local SQLite only — no user input is written; no SQL injection risk (parameterized queries throughout).
- The page is served on `127.0.0.1` only (loopback) — not accessible from network.
- No sensitive credentials are returned — only classification labels and app names.

---

## 15. Summary of Deliverables

| # | Deliverable | File | Effort |
|---|---|---|---|
| 1 | DB schema migration for `source` + `source_project_key` | `db_connection.py` | 30 min |
| 2 | Updated `sync_classifications()` saving tiers separately | `desktop_app.py` | 45 min |
| 3 | Updated `reload_from_cache()` with ORDER BY priority | `desktop_app.py` | 20 min |
| 4 | `/api/classifications` JSON endpoint | `desktop_app.py` | 30 min |
| 5 | `/api/classifications/refresh` POST endpoint | `desktop_app.py` | 15 min |
| 6 | `/classifications` route + `render_classifications_page()` HTML | `desktop_app.py` | 2.5 hrs |
| 7 | Tray menu: current window badge + "View All App Rules..." | `desktop_app.py` | 30 min |
| 8 | Unit tests for new sync/reload behavior | `test_productivity_tracking_system.py` | 45 min |

**Total estimated effort: ~6 hours**
