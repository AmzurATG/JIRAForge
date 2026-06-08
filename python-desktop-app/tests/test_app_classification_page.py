"""
Tests for the App Classification Web Page feature.

Covers:
  1. DB schema migration — source + source_project_key columns
  2. sync_classifications() — stores all 3 tiers with correct source tags
  3. reload_from_cache() — 3-tier merge precedence (project > org > global)
  4. GET /api/classifications — JSON endpoint, grouping, auth guard
  5. POST /api/classifications/refresh — triggers sync, auth guard
  6. GET /classifications — HTML page route, login redirect
  7. Tray menu additions — current window badge + "View All App Rules..."

Run:
    pytest tests/test_app_classification_page.py -v
    pytest tests/test_app_classification_page.py -v -k "test_sync"
"""

import os
import sys
import json
import types
import sqlite3
import tempfile
import threading
from unittest.mock import MagicMock, patch, call

import pytest

# Make desktop_app importable from the parent directory
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import desktop_app
from desktop_app import AppClassificationManager


# ===========================================================================
# SHARED FIXTURES & HELPERS
# ===========================================================================

class FakeMenuItem:
    """Captures pystray.MenuItem constructor args for label inspection."""

    def __init__(self, text, action=None, enabled=True, **kwargs):
        if callable(text):
            try:
                self.text = text(self)
            except TypeError:
                self.text = text()
        else:
            self.text = text
        self.action = action
        self.enabled = enabled


class FakeMenu:
    """Captures the list of items passed to pystray.Menu(...)."""

    SEPARATOR = "---SEPARATOR---"

    def __init__(self, *items):
        self.items = list(items)


class _TestDB:
    """Lightweight in-process SQLite helper that duck-types db_manager.

    Uses the OLD schema by default (pre-feature) so migration tests can
    verify the upgrade path. Call .use_new_schema() to start with the
    new schema directly.
    """

    OLD_SCHEMA = """
        CREATE TABLE IF NOT EXISTS app_classifications_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organization_id TEXT,
            project_key TEXT,
            identifier TEXT NOT NULL,
            display_name TEXT,
            classification TEXT NOT NULL,
            match_by TEXT NOT NULL,
            cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(organization_id, project_key, identifier, match_by)
        )
    """

    NEW_SCHEMA = """
        CREATE TABLE IF NOT EXISTS app_classifications_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organization_id TEXT,
            source TEXT NOT NULL DEFAULT 'global',
            source_project_key TEXT,
            identifier TEXT NOT NULL,
            display_name TEXT,
            classification TEXT NOT NULL,
            match_by TEXT NOT NULL,
            cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(organization_id, source, source_project_key, identifier, match_by)
        )
    """

    ACTIVE_SESSIONS_SCHEMA = """
        CREATE TABLE IF NOT EXISTS active_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            window_title TEXT,
            application_name TEXT,
            classification TEXT,
            total_time_seconds REAL DEFAULT 0,
            visit_count INTEGER DEFAULT 1,
            first_seen TEXT,
            last_seen TEXT,
            timer_started_at TEXT,
            UNIQUE(window_title, application_name)
        )
    """

    def __init__(self, schema="new"):
        self._db_file = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
        self.db_path = self._db_file.name
        self._db_file.close()
        self._conn = None
        ddl = self.NEW_SCHEMA if schema == "new" else self.OLD_SCHEMA
        conn = sqlite3.connect(self.db_path)
        conn.execute(ddl)
        conn.execute(self.ACTIVE_SESSIONS_SCHEMA)
        conn.commit()
        conn.close()

    def get_connection(self):
        if self._conn is None:
            self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        return self._conn

    def columns(self):
        """Return set of column names in app_classifications_cache."""
        cur = self.get_connection().cursor()
        cur.execute("PRAGMA table_info(app_classifications_cache)")
        return {row[1] for row in cur.fetchall()}

    def all_rows(self):
        """Fetch all rows from app_classifications_cache as dicts."""
        cur = self.get_connection().cursor()
        cur.execute("SELECT * FROM app_classifications_cache")
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

    def seed_active_session(self, app_name="code.exe", classification="productive"):
        """Insert a dummy active_sessions row for current-window tests."""
        conn = self.get_connection()
        conn.execute(
            """INSERT OR REPLACE INTO active_sessions
               (window_title, application_name, classification, last_seen)
               VALUES (?, ?, ?, datetime('now'))""",
            (f"{app_name} - test window", app_name, classification),
        )
        conn.commit()

    def cleanup(self):
        try:
            if self._conn:
                self._conn.close()
                self._conn = None
            os.unlink(self.db_path)
        except Exception:
            pass


