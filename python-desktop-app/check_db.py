"""Check local SQLite database for activity records"""
import sqlite3
import os

db_path = os.path.join(os.getenv('APPDATA'), 'TimeTracker', 'time_tracker_offline.db')
print(f'DB: {db_path}')

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Get tables
cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [t[0] for t in cursor.fetchall()]
print(f'Tables: {tables}')

# Check counts
for table in tables:
    cursor.execute(f'SELECT COUNT(*) FROM {table}')
    print(f'  {table}: {cursor.fetchone()[0]} rows')

# Check active_sessions
print('\n=== Recent active_sessions ===')
cursor.execute('SELECT * FROM active_sessions ORDER BY last_seen DESC LIMIT 5')
rows = cursor.fetchall()
cursor.execute('PRAGMA table_info(active_sessions)')
cols = [c[1] for c in cursor.fetchall()]
print(f'Columns: {cols}')
for row in rows:
    print(dict(zip(cols, row)))

# Check pending_uploads
print('\n=== Pending uploads ===')
cursor.execute("SELECT COUNT(*) FROM pending_uploads WHERE sync_status != 'synced'")
print(f'Pending: {cursor.fetchone()[0]}')

cursor.execute("SELECT * FROM pending_uploads ORDER BY created_at DESC LIMIT 3")
rows = cursor.fetchall()
if rows:
    cursor.execute('PRAGMA table_info(pending_uploads)')
    cols = [c[1] for c in cursor.fetchall()]
    print(f'Columns: {cols}')
    for row in rows:
        data = dict(zip(cols, row))
        if data.get('data'):
            data['data'] = data['data'][:100] + '...' if len(data.get('data', '')) > 100 else data['data']
        print(data)

conn.close()
