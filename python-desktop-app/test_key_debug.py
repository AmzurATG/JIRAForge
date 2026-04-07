"""Quick debug: test if keyring key can open the encrypted DB."""
import keyring
from sqlcipher3 import dbapi2 as sqlcipher

db_path = r'C:\Users\VishnuK\AppData\Local\TimeTracker\time_tracker_offline.db'
key = keyring.get_password('TimeTracker', 'db_encryption_key')
print(f"Key from keyring: {key[:8]}... (len={len(key)})")
print(f"All hex? {all(c in '0123456789abcdef' for c in key)}")

# Try opening with the key
conn = sqlcipher.connect(db_path)
pragma_str = "PRAGMA key = \"x'" + key + "'\""
print(f"PRAGMA: {pragma_str[:30]}...")
conn.execute(pragma_str)
conn.execute("PRAGMA cipher_page_size = 4096")
conn.execute("PRAGMA kdf_iter = 256000")

try:
    result = conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
    print(f"SUCCESS: {result[0]} tables found")
except Exception as e:
    print(f"FAILED: {e}")

conn.close()