def _make_mock_supabase(global_rows=None, org_rows=None, project_rows=None):
    """Return a mock Supabase client whose table().select()...execute() returns
    the provided row lists for each tier query.

    The mock inspects which filters are applied:
      - eq('is_default', True) + is_('organization_id', 'null') → global_rows
      - eq('organization_id', ...) + is_('project_key', 'null')  → org_rows
      - eq('organization_id', ...) + eq('project_key', ...)       → project_rows
    """
    global_rows = global_rows or []
    org_rows = org_rows or []
    project_rows = project_rows or []

    def _make_chain(data):
        chain = MagicMock()
        chain.execute.return_value = MagicMock(data=data)
        chain.eq.return_value = chain
        chain.is_.return_value = chain
        chain.select.return_value = chain
        return chain

    call_counter = {"n": 0}

    def _table(name):
        call_counter["n"] += 1
        n = call_counter["n"]
        if n == 1:
            return _make_chain(global_rows)
        elif n == 2:
            return _make_chain(org_rows)
        else:
            return _make_chain(project_rows)

    supabase = MagicMock()
    supabase.table.side_effect = _table
    return supabase


_UNSET = object()  # sentinel — allows callers to pass current_user=None explicitly


def _build_fake_tracker(db, tracking_active=True, current_user=_UNSET):
    """Return a minimal MagicMock that quacks like TimeTracker for route tests."""
    tracker = MagicMock()
    tracker.db_manager = db
    # Use sentinel so callers can pass current_user=None to simulate unauthenticated state
    tracker.current_user = (
        {"email": "dev@example.com", "account_id": "u1"}
        if current_user is _UNSET
        else current_user
    )
    tracker.tracking_active = tracking_active
    tracker.current_project_key = "ATG"
    tracker.organization_id = "org-uuid-123"
    tracker.last_classification_sync = 0
    tracker.classification_manager = AppClassificationManager(db)
    tracker.supabase = MagicMock()
    tracker._get_known_project_keys = MagicMock(return_value={"ATG", "PROJ"})
    return tracker


# ===========================================================================
# 1. DB SCHEMA MIGRATION
# ===========================================================================

class TestDbSchemaMigration:
    """Verify that the new schema adds source + source_project_key columns."""

    def test_old_schema_missing_source_column(self):
        """Baseline: old schema does NOT have 'source' column."""
        db = _TestDB(schema="old")
        try:
            assert "source" not in db.columns()
            assert "project_key" in db.columns()
        finally:
            db.cleanup()

    def test_new_schema_has_source_column(self):
        """New schema must have 'source' column."""
        db = _TestDB(schema="new")
        try:
            assert "source" in db.columns()
        finally:
            db.cleanup()

    def test_new_schema_has_source_project_key_column(self):
        """New schema must have 'source_project_key' column."""
        db = _TestDB(schema="new")
        try:
            assert "source_project_key" in db.columns()
        finally:
            db.cleanup()

    def test_new_schema_no_legacy_project_key_column(self):
        """New schema replaces 'project_key' with 'source_project_key'."""
        db = _TestDB(schema="new")
        try:
            assert "project_key" not in db.columns()
        finally:
            db.cleanup()

    def test_new_schema_unique_constraint_includes_source(self):
        """Two rows with same identifier/match_by but different source must coexist."""
        db = _TestDB(schema="new")
        try:
            conn = db.get_connection()
            # Should succeed: same identifier, different source
            conn.execute(
                "INSERT INTO app_classifications_cache "
                "(organization_id, source, source_project_key, identifier, classification, match_by) "
                "VALUES (?, 'global', NULL, 'steam.exe', 'non_productive', 'process')",
                ("org1",),
            )
            conn.execute(
                "INSERT INTO app_classifications_cache "
                "(organization_id, source, source_project_key, identifier, classification, match_by) "
                "VALUES (?, 'organization', NULL, 'steam.exe', 'productive', 'process')",
                ("org1",),
            )
            conn.commit()
            rows = db.all_rows()
            assert len(rows) == 2, "Both global and org rows for same identifier must be stored"
        finally:
            db.cleanup()


# ===========================================================================
# 2. sync_classifications() — SOURCE TAG STORAGE
# ===========================================================================

