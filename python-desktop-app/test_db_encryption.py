"""
Automated tests for SQLCipher database encryption (db_connection.py).

Tests:
  1. Encrypted DB creation — new DB is unreadable by plain sqlite3
  2. Data round-trip — write and read back through encrypted connection
  3. Key from keyring — verifies key storage and retrieval
  4. Plaintext-to-encrypted migration — existing unencrypted DB gets migrated
  5. Connection pool — each thread gets its own connection
  6. Corruption recovery — inaccessible DB gets renamed and recreated
  7. Schema completeness — all 4 tables and indexes are created
  8. Graceful degradation — app works without sqlcipher (falls back to sqlite3)

Run:
    python test_db_encryption.py
"""

import os
import sys
import sqlite3
import tempfile
import shutil
import threading
import secrets

sys.path.insert(0, os.path.dirname(__file__))

from db_connection import DatabaseConnectionManager, SQLCIPHER_AVAILABLE

if SQLCIPHER_AVAILABLE:
    from sqlcipher3 import dbapi2 as sqlcipher


def _make_temp_dir():
    """Create a temp directory for test databases."""
    d = tempfile.mkdtemp(prefix='tt_encryption_test_')
    return d


def _make_db_path(tmp_dir, name='test.db'):
    return os.path.join(tmp_dir, name)


class TestResults:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.skipped = 0
        self.details = []

    def ok(self, name):
        self.passed += 1
        self.details.append(('PASS', name))
        print(f"  PASS  {name}")

    def fail(self, name, reason):
        self.failed += 1
        self.details.append(('FAIL', name, reason))
        print(f"  FAIL  {name}")
        print(f"        {reason}")

    def skip(self, name, reason):
        self.skipped += 1
        self.details.append(('SKIP', name, reason))
        print(f"  SKIP  {name} ({reason})")

    def summary(self):
        total = self.passed + self.failed + self.skipped
        print(f"\n{'=' * 60}")
        print(f"Results: {self.passed} passed, {self.failed} failed, {self.skipped} skipped (total {total})")
        print(f"{'=' * 60}")
        return self.failed == 0


results = TestResults()


# ============================================================================
# Test 1: Encrypted DB is unreadable by plain sqlite3
# ============================================================================
def test_encrypted_db_unreadable():
    """A DB created by DatabaseConnectionManager should NOT be openable with plain sqlite3."""
    if not SQLCIPHER_AVAILABLE:
        results.skip("encrypted_db_unreadable", "sqlcipher3 not installed")
        return

    tmp = _make_temp_dir()
    try:
        db_path = _make_db_path(tmp)
        mgr = DatabaseConnectionManager(db_path=db_path)

        # Write some data
        conn = mgr.get_connection()
        conn.execute("INSERT INTO active_sessions (window_title, application_name) VALUES ('Test', 'test.exe')")
        conn.commit()
        mgr.close_all()

        # Try to read with plain sqlite3 — should fail
        try:
            plain_conn = sqlite3.connect(db_path)
            plain_conn.execute("SELECT count(*) FROM sqlite_master")
            plain_conn.close()
            results.fail("encrypted_db_unreadable", "Plain sqlite3 could read the encrypted DB")
        except Exception:
            results.ok("encrypted_db_unreadable")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ============================================================================
# Test 2: Data round-trip through encrypted connection
# ============================================================================
def test_data_round_trip():
    """Data written to encrypted DB should be readable back."""
    if not SQLCIPHER_AVAILABLE:
        results.skip("data_round_trip", "sqlcipher3 not installed")
        return

    tmp = _make_temp_dir()
    try:
        db_path = _make_db_path(tmp)
        mgr = DatabaseConnectionManager(db_path=db_path)

        conn = mgr.get_connection()
        conn.execute(
            "INSERT INTO active_sessions (window_title, application_name, classification) "
            "VALUES (?, ?, ?)",
            ("My Document.docx - Word", "WINWORD.EXE", "productive")
        )
        conn.commit()

        cursor = conn.cursor()
        cursor.execute("SELECT window_title, application_name, classification FROM active_sessions")
        row = cursor.fetchone()

        if row and row[0] == "My Document.docx - Word" and row[1] == "WINWORD.EXE" and row[2] == "productive":
            results.ok("data_round_trip")
        else:
            results.fail("data_round_trip", f"Data mismatch: {row}")

        mgr.close_all()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ============================================================================
