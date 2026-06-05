"""
Centralized encrypted database connection manager for the Time Tracker desktop app.

Provides AES-256 page-level encryption via SQLCipher with per-thread connection
pooling. Encryption key is stored in Windows Credential Manager (keyring) with
a PBKDF2 machine-derived fallback.

Usage:
    from db_connection import DatabaseConnectionManager
    db_manager = DatabaseConnectionManager()
    conn = db_manager.get_connection()  # per-thread, persistent
    # ... use conn ...
    # Never call conn.close() — lifecycle managed by db_manager.close_all()
"""

import sqlite3
import secrets
import threading
import os
import sys
import platform
import time
import keyring

try:
    from sqlcipher3 import dbapi2 as sqlcipher
    SQLCIPHER_AVAILABLE = True
except (ImportError, OSError):
    SQLCIPHER_AVAILABLE = False

try:
    from app_logger import get_logger as _get_logger
    _DB_LOGGER = _get_logger(__name__, 'DB')
except ImportError:
    _DB_LOGGER = None


def _db_log(level: str, message: str) -> None:
    """Write to app log file if available, always print to stdout."""
    print(message, flush=True)
    if _DB_LOGGER:
        getattr(_DB_LOGGER, level.lower(), _DB_LOGGER.info)(message)


class DatabaseConnectionManager:
    """Manages encrypted SQLite connections with per-thread connection pooling.

    Architecture:
    - Each thread gets its own persistent connection via threading.local()
    - Connections are created lazily on first get_connection() per thread
    - Key derivation (PBKDF2) happens once per connection, not per method call
    - WAL mode enables concurrent readers; writes serialize via SQLite internals
    """

    KEYRING_SERVICE = "TimeTracker"
    KEYRING_KEY_NAME = "db_encryption_key"

    def __init__(self, db_path=None):
        self.db_path = db_path or os.path.join(
            self._get_app_data_dir(), 'time_tracker_offline.db'
        )
        self._local = threading.local()
        self._lock = threading.Lock()
        self._all_connections = []

        self._ensure_key()
        print("[DEBUG] key done", flush=True)
        try:
            self._maybe_migrate()
        except Exception as e:
            print(f"[WARN] Migration to encrypted DB failed ({e}), continuing with existing DB")
        print("[DEBUG] migrate done", flush=True)
        if not self._try_init_schema():
            self._handle_inaccessible_db()
            self._init_schema()
        print("[DEBUG] schema done", flush=True)
        self._restrict_file_permissions()
        print("[DEBUG] perms done", flush=True)

    @staticmethod
    def _get_app_data_dir():
        """Get application data directory (matches desktop_app.get_app_data_dir)."""
        if sys.platform == 'win32':
            app_data = os.environ.get('LOCALAPPDATA', os.path.expanduser('~'))
        else:
            app_data = os.path.expanduser('~/.local/share')
        app_dir = os.path.join(app_data, 'TimeTracker')
        if not os.path.exists(app_dir):
            os.makedirs(app_dir, exist_ok=True)
        return app_dir

    # =========================================================================
    # KEY MANAGEMENT
    # =========================================================================

    def _ensure_key(self):
        """Retrieve or generate the database encryption key."""
        try:
            key = keyring.get_password(self.KEYRING_SERVICE, self.KEYRING_KEY_NAME)
            if key is None:
                key = secrets.token_hex(32)  # 256-bit
                keyring.set_password(self.KEYRING_SERVICE, self.KEYRING_KEY_NAME, key)
                print("[OK] Generated new database encryption key")
            self._encryption_key = key
        except Exception as e:
            print(f"[WARN] Keyring unavailable ({e}), using machine-derived key")
            self._encryption_key = self._derive_machine_key()

    def _derive_machine_key(self):
        """Derive a deterministic encryption key from machine-specific data.
        Used as fallback when keyring is unavailable."""
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
        from cryptography.hazmat.primitives import hashes

        try:
            username = os.getlogin()
        except OSError:
            username = os.environ.get('USERNAME', 'default')
        machine_id = f"{username}@{platform.node()}"
        salt = machine_id.encode('utf-8')
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=600000,
        )
        key_bytes = kdf.derive(b"TimeTracker-DB-Encryption")
        return key_bytes.hex()

    # =========================================================================
    # CONNECTION POOL
    # =========================================================================

    def get_connection(self):
        """Get or create a per-thread SQLite connection.

        Each thread gets its own persistent connection via threading.local().
        Connections are never closed by callers - the pool manages lifecycle.
        """
        conn = getattr(self._local, 'conn', None)
        if conn is not None:
            return conn
        conn = self._create_connection()
        self._local.conn = conn
        with self._lock:
            self._all_connections.append(conn)
        return conn

    def _create_connection(self):
        """Create a new SQLite/SQLCipher connection with all PRAGMAs."""
        if SQLCIPHER_AVAILABLE:
            # check_same_thread=False is required because close_all() performs
            # a WAL checkpoint (conn.execute) on connections created by other
            # threads. The per-thread pool via threading.local() prevents
            # accidental cross-thread SQL during normal operations.
            conn = sqlcipher.connect(self.db_path, check_same_thread=False)
            assert all(c in '0123456789abcdef' for c in self._encryption_key), \
                "Encryption key must be hex-only"
            conn.execute("PRAGMA key = \"x'" + self._encryption_key + "'\"")
            conn.execute("PRAGMA cipher_page_size = 4096")
            conn.execute("PRAGMA kdf_iter = 256000")
            # cipher_memory_security = ON omitted — causes VirtualLock() failures
            # and access violations on some Windows configurations.
        else:
            # check_same_thread=False: see comment above in sqlcipher branch
            conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def close_all(self):
        """Close all tracked connections across all threads.
        Called from TimeTracker._shutdown_cleanup()."""
        with self._lock:
            for conn in self._all_connections:
                try:
                    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                    break  # Only need one successful checkpoint
                except Exception:
                    continue
            for conn in self._all_connections:
                try:
                    conn.close()
                except Exception:
                    pass
            self._all_connections.clear()
        self._local.conn = None

    # =========================================================================
    # SCHEMA INITIALIZATION
    # =========================================================================

    def _try_init_schema(self):
        """Try to init schema, returning True on success.
        Isolates the exception scope so traceback references to conn objects
        are released before _handle_inaccessible_db tries to rename the file."""
        try:
            self._init_schema()
            return True
        except Exception as e:
            print(f"[WARN] Database inaccessible ({e}), creating fresh DB")
            return False

    def _migrate_app_classifications_schema(self, cursor):
        """Migrate app_classifications_cache to schema v2 if needed.

        v1 had `project_key` with no `source` column and a flat merged cache.
        v2 stores all 3 tiers separately with `source` + `source_project_key`.

        This table is a pure Supabase cache re-synced on every login, so
        dropping and recreating it on schema change is safe.
        """
        cursor.execute("PRAGMA table_info(app_classifications_cache)")
        columns = {row[1] for row in cursor.fetchall()}

        if not columns:
            # Table doesn't exist yet — fresh install, nothing to migrate
            _db_log('info', '[DB] app_classifications_cache: fresh install, no migration needed')
            return

        if 'source' in columns:
            # Already on v2 schema
            _db_log('debug', '[DB] app_classifications_cache: schema v2 already present, skipping migration')
            return

        # Old v1 schema detected — drop and let _init_schema recreate with v2 DDL
        _db_log('warning',
            '[DB] app_classifications_cache: v1 schema detected (missing `source` column) — '
            'migrating to v2 (safe: table is a pure Supabase cache, will be refilled on next login)')
        try:
            cursor.execute('DROP TABLE IF EXISTS app_classifications_cache')
            cursor.execute('DROP INDEX IF EXISTS idx_app_class_cache_identifier')
            cursor.execute('DROP INDEX IF EXISTS idx_app_class_cache_match_by')
            _db_log('info', '[DB] app_classifications_cache: migration to v2 schema complete — '
                            'classifications will be re-synced from Supabase on next login')
        except Exception as exc:
            _db_log('error', f'[DB] app_classifications_cache: migration failed: {exc}')
            raise

    def _init_schema(self):
        """Create all tables and indexes (moved from OfflineManager._init_database)."""
        conn = self.get_connection()
        cursor = conn.cursor()

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS offline_screenshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                organization_id TEXT,
                timestamp TEXT NOT NULL,
                storage_path TEXT,
                window_title TEXT,
                application_name TEXT,
                file_size_bytes INTEGER,
                start_time TEXT,
                end_time TEXT,
                duration_seconds INTEGER,
                project_key TEXT,
                user_assigned_issues TEXT,
                metadata TEXT,
                image_data BLOB,
                thumbnail_data BLOB,
                synced INTEGER DEFAULT 0,
                sync_attempts INTEGER DEFAULT 0,
                last_sync_error TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        # Add project_key column if it doesn't exist (for existing databases)
        try:
            cursor.execute('ALTER TABLE offline_screenshots ADD COLUMN project_key TEXT')
        except (sqlite3.OperationalError, Exception):
            pass  # Column already exists

        cursor.execute('''
            CREATE INDEX IF NOT EXISTS idx_offline_screenshots_synced
            ON offline_screenshots(synced)
        ''')

        cursor.execute('''
            CREATE INDEX IF NOT EXISTS idx_offline_screenshots_user
            ON offline_screenshots(user_id)
        ''')

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS project_settings_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                organization_id TEXT NOT NULL,
                project_key TEXT NOT NULL,
                project_name TEXT,
                tracked_statuses TEXT,
                cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(organization_id, project_key)
            )
        ''')

        cursor.execute('''
            CREATE INDEX IF NOT EXISTS idx_project_settings_org
            ON project_settings_cache(organization_id)
        ''')

        # ── App Classifications Cache ──────────────────────────────────────────
        # Schema v2: stores all 3 tiers (global / organization / project) as
        # separate rows with a `source` tag so the web page can show which tier
        # each rule comes from.  The in-memory merge in reload_from_cache()
        # applies the correct precedence (project > org > global) at runtime.
        #
        # Migration: if an existing DB has the old schema (no `source` column),
        # drop and recreate — this table is a pure cache re-synced on every login.
        self._migrate_app_classifications_schema(cursor)

        cursor.execute('''
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
        ''')

        cursor.execute('''
            CREATE INDEX IF NOT EXISTS idx_app_class_cache_identifier
            ON app_classifications_cache(identifier)
        ''')

        cursor.execute('''
            CREATE INDEX IF NOT EXISTS idx_app_class_cache_match_by
            ON app_classifications_cache(match_by)
        ''')

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS active_sessions (
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
        ''')

        # FIX-9 (B-12): Persist failed Supabase screenshots UPDATE calls so they
        # are retried on the next batch upload cycle instead of being lost forever.
        conn.execute('''
            CREATE TABLE IF NOT EXISTS pending_finalizes (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                screenshot_id    TEXT    NOT NULL,
                end_time         TEXT    NOT NULL,
                duration_seconds INTEGER NOT NULL,
                created_at       TEXT    DEFAULT (datetime('now')),
                UNIQUE(screenshot_id)
            )
        ''')

        conn.commit()

    # =========================================================================
    # CORRUPTION / KEY-LOSS RECOVERY
    # =========================================================================

    def _handle_inaccessible_db(self):
        """Handle case where DB exists but can't be decrypted (key lost, corruption).
        Renames the old DB and lets _init_schema() create a fresh one."""
        # Close and clear all connections (broken — must release file handles)
        import gc
        with self._lock:
            for conn in self._all_connections:
                try:
                    conn.close()
                except Exception:
                    pass
            self._all_connections.clear()
        self._local.conn = None
        # Force garbage collection to release file handles on Windows.
        # CPython may hold OS file handles until the connection object is collected.
        gc.collect()

        timestamp = int(time.time())
        corrupted_path = f"{self.db_path}.corrupted.{timestamp}"

        # On Windows, file handles may not release instantly after conn.close().
        # Retry rename a few times with short delays.
        renamed = False
        for attempt in range(5):
            try:
                os.rename(self.db_path, corrupted_path)
                for suffix in ('-wal', '-shm'):
                    try:
                        os.rename(self.db_path + suffix, corrupted_path + suffix)
                    except FileNotFoundError:
                        pass
                print(f"[WARN] Old database renamed to {corrupted_path}")
                print("[WARN] Data loss is acceptable - this DB is an offline cache of Supabase")
                renamed = True
                break
            except OSError:
                if attempt < 4:
                    time.sleep(0.3)
                    gc.collect()
                    continue

        if not renamed:
            print(f"[ERROR] Could not rename corrupted DB after retries")
            for attempt in range(3):
                try:
                    os.remove(self.db_path)
                    break
                except Exception:
                    time.sleep(0.2)
                    gc.collect()

    # =========================================================================
    # MIGRATION: PLAINTEXT -> ENCRYPTED
    # =========================================================================

    def _maybe_migrate(self):
        """Detect plaintext DB and migrate to encrypted format."""
        if not os.path.exists(self.db_path):
            return  # Fresh install
        if not SQLCIPHER_AVAILABLE:
            return  # Can't encrypt without sqlcipher

        self._recover_interrupted_migration()

        # Test if DB is plaintext
        test_conn = None
        try:
            test_conn = sqlite3.connect(self.db_path)
            test_conn.execute("SELECT count(*) FROM sqlite_master")
            test_conn.close()
            test_conn = None
            # Success = plaintext DB, needs migration
        except Exception:
            if test_conn:
                try:
                    test_conn.close()
                except Exception:
                    pass
            return  # Already encrypted (or empty/corrupt)

        self._migrate_to_encrypted()

    def _migrate_to_encrypted(self):
        """Convert plaintext DB to encrypted using sqlcipher_export."""
        encrypted_path = self.db_path + '.encrypting'
        backup_path = self.db_path + '.plaintext.bak'

        assert all(c in '0123456789abcdef' for c in self._encryption_key), \
            "Encryption key must be hex-only"

        # Checkpoint WAL first - sqlcipher_export only exports the main DB file
        try:
            plain_conn = sqlite3.connect(self.db_path)
            plain_conn.execute("PRAGMA wal_checkpoint(FULL)")
            plain_conn.close()
        except Exception:
            pass  # Best-effort

        # Open plaintext DB with sqlcipher (no PRAGMA key = plaintext mode), export to encrypted
        conn = sqlcipher.connect(self.db_path)
        try:
            # No PRAGMA key — omitting it tells SQLCipher to treat the DB as plaintext
            conn.execute(
                "ATTACH DATABASE ? AS encrypted KEY \"x'" + self._encryption_key + "'\"",
                (encrypted_path,)
            )
            # Set cipher PRAGMAs on the encrypted target to match _create_connection()
            conn.execute("PRAGMA encrypted.cipher_page_size = 4096")
            conn.execute("PRAGMA encrypted.kdf_iter = 256000")
            conn.execute("SELECT sqlcipher_export('encrypted')")
            conn.execute("DETACH DATABASE encrypted")
        finally:
            conn.close()

        # Atomic swap
        os.rename(self.db_path, backup_path)
        os.rename(encrypted_path, self.db_path)

        # Clean up plaintext WAL/SHM files (they remain at the original path
        # after os.rename — only the main DB file is renamed, not WAL/SHM)
        for suffix in ('-wal', '-shm'):
            try:
                self._secure_delete(self.db_path + suffix)
            except Exception:
                pass

        self._secure_delete(backup_path)
        print("[OK] Database migrated to encrypted format")

    def _recover_interrupted_migration(self):
        """Handle partially-completed migration from a previous crash."""
        encrypting = self.db_path + '.encrypting'
        backup = self.db_path + '.plaintext.bak'

        if os.path.exists(encrypting) and os.path.exists(backup):
            # Interrupted after export but before swap - complete it
            if os.path.exists(self.db_path):
                os.remove(self.db_path)
            os.rename(encrypting, self.db_path)
            self._secure_delete(backup)
        elif os.path.exists(encrypting) and not os.path.exists(backup):
            # Partial export - discard and retry
            os.remove(encrypting)
        elif os.path.exists(backup) and not os.path.exists(encrypting):
            # Swap completed but cleanup interrupted - just clean up
            self._secure_delete(backup)

    def _secure_delete(self, filepath):
        """Best-effort overwrite before deletion.

        Makes casual recovery harder by overwriting with random data,
        but NOT forensic-proof on NTFS/SSD (journal + wear-leveling
        may retain original data). The real protection is encryption
        of the primary DB file.
        """
        try:
            size = os.path.getsize(filepath)
            with open(filepath, 'r+b') as f:
                f.write(os.urandom(size))
                f.flush()
                os.fsync(f.fileno())
            os.remove(filepath)
        except Exception as e:
            try:
                os.remove(filepath)
            except Exception:
                pass
            print(f"[WARN] Secure delete failed: {e}")

    # =========================================================================
    # FILE PERMISSION HARDENING (Windows)
    # =========================================================================

    def _restrict_file_permissions(self):
        """Remove broad-access SIDs from DB files (Windows DACL).

        This is a defense-in-depth measure. The primary protection is encryption.
        Skipped for now — win32security DACL manipulation causes access violations
        on some configurations. TODO: revisit with icacls subprocess fallback.
        """
        pass

    # =========================================================================
    # DIAGNOSTIC CONNECTION (for utility scripts)
    # =========================================================================

    @staticmethod
    def open_diagnostic_connection(db_path):
        """Open a connection for diagnostic/utility scripts.
        Auto-detects encrypted vs plaintext database.
        Tries keyring key first, then machine-derived key as fallback."""
        # Try plaintext first
        try:
            conn = sqlite3.connect(db_path)
            conn.execute("SELECT count(*) FROM sqlite_master")
            return conn
        except Exception:
            pass

        # Try encrypted
        if not SQLCIPHER_AVAILABLE:
            raise RuntimeError(
                "Database is encrypted but sqlcipher3 is not installed. "
                "Install with: pip install sqlcipher3-wheels"
            )

        # Try keyring key first, then machine-derived fallback
        keys_to_try = []
        try:
            keyring_key = keyring.get_password("TimeTracker", "db_encryption_key")
            if keyring_key:
                keys_to_try.append(keyring_key)
        except Exception:
            pass

        # Machine-derived fallback key
        try:
            from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
            from cryptography.hazmat.primitives import hashes
            try:
                username = os.getlogin()
            except OSError:
                username = os.environ.get('USERNAME', 'default')
            machine_id = f"{username}@{platform.node()}"
            salt = machine_id.encode('utf-8')
            kdf = PBKDF2HMAC(
                algorithm=hashes.SHA256(),
                length=32,
                salt=salt,
                iterations=600000,
            )
            machine_key = kdf.derive(b"TimeTracker-DB-Encryption").hex()
            if machine_key not in keys_to_try:
                keys_to_try.append(machine_key)
        except Exception:
            pass

        if not keys_to_try:
            raise RuntimeError("Database is encrypted but no key found in keyring or via machine derivation")

        for key in keys_to_try:
            try:
                assert all(c in '0123456789abcdef' for c in key), \
                    "Encryption key must be hex-only"
                conn = sqlcipher.connect(db_path)
                conn.execute("PRAGMA key = \"x'" + key + "'\"")
                conn.execute("PRAGMA cipher_page_size = 4096")
                conn.execute("PRAGMA kdf_iter = 256000")
                conn.execute("SELECT count(*) FROM sqlite_master")  # Verify key works
                return conn
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass
                continue

        raise RuntimeError("Database is encrypted but none of the available keys could decrypt it")