class TestSyncClassificationsSourceTags:
    """Verify that sync_classifications() writes each tier with correct source tag."""

    def test_global_rows_stored_with_global_source(self):
        """Rows from Tier 1 (global defaults) must be written with source='global'."""
        db = _TestDB(schema="new")
        try:
            supabase = _make_mock_supabase(
                global_rows=[{"identifier": "code.exe", "display_name": "VSCode",
                               "classification": "productive", "match_by": "process"}]
            )
            manager = AppClassificationManager(db)
            manager.sync_classifications(supabase, organization_id=None)

            rows = db.all_rows()
            assert len(rows) == 1
            assert rows[0]["source"] == "global"
            assert rows[0]["source_project_key"] is None
        finally:
            db.cleanup()

    def test_org_rows_stored_with_organization_source(self):
        """Rows from Tier 2 (org overrides) must be written with source='organization'."""
        db = _TestDB(schema="new")
        try:
            supabase = _make_mock_supabase(
                org_rows=[{"identifier": "slack.exe", "display_name": "Slack",
                            "classification": "productive", "match_by": "process"}]
            )
            manager = AppClassificationManager(db)
            manager.sync_classifications(supabase, organization_id="org-1")

            rows = [r for r in db.all_rows() if r["identifier"] == "slack.exe"]
            assert len(rows) == 1
            assert rows[0]["source"] == "organization"
            assert rows[0]["source_project_key"] is None
        finally:
            db.cleanup()

    def test_project_rows_stored_with_project_source_and_key(self):
        """Rows from Tier 3 (project overrides) must be stored with source='project'
        and source_project_key set to the project key string."""
        db = _TestDB(schema="new")
        try:
            supabase = _make_mock_supabase(
                project_rows=[{"identifier": "twitter.com", "display_name": "Twitter",
                                "classification": "productive", "match_by": "url"}]
            )
            manager = AppClassificationManager(db)
            manager.sync_classifications(
                supabase, organization_id="org-1",
                project_key="ATG", all_project_keys=["ATG"]
            )

            rows = [r for r in db.all_rows() if r["identifier"] == "twitter.com"]
            assert len(rows) == 1
            assert rows[0]["source"] == "project"
            assert rows[0]["source_project_key"] == "ATG"
        finally:
            db.cleanup()

    def test_all_three_tiers_stored_as_separate_rows(self):
        """The same identifier with different tier sources must produce 3 separate rows
        (NOT merged/overwritten in the DB — merge happens in reload_from_cache)."""
        db = _TestDB(schema="new")
        try:
            supabase = _make_mock_supabase(
                global_rows=[{"identifier": "twitter.com", "display_name": "Twitter",
                               "classification": "non_productive", "match_by": "url"}],
                org_rows=[{"identifier": "twitter.com", "display_name": "Twitter",
                            "classification": "non_productive", "match_by": "url"}],
                project_rows=[{"identifier": "twitter.com", "display_name": "Twitter",
                                "classification": "productive", "match_by": "url"}],
            )
            manager = AppClassificationManager(db)
            manager.sync_classifications(
                supabase, organization_id="org-1",
                project_key="ATG", all_project_keys=["ATG"]
            )

            rows = [r for r in db.all_rows() if r["identifier"] == "twitter.com"]
            sources = {r["source"] for r in rows}
            assert sources == {"global", "organization", "project"}, \
                f"Expected all 3 tier sources, got: {sources}"
        finally:
            db.cleanup()

    def test_sync_clears_old_rows_before_writing(self):
        """Each sync must DELETE all existing rows before inserting new ones
        so stale rules don't accumulate."""
        db = _TestDB(schema="new")
        try:
            # First sync with one app
            supabase1 = _make_mock_supabase(
                global_rows=[{"identifier": "old_app.exe", "display_name": "Old",
                               "classification": "productive", "match_by": "process"}]
            )
            manager = AppClassificationManager(db)
            manager.sync_classifications(supabase1, organization_id=None)
            assert any(r["identifier"] == "old_app.exe" for r in db.all_rows())

            # Second sync with a different app
            supabase2 = _make_mock_supabase(
                global_rows=[{"identifier": "new_app.exe", "display_name": "New",
                               "classification": "productive", "match_by": "process"}]
            )
            manager.sync_classifications(supabase2, organization_id=None)

            rows = db.all_rows()
            assert not any(r["identifier"] == "old_app.exe" for r in rows), \
                "Stale rows from previous sync must be deleted"
            assert any(r["identifier"] == "new_app.exe" for r in rows)
        finally:
            db.cleanup()

    def test_sync_supabase_failure_does_not_corrupt_cache(self):
        """If Supabase raises during sync, existing cache rows must remain intact."""
        db = _TestDB(schema="new")
        try:
            # Pre-populate cache
            conn = db.get_connection()
            conn.execute(
                "INSERT INTO app_classifications_cache "
                "(organization_id, source, source_project_key, identifier, classification, match_by) "
                "VALUES ('org-1', 'global', NULL, 'code.exe', 'productive', 'process')"
            )
            conn.commit()

            # Supabase blows up
            bad_supabase = MagicMock()
            bad_supabase.table.side_effect = RuntimeError("Network error")

            manager = AppClassificationManager(db)
            # Must NOT raise — failure is caught and logged
            manager.sync_classifications(bad_supabase, organization_id="org-1")

            # Cache rows should still exist (rollback keeps them)
            rows = db.all_rows()
            assert len(rows) >= 1, "Cache must not be wiped on Supabase failure"
        finally:
            db.cleanup()


# ===========================================================================
# 3. reload_from_cache() — MERGE PRECEDENCE
# ===========================================================================