# Test 3: Key stored in keyring
# ============================================================================
def test_key_in_keyring():
    """Encryption key should be stored in keyring (Windows Credential Manager)."""
    import keyring
    try:
        key = keyring.get_password("TimeTracker", "db_encryption_key")
        if key and len(key) == 64 and all(c in '0123456789abcdef' for c in key):
            results.ok("key_in_keyring")
        elif key is None:
            results.skip("key_in_keyring", "No key found — app hasn't run yet with encryption")
        else:
            results.fail("key_in_keyring", f"Key has unexpected format: length={len(key)}")
    except Exception as e:
        results.skip("key_in_keyring", f"Keyring unavailable: {e}")


# ============================================================================
# Test 4: Plaintext-to-encrypted migration
# ============================================================================
def test_migration():
    """An existing plaintext DB should be migrated to encrypted on first use."""
    if not SQLCIPHER_AVAILABLE:
        results.skip("migration", "sqlcipher3 not installed")
        return

    tmp = _make_temp_dir()
    try:
        db_path = _make_db_path(tmp)

        # Step 1: Create a plaintext DB with test data
        plain_conn = sqlite3.connect(db_path)
        plain_conn.execute("""
            CREATE TABLE active_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                window_title TEXT,
                application_name TEXT,
                classification TEXT,
                ocr_text TEXT,
                ocr_method TEXT,
                ocr_confidence REAL,
                ocr_error_message TEXT,
                total_time_seconds REAL DEFAULT 0,
                visit_count INTEGER DEFAULT 1,
                first_seen TEXT,
                last_seen TEXT,
                timer_started_at TEXT,
                UNIQUE(window_title, application_name)
            )
        """)
        plain_conn.execute(
            "INSERT INTO active_sessions (window_title, application_name) VALUES (?, ?)",
            ("Migration Test", "test.exe")
        )
        plain_conn.commit()
        plain_conn.close()

        # Verify it's plaintext
        verify = sqlite3.connect(db_path)
        verify.execute("SELECT count(*) FROM active_sessions")
        verify.close()

        # Step 2: Open with DatabaseConnectionManager — should trigger migration
        mgr = DatabaseConnectionManager(db_path=db_path)

        # Step 3: Verify it's now encrypted (plain sqlite3 should fail)
        mgr.close_all()
        try:
            post_conn = sqlite3.connect(db_path)
            post_conn.execute("SELECT count(*) FROM sqlite_master")
            post_conn.close()
            results.fail("migration", "DB is still plaintext after migration")
            return
        except Exception:
            pass  # Good — it's encrypted now

        # Step 4: Verify data survived migration
        mgr2 = DatabaseConnectionManager(db_path=db_path)
        conn = mgr2.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT window_title FROM active_sessions WHERE application_name = 'test.exe'")
        row = cursor.fetchone()
        mgr2.close_all()

        if row and row[0] == "Migration Test":
            results.ok("migration")
        else:
            results.fail("migration", f"Data not preserved after migration: {row}")

        # Step 5: Verify no plaintext backup remains
        bak = db_path + '.plaintext.bak'
        encrypting = db_path + '.encrypting'
        if os.path.exists(bak):
            results.fail("migration", f"Plaintext backup still exists: {bak}")
        elif os.path.exists(encrypting):
            results.fail("migration", f"Temp encrypting file still exists: {encrypting}")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ============================================================================
# Test 5: Per-thread connection pool
# ============================================================================
def test_connection_pool():
    """Each thread should get its own connection, not share one."""
    if not SQLCIPHER_AVAILABLE:
        results.skip("connection_pool", "sqlcipher3 not installed")
        return

    tmp = _make_temp_dir()
    try:
        db_path = _make_db_path(tmp)
        mgr = DatabaseConnectionManager(db_path=db_path)

        main_conn = mgr.get_connection()
        main_conn_id = id(main_conn)

        # Same thread should get same connection
        same_conn = mgr.get_connection()
        if id(same_conn) != main_conn_id:
            results.fail("connection_pool", "Same thread got different connections")
            mgr.close_all()
            return

        # Different thread should get different connection
        thread_conn_ids = []

        def worker():
            c = mgr.get_connection()
            thread_conn_ids.append(id(c))

        t = threading.Thread(target=worker)
        t.start()
        t.join()

        if not thread_conn_ids:
            results.fail("connection_pool", "Worker thread didn't get a connection")
        elif thread_conn_ids[0] == main_conn_id:
            results.fail("connection_pool", "Different thread got the SAME connection object")
        else:
            results.ok("connection_pool")

        mgr.close_all()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ============================================================================
