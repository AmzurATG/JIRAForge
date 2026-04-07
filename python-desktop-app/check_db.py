"""Check local SQLite database for activity records"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from db_connection import DatabaseConnectionManager

db_path = os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')), 'TimeTracker', 'time_tracker_offline.db')
print(f'DB: {db_path}')

conn = DatabaseConnectionManager.open_diagnostic_connection(db_path)
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

# Check offline_screenshots
print('\n=== Pending offline screenshots ===')
cursor.execute("SELECT COUNT(*) FROM offline_screenshots WHERE synced = 0")
print(f'Pending: {cursor.fetchone()[0]}')

cursor.execute("SELECT * FROM offline_screenshots ORDER BY created_at DESC LIMIT 3")
rows = cursor.fetchall()
if rows:
    cursor.execute('PRAGMA table_info(offline_screenshots)')
    cols = [c[1] for c in cursor.fetchall()]
    print(f'Columns: {cols}')
    for row in rows:
        data = dict(zip(cols, row))
        # Truncate large blob data for display
        for blob_col in ('image_data', 'thumbnail_data'):
            if data.get(blob_col):
                data[blob_col] = f'<{len(data[blob_col])} bytes>'
        print(data)

conn.close()