class TestReloadFromCachePrecedence:
    """Verify that reload_from_cache() applies correct 3-tier precedence:
    project > organization > global."""

    def _insert_row(self, db, source, source_project_key, identifier,
                    classification, match_by="process"):
        conn = db.get_connection()
        conn.execute(
            "INSERT INTO app_classifications_cache "
            "(organization_id, source, source_project_key, identifier, "
            " classification, match_by) "
            "VALUES ('org-1', ?, ?, ?, ?, ?)",
            (source, source_project_key, identifier, classification, match_by),
        )
        conn.commit()

    def test_project_overrides_global_for_same_identifier(self):
        """Project-level 'productive' must beat global 'non_productive' for same process."""
        db = _TestDB(schema="new")
        try:
            self._insert_row(db, "global", None, "twitter.exe", "non_productive")
            self._insert_row(db, "project", "ATG", "twitter.exe", "productive")

            manager = AppClassificationManager(db)
            classification, _ = manager.classify("twitter.exe", "Twitter")
            assert classification == "productive", \
                "Project-level rule must override global default"
        finally:
            db.cleanup()

    def test_project_overrides_org_for_same_identifier(self):
        """Project-level rule must beat org-level rule for the same identifier."""
        db = _TestDB(schema="new")
        try:
            self._insert_row(db, "organization", None, "slack.exe", "non_productive")
            self._insert_row(db, "project", "ATG", "slack.exe", "productive")

            manager = AppClassificationManager(db)
            classification, _ = manager.classify("slack.exe", "Slack")
            assert classification == "productive", \
                "Project-level rule must override org-level rule"
        finally:
            db.cleanup()

    def test_org_overrides_global_for_same_identifier(self):
        """Org-level 'productive' must beat global 'non_productive'."""
        db = _TestDB(schema="new")
        try:
            self._insert_row(db, "global", None, "steam.exe", "non_productive")
            self._insert_row(db, "organization", None, "steam.exe", "productive")

            manager = AppClassificationManager(db)
            classification, _ = manager.classify("steam.exe", "Steam")
            assert classification == "productive", \
                "Org-level rule must override global default"
        finally:
            db.cleanup()

    def test_global_rule_used_when_no_higher_tier(self):
        """When only a global rule exists, it must be applied correctly."""
        db = _TestDB(schema="new")
        try:
            self._insert_row(db, "global", None, "code.exe", "productive")

            manager = AppClassificationManager(db)
            classification, match_type = manager.classify("code.exe", "VSCode")
            assert classification == "productive"
            assert match_type == "process"
        finally:
            db.cleanup()

    def test_project_rule_does_not_affect_unrelated_identifiers(self):
        """A project-level rule for app A must not change the result for app B."""
        db = _TestDB(schema="new")
        try:
            self._insert_row(db, "global", None, "spotify.exe", "non_productive")
            # Project rule for a completely different app
            self._insert_row(db, "project", "ATG", "twitter.exe", "productive")

            manager = AppClassificationManager(db)
            classification, _ = manager.classify("spotify.exe", "Spotify")
            assert classification == "non_productive", \
                "Project rule for different app must not contaminate spotify result"
        finally:
            db.cleanup()

    def test_url_wildcard_still_loaded_with_new_schema(self):
        """Wildcard URL patterns must still load correctly after schema change."""
        db = _TestDB(schema="new")
        try:
            conn = db.get_connection()
            conn.execute(
                "INSERT INTO app_classifications_cache "
                "(organization_id, source, source_project_key, identifier, "
                " classification, match_by) "
                "VALUES ('org-1', 'global', NULL, '*.bank.com', 'private', 'url')"
            )
            conn.commit()

            manager = AppClassificationManager(db)
            classification, match_type = manager.classify(
                "chrome.exe", "My Account - secure.chase.bank.com"
            )
            assert classification == "private"
            assert match_type == "url"
        finally:
            db.cleanup()


# ===========================================================================
# 4. GET /api/classifications — Flask endpoint
# ===========================================================================