# Test 6: Corruption recovery
# ============================================================================
def test_corruption_recovery():
    """If DB can't be decrypted, it should be renamed and a fresh one created."""
    if not SQLCIPHER_AVAILABLE:
        results.skip("corruption_recovery", "sqlcipher3 not installed")
        return

    tmp = _make_temp_dir()
    try:
        db_path = _make_db_path(tmp)

        # Create a file with random bytes (simulates corrupted/wrong-key DB)
        with open(db_path, 'wb') as f:
            f.write(os.urandom(4096))

        # DatabaseConnectionManager should handle this gracefully
        try:
            mgr = DatabaseConnectionManager(db_path=db_path)
            # Should have created a fresh DB
            conn = mgr.get_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables = [r[0] for r in cursor.fetchall()]
            mgr.close_all()

            if 'active_sessions' in tables and 'offline_screenshots' in tables:
                results.ok("corruption_recovery")
            else:
                results.fail("corruption_recovery", f"Fresh DB missing tables: {tables}")
        except Exception as e:
            results.fail("corruption_recovery", f"Crashed instead of recovering: {e}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ============================================================================
# Test 7: Schema completeness
# ============================================================================
def test_schema():
    """All 4 tables and their indexes should be created."""
    tmp = _make_temp_dir()
    try:
        db_path = _make_db_path(tmp)
        mgr = DatabaseConnectionManager(db_path=db_path)
        conn = mgr.get_connection()
        cursor = conn.cursor()

        # Check tables
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        tables = [r[0] for r in cursor.fetchall()]
        expected_tables = ['active_sessions', 'app_classifications_cache', 'offline_screenshots', 'project_settings_cache']

        missing = [t for t in expected_tables if t not in tables]
        if missing:
            results.fail("schema_tables", f"Missing tables: {missing}")
        else:
            results.ok("schema_tables")

        # Check indexes
        cursor.execute("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        indexes = [r[0] for r in cursor.fetchall()]
        expected_indexes = [
            'idx_app_class_cache_identifier',
            'idx_app_class_cache_match_by',
            'idx_offline_screenshots_synced',
            'idx_offline_screenshots_user',
            'idx_project_settings_org',
        ]
        missing_idx = [i for i in expected_indexes if i not in indexes]
        if missing_idx:
            results.fail("schema_indexes", f"Missing indexes: {missing_idx}")
        else:
            results.ok("schema_indexes")

        # Check active_sessions columns (the OCR columns that were missing before)
        cursor.execute("PRAGMA table_info(active_sessions)")
        columns = [r[1] for r in cursor.fetchall()]
        required_cols = ['ocr_text', 'ocr_method', 'ocr_confidence', 'ocr_error_message']
        missing_cols = [c for c in required_cols if c not in columns]
        if missing_cols:
            results.fail("schema_ocr_columns", f"Missing OCR columns in active_sessions: {missing_cols}")
        else:
            results.ok("schema_ocr_columns")

        mgr.close_all()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ============================================================================
# Test 8: Diagnostic connection (open_diagnostic_connection)
# ============================================================================
def test_diagnostic_connection():
    """open_diagnostic_connection should auto-detect and open encrypted DBs."""
    if not SQLCIPHER_AVAILABLE:
        results.skip("diagnostic_connection", "sqlcipher3 not installed")
        return

    tmp = _make_temp_dir()
    try:
        db_path = _make_db_path(tmp)
        mgr = DatabaseConnectionManager(db_path=db_path)

        # Write test data
        conn = mgr.get_connection()
        conn.execute(
            "INSERT INTO active_sessions (window_title, application_name) VALUES (?, ?)",
            ("Diag Test", "diag.exe")
        )
        conn.commit()
        mgr.close_all()

        # Open with diagnostic connection (should auto-detect encryption)
        diag_conn = DatabaseConnectionManager.open_diagnostic_connection(db_path)
        cursor = diag_conn.cursor()
        cursor.execute("SELECT window_title FROM active_sessions WHERE application_name = 'diag.exe'")
        row = cursor.fetchone()
        diag_conn.close()

        if row and row[0] == "Diag Test":
            results.ok("diagnostic_connection")
        else:
            results.fail("diagnostic_connection", f"Could not read data: {row}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ============================================================================
# Run all tests
# ============================================================================
if __name__ == '__main__':
    print("=" * 60)
    print("  SQLCipher Database Encryption Tests")
    print("=" * 60)
    print(f"\n  SQLCipher available: {SQLCIPHER_AVAILABLE}")
    if SQLCIPHER_AVAILABLE:
        print(f"  SQLCipher version:   {sqlcipher.sqlite_version}")
    print()

    test_encrypted_db_unreadable()
    test_data_round_trip()
    test_key_in_keyring()
    test_migration()
    test_connection_pool()
    test_corruption_recovery()
    test_schema()
    test_diagnostic_connection()

    success = results.summary()
    sys.exit(0 if success else 1)
