"""Step-by-step constructor to find hang."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

print("1: importing", flush=True)
from db_connection import DatabaseConnectionManager
print("2: import OK", flush=True)

print("3: calling constructor...", flush=True)
dm = DatabaseConnectionManager()
print("4: constructor done", flush=True)

conn = dm.get_connection()
cur = conn.cursor()
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
print(f"5: tables = {[r[0] for r in cur.fetchall()]}", flush=True)
dm.close_all()
print("6: ALL OK", flush=True)