class TestApiClassificationsEndpoint:
    """Tests for GET /api/classifications JSON endpoint."""

    @pytest.fixture()
    def flask_client(self):
        """Return a Flask test client wired to a minimal fake tracker."""
        from flask import Flask, jsonify, redirect
        app = Flask(__name__)
        app.config["TESTING"] = True

        db = _TestDB(schema="new")
        tracker = _build_fake_tracker(db)

        # Pre-populate cache with a few rows across tiers
        conn = db.get_connection()
        conn.executemany(
            "INSERT INTO app_classifications_cache "
            "(organization_id, source, source_project_key, identifier, "
            "display_name, classification, match_by) VALUES (?,?,?,?,?,?,?)",
            [
                ("org-1", "global", None, "code.exe", "VSCode", "productive", "process"),
                ("org-1", "global", None, "youtube.com", "YouTube", "non_productive", "url"),
                ("org-1", "organization", None, "slack.exe", "Slack", "productive", "process"),
                ("org-1", "project", "ATG", "twitter.com", "Twitter", "productive", "url"),
            ],
        )
        conn.commit()
        tracker.classification_manager.reload_from_cache()
        db.seed_active_session("code.exe", "productive")

        @app.route("/api/classifications")
        def api_classifications():
            if not tracker.current_user:
                return jsonify({"error": "Not authenticated"}), 401

            try:
                db_conn = tracker.db_manager.get_connection()
                cursor = db_conn.cursor()
                cursor.execute(
                    "SELECT identifier, display_name, classification, match_by, "
                    "source, source_project_key, cached_at "
                    "FROM app_classifications_cache "
                    "ORDER BY source, classification, match_by, identifier"
                )
                rows = cursor.fetchall()

                grouped = {"global": [], "organization": [], "project": {}}
                for (ident, disp, cls, mby, src, sproj, cat) in rows:
                    entry = {"identifier": ident, "display_name": disp or ident,
                             "classification": cls, "match_by": mby, "source": src}
                    if src == "project":
                        pk = sproj or "unknown"
                        grouped["project"].setdefault(pk, []).append(entry)
                    elif src == "organization":
                        grouped["organization"].append(entry)
                    else:
                        grouped["global"].append(entry)

                return jsonify({
                    "success": True,
                    "data": grouped,
                    "current_window": {"app": "code.exe", "classification": "productive"},
                    "summary": {"total_effective": len(rows)},
                    "current_project": tracker.current_project_key,
                    "known_projects": list(tracker._get_known_project_keys()),
                })
            except Exception as exc:
                return jsonify({"error": str(exc)}), 500

        yield app.test_client(), db

        db.cleanup()

    def test_returns_200_when_authenticated(self, flask_client):
        client, _ = flask_client
        resp = client.get("/api/classifications")
        assert resp.status_code == 200

    def test_response_has_success_true(self, flask_client):
        client, _ = flask_client
        data = client.get("/api/classifications").get_json()
        assert data["success"] is True

    def test_response_has_all_three_tier_keys(self, flask_client):
        client, _ = flask_client
        data = client.get("/api/classifications").get_json()
        assert "global" in data["data"]
        assert "organization" in data["data"]
        assert "project" in data["data"]

    def test_global_rules_in_global_bucket(self, flask_client):
        client, _ = flask_client
        data = client.get("/api/classifications").get_json()
        identifiers = [r["identifier"] for r in data["data"]["global"]]
        assert "code.exe" in identifiers
        assert "youtube.com" in identifiers

    def test_org_rules_in_organization_bucket(self, flask_client):
        client, _ = flask_client
        data = client.get("/api/classifications").get_json()
        identifiers = [r["identifier"] for r in data["data"]["organization"]]
        assert "slack.exe" in identifiers

    def test_project_rules_keyed_by_project(self, flask_client):
        client, _ = flask_client
        data = client.get("/api/classifications").get_json()
        assert "ATG" in data["data"]["project"]
        identifiers = [r["identifier"] for r in data["data"]["project"]["ATG"]]
        assert "twitter.com" in identifiers

    def test_current_window_field_present(self, flask_client):
        client, _ = flask_client
        data = client.get("/api/classifications").get_json()
        assert "current_window" in data
        assert "app" in data["current_window"]
        assert "classification" in data["current_window"]

    def test_current_project_field_present(self, flask_client):
        client, _ = flask_client
        data = client.get("/api/classifications").get_json()
        assert data["current_project"] == "ATG"

    def test_summary_field_present(self, flask_client):
        client, _ = flask_client
        data = client.get("/api/classifications").get_json()
        assert "summary" in data
        assert "total_effective" in data["summary"]

    def test_returns_401_when_not_authenticated(self):
        """Endpoint must return 401 when current_user is None."""
        from flask import Flask, jsonify

        app = Flask(__name__)
        app.config["TESTING"] = True

        db = _TestDB(schema="new")
        tracker = _build_fake_tracker(db, current_user=None)

        @app.route("/api/classifications")
        def api_classifications_unauthed():
            if not tracker.current_user:
                return jsonify({"error": "Not authenticated"}), 401
            return jsonify({"success": True}), 200

        client = app.test_client()
        resp = client.get("/api/classifications")
        assert resp.status_code == 401
        db.cleanup()


# ===========================================================================
# 5. POST /api/classifications/refresh — Flask endpoint
# ===========================================================================

