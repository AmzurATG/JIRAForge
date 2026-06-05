#!/usr/bin/env python3
import sqlite3, uuid
conn = sqlite3.connect(':memory:')
conn.execute('''CREATE TABLE IF NOT EXISTS pending_finalizes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    screenshot_id TEXT NOT NULL,
    end_time TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(screenshot_id))''')
conn.commit()
fid = str(uuid.uuid4())
conn.execute("INSERT OR IGNORE INTO pending_finalizes (screenshot_id,end_time,duration_seconds) VALUES(?,?,?)",(fid,"2026-06-05T10:30:00+00:00",300))
conn.commit()
rows = conn.execute("SELECT screenshot_id FROM pending_finalizes").fetchall()
assert len(rows) == 1 and rows[0][0] == fid
conn.execute("INSERT OR IGNORE INTO pending_finalizes (screenshot_id,end_time,duration_seconds) VALUES(?,?,?)",(fid,"2026-06-05T10:35:00+00:00",600))
conn.commit()
assert conn.execute("SELECT COUNT(*) FROM pending_finalizes").fetchone()[0] == 1
conn.execute("DELETE FROM pending_finalizes WHERE screenshot_id=?",(fid,))
conn.commit()
assert conn.execute("SELECT COUNT(*) FROM pending_finalizes").fetchone()[0] == 0
conn.close()
print("FIX-9 PASS")
