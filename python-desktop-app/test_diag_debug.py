"""Debug open_diagnostic_connection key matching."""
import os, sys, keyring
sys.path.insert(0, os.path.dirname(__file__))

from sqlcipher3 import dbapi2 as sqlcipher

db_path = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'TimeTracker', 'time_tracker_offline.db')
print(f"DB: {db_path}")
print(f"Exists: {os.path.exists(db_path)}")
print(f"Size: {os.path.getsize(db_path)} bytes")

# Check plaintext first
import sqlite3
try:
    conn = sqlite3.connect(db_path)
    conn.execute("SELECT count(*) FROM sqlite_master")
    print("PLAINTEXT: yes")
    conn.close()
except Exception as e:
    print(f"PLAINTEXT: no ({e})")

# Try keyring key
key = keyring.get_password("TimeTracker", "db_encryption_key")
print(f"Key: {key[:8]}... (len={len(key)})")

try:
    conn = sqlcipher.connect(db_path)
    pragma = "PRAGMA key = \"x'" + key + "'\""
    print(f"PRAGMA: {pragma[:40]}...")
    conn.execute(pragma)
    conn.execute("PRAGMA cipher_page_size = 4096")
    conn.execute("PRAGMA kdf_iter = 256000")
    result = conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
    print(f"SUCCESS: {result[0]} objects")
    conn.close()
except Exception as e:
    print(f"FAILED: {e}")
    import traceback; traceback.print_exc()