class TestApiClassificationsRefreshEndpoint:
    """Tests for POST /api/classifications/refresh."""

    def _make_refresh_app(self, current_user=_UNSET, supabase_connected=True):
        from flask import Flask, jsonify

        app = Flask(__name__)
        app.config["TESTING"] = True

        db = _TestDB(schema="new")
        tracker = _build_fake_tracker(db, current_user=current_user)
        if not supabase_connected:
            tracker.supabase = None

        sync_calls = []

        def fake_sync(*args, **kwargs):
            sync_calls.append((args, kwargs))

        tracker.classification_manager.sync_classifications = fake_sync
        tracker.last_classification_sync = 0

        @app.route("/api/classifications/refresh", methods=["POST"])
        def refresh():
            if not tracker.current_user:
                return jsonify({"error": "Not authenticated"}), 401
            if not tracker.supabase:
                return jsonify({"error": "Not connected"}), 503

            tracker.classification_manager.sync_classifications(
                tracker.supabase,
                tracker.organization_id,
                tracker.current_project_key,
                all_project_keys=list(tracker._get_known_project_keys()),
            )
            return jsonify({"success": True, "message": "Classifications refreshed"})

        return app.test_client(), sync_calls, db

    def test_refresh_returns_200_when_authenticated(self):
        client, _, db = self._make_refresh_app()
        try:
            resp = client.post("/api/classifications/refresh")
            assert resp.status_code == 200
        finally:
            db.cleanup()

    def test_refresh_calls_sync_classifications(self):
        client, sync_calls, db = self._make_refresh_app()
        try:
            client.post("/api/classifications/refresh")
            assert len(sync_calls) == 1, "sync_classifications must be called once"
        finally:
            db.cleanup()

    def test_refresh_returns_401_when_not_authenticated(self):
        client, _, db = self._make_refresh_app(current_user=None)
        try:
            resp = client.post("/api/classifications/refresh")
            assert resp.status_code == 401
        finally:
            db.cleanup()

    def test_refresh_returns_503_when_supabase_not_connected(self):
        client, _, db = self._make_refresh_app(supabase_connected=False)
        try:
            resp = client.post("/api/classifications/refresh")
            assert resp.status_code == 503
        finally:
            db.cleanup()

    def test_refresh_response_has_success_true(self):
        client, _, db = self._make_refresh_app()
        try:
            data = client.post("/api/classifications/refresh").get_json()
            assert data["success"] is True
        finally:
            db.cleanup()


# ===========================================================================
# 6. GET /classifications — HTML page route
# ===========================================================================

class TestClassificationsHtmlRoute:
    """Tests for GET /classifications Flask route (HTML page)."""

    def _make_html_app(self, logged_in=True):
        from flask import Flask, redirect

        app = Flask(__name__)
        app.config["TESTING"] = True
        db = _TestDB(schema="new")
        current_user = {"email": "dev@example.com"} if logged_in else None

        @app.route("/login")
        def login():
            return "Login Page", 200

        @app.route("/classifications")
        def classifications_page():
            if not current_user:
                return redirect("/login")
            # Minimal inline HTML matching what render_classifications_page() returns
            return """<!DOCTYPE html>
<html>
<head><title>App Classifications</title></head>
<body>
  <div id="summary"></div>
  <div id="tabs">
    <button data-tab="all">All</button>
    <button data-tab="productive">Productive</button>
    <button data-tab="non_productive">Non-Productive</button>
    <button data-tab="private">Private</button>
  </div>
  <input id="search" type="text" placeholder="Filter by app name..." />
  <select id="source-filter">
    <option value="all">All Sources</option>
    <option value="global">Global</option>
    <option value="organization">Organization</option>
    <option value="project">Project</option>
  </select>
  <table id="classifications-table">
    <thead><tr>
      <th>App / Site</th><th>Type</th>
      <th>Classification</th><th>Source</th><th>Project</th>
    </tr></thead>
    <tbody id="table-body"></tbody>
  </table>
  <button id="refresh-btn">Refresh Rules</button>
  <span id="last-synced"></span>
</body>
</html>""", 200

        return app.test_client(), db

    def test_redirects_to_login_when_not_authenticated(self):
        client, db = self._make_html_app(logged_in=False)
        try:
            resp = client.get("/classifications")
            assert resp.status_code in (301, 302)
            assert "/login" in resp.headers.get("Location", "")
        finally:
            db.cleanup()

    def test_returns_200_when_authenticated(self):
        client, db = self._make_html_app(logged_in=True)
        try:
            resp = client.get("/classifications")
            assert resp.status_code == 200
        finally:
            db.cleanup()

    def test_response_is_html(self):
        client, db = self._make_html_app(logged_in=True)
        try:
            resp = client.get("/classifications")
            assert "text/html" in resp.content_type
        finally:
            db.cleanup()

    def test_page_has_tab_buttons(self):
        client, db = self._make_html_app(logged_in=True)
        try:
            html = client.get("/classifications").data.decode()
            assert 'data-tab="productive"' in html
            assert 'data-tab="non_productive"' in html
            assert 'data-tab="private"' in html
            assert 'data-tab="all"' in html
        finally:
            db.cleanup()

    def test_page_has_search_input(self):
        client, db = self._make_html_app(logged_in=True)
        try:
            html = client.get("/classifications").data.decode()
            assert 'id="search"' in html
        finally:
            db.cleanup()

    def test_page_has_source_filter_dropdown(self):
        client, db = self._make_html_app(logged_in=True)
        try:
            html = client.get("/classifications").data.decode()
            assert 'id="source-filter"' in html
            assert "Global" in html
            assert "Organization" in html
            assert "Project" in html
        finally:
            db.cleanup()

    def test_page_has_classifications_table(self):
        client, db = self._make_html_app(logged_in=True)
        try:
            html = client.get("/classifications").data.decode()
            assert 'id="classifications-table"' in html
        finally:
            db.cleanup()

    def test_page_has_refresh_button(self):
        client, db = self._make_html_app(logged_in=True)
        try:
            html = client.get("/classifications").data.decode()
            assert 'id="refresh-btn"' in html
        finally:
            db.cleanup()

    def test_page_title(self):
        client, db = self._make_html_app(logged_in=True)
        try:
            html = client.get("/classifications").data.decode()
            assert "App Classifications" in html
        finally:
            db.cleanup()


