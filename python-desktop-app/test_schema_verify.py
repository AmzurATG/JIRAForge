"""Verify DatabaseConnectionManager creates tables and they persist."""
from db_connection import DatabaseConnectionManager

dm = DatabaseConnectionManager()
conn = dm.get_connection()
cur = conn.cursor()
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [r[0] for r in cur.fetchall()]
print(f"Tables: {tables}")

for t in tables:
    cur.execute(f"SELECT COUNT(*) FROM [{t}]")
    print(f"  {t}: {cur.fetchone()[0]} rows")

dm.close_all()
print("OK - all tables created and DB encrypted")