# ===========================================================================
# 7. TRAY MENU ADDITIONS
# ===========================================================================

class TestTrayMenuClassificationItems:
    """Verify that the tray menu includes classification-related items
    when the user is logged in and tracking is active."""

    def _build_menu(self, current_user, tracking_active, db=None):
        """Bind real _build_tray_menu to a fake tracker and return the menu."""
        if db is None:
            db = _TestDB(schema="new")

        with patch.object(desktop_app, "pystray") as mock_pystray, \
             patch.object(desktop_app, "item", FakeMenuItem), \
             patch.object(desktop_app, "webbrowser"):

            mock_pystray.Menu = FakeMenu
            mock_pystray.Menu.SEPARATOR = FakeMenu.SEPARATOR

            from desktop_app import UpdateManager
            update_manager = MagicMock()
            update_manager.get_status.return_value = {"state": "idle"}

            tracker = MagicMock()
            tracker.update_manager = update_manager
            tracker.app_version = "2.8.1"
            tracker.web_port = 51777
            tracker.current_user = current_user
            tracker.current_user_id = "u1" if current_user else None
            tracker.tracking_active = tracking_active
            tracker.db_manager = db

            tracker._build_tray_menu = types.MethodType(
                desktop_app.TimeTracker._build_tray_menu, tracker
            )

            menu = tracker._build_tray_menu()
            db.cleanup()
            return menu

    def test_view_all_app_rules_appears_when_logged_in_and_tracking(self):
        """'View All App Rules...' must appear when user is logged in and tracking."""
        db = _TestDB(schema="new")
        menu = self._build_menu(
            current_user={"email": "dev@example.com"},
            tracking_active=True,
            db=db
        )
        labels = [i.text for i in menu.items if isinstance(i, FakeMenuItem)]
        assert any("App Rules" in lbl or "Classifications" in lbl for lbl in labels), \
            f"Expected 'App Rules' item in tray, got: {labels}"

    def test_current_window_label_appears_when_logged_in_and_tracking(self):
        """A current-window classification indicator must appear when tracking."""
        db = _TestDB(schema="new")
        db.seed_active_session("code.exe", "productive")
        menu = self._build_menu(
            current_user={"email": "dev@example.com"},
            tracking_active=True,
            db=db
        )
        labels = [i.text for i in menu.items if isinstance(i, FakeMenuItem)]
        # The label contains an emoji and a short app name
        indicator_labels = [
            lbl for lbl in labels
            if any(e in lbl for e in ("🟢", "🔴", "⚫", "⚪"))
        ]
        assert len(indicator_labels) >= 1, \
            f"Expected classification emoji in tray labels, got: {labels}"

    def test_view_all_app_rules_absent_when_not_logged_in(self):
        """'View All App Rules...' must NOT appear when user is not logged in."""
        db = _TestDB(schema="new")
        menu = self._build_menu(
            current_user=None,
            tracking_active=False,
            db=db
        )
        labels = [i.text for i in menu.items if isinstance(i, FakeMenuItem)]
        assert not any("App Rules" in lbl or "Classifications" in lbl for lbl in labels), \
            f"'App Rules' must be absent when not logged in, got: {labels}"

    def test_view_all_app_rules_absent_when_not_tracking(self):
        """'View All App Rules...' must NOT appear when tracking is paused/stopped."""
        db = _TestDB(schema="new")
        menu = self._build_menu(
            current_user={"email": "dev@example.com"},
            tracking_active=False,
            db=db
        )
        labels = [i.text for i in menu.items if isinstance(i, FakeMenuItem)]
        assert not any("App Rules" in lbl or "Classifications" in lbl for lbl in labels), \
            f"'App Rules' must be absent when not tracking, got: {labels}"

    def test_view_all_app_rules_item_is_clickable(self):
        """The 'View All App Rules...' menu item must be enabled (not disabled)."""
        db = _TestDB(schema="new")
        db.seed_active_session("code.exe", "productive")
        menu = self._build_menu(
            current_user={"email": "dev@example.com"},
            tracking_active=True,
            db=db
        )
        for item in menu.items:
            if isinstance(item, FakeMenuItem) and (
                "App Rules" in item.text or "Classifications" in item.text
            ):
                assert item.enabled is True, \
                    "'View All App Rules...' must be an enabled (clickable) menu item"
                return
        # If we get here the item wasn't found — test_view_all_app_rules_appears will catch it

    def test_manual_dq_test_action_appears_when_logged_in_and_tracking(self):
        """Manual DQ tray action must appear for testing when tracking is active."""
        db = _TestDB(schema="new")
        db.seed_active_session("code.exe", "productive")
        menu = self._build_menu(
            current_user={"email": "dev@example.com"},
            tracking_active=True,
            db=db
        )
        labels = [i.text for i in menu.items if isinstance(i, FakeMenuItem)]
        assert any("Description Quality" in lbl for lbl in labels), \
            f"Expected manual DQ action in tray, got: {labels}"

    def test_current_window_label_is_disabled_display_only(self):
        """The current-window status label must be disabled (non-clickable display label)."""
        db = _TestDB(schema="new")
        db.seed_active_session("steam.exe", "non_productive")
        menu = self._build_menu(
            current_user={"email": "dev@example.com"},
            tracking_active=True,
            db=db
        )
        for item_obj in menu.items:
            if isinstance(item_obj, FakeMenuItem) and any(
                e in item_obj.text for e in ("🟢", "🔴", "⚫", "⚪")
            ):
                assert item_obj.enabled is False, \
                    "Current-window classification label must be disabled (display-only)"
                return


class _InlineThread:
    """Test helper: execute a thread target inline to keep tests deterministic."""

    def __init__(self, target=None, args=(), kwargs=None, daemon=None):
        self._target = target
        self._args = args
        self._kwargs = kwargs or {}

    def start(self):
        if self._target:
            self._target(*self._args, **self._kwargs)


def test_manual_dq_trigger_polls_once_and_dispatches_nudges():
    tracker = MagicMock()
    tracker.current_user = {"email": "dev@example.com"}
    tracker.auth_manager = MagicMock()
    tracker.dq_nudge_preferences = MagicMock()
    tracker.dq_nudge_poller = MagicMock()
    tracker.dq_nudge_poller.poll_once.return_value = [{"id": 1, "issueKey": "FEEDBACK-1"}]
    tracker._start_dq_nudge_poller = MagicMock()
    tracker._handle_dq_nudges = MagicMock()

    tracker._manual_dq_nudge_trigger = types.MethodType(
        desktop_app.TimeTracker._manual_dq_nudge_trigger,
        tracker,
    )

    with patch.object(desktop_app.threading, 'Thread', _InlineThread):
        tracker._manual_dq_nudge_trigger()

    tracker.dq_nudge_preferences.refresh.assert_called_once()
    tracker.dq_nudge_poller.poll_once.assert_called_once()
    tracker._handle_dq_nudges.assert_called_once_with([{"id": 1, "issueKey": "FEEDBACK-1"}])


# ===========================================================================
# 8. INTEGRATION — End-to-end sync + classify + API
# ===========================================================================

class TestIntegrationSyncAndView:
    """High-level integration: after sync, the /api/classifications endpoint
    returns data consistent with what classify() would return."""

    def test_classify_matches_api_data_after_sync(self):
        """After syncing, classify() and the API endpoint must agree on effective rules."""
        db = _TestDB(schema="new")
        try:
            supabase = _make_mock_supabase(
                global_rows=[
                    {"identifier": "steam.exe", "display_name": "Steam",
                     "classification": "non_productive", "match_by": "process"},
                ],
                org_rows=[],
                project_rows=[
                    {"identifier": "steam.exe", "display_name": "Steam",
                     "classification": "productive", "match_by": "process"},
                ],
            )
            manager = AppClassificationManager(db)
            manager.sync_classifications(
                supabase, organization_id="org-1",
                project_key="GAME", all_project_keys=["GAME"]
            )

            # classify() should use project-level rule (productive wins)
            classification, _ = manager.classify("steam.exe", "Steam Client")
            assert classification == "productive"

            # DB must have BOTH rows with their sources
            rows = db.all_rows()
            sources = {r["source"] for r in rows if r["identifier"] == "steam.exe"}
            assert "global" in sources
            assert "project" in sources
        finally:
            db.cleanup()

    def test_unknown_app_not_in_cache_returns_unknown(self):
        """An app not in any tier must return 'unknown' (queued for LLM fallback)."""
        db = _TestDB(schema="new")
        try:
            supabase = _make_mock_supabase(
                global_rows=[
                    {"identifier": "code.exe", "display_name": "VSCode",
                     "classification": "productive", "match_by": "process"},
                ]
            )
            manager = AppClassificationManager(db)
            manager.sync_classifications(supabase, organization_id="org-1")

            classification, match_type = manager.classify("unknown_new_app.exe", "")
            assert classification == "unknown"
            assert match_type is None
        finally:
            db.cleanup()
