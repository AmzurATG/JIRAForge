#!/usr/bin/env python3
import threading
from datetime import datetime, timezone
idle_start = datetime(2026,6,5,10,0,0,tzinfo=timezone.utc)
records = []
lock = threading.Lock()
def create(reason):
    global idle_start
    with lock:
        snap = idle_start
        if snap is None: return
        idle_start = None
    records.append({'start': snap.isoformat(), 'reason': reason})
b = threading.Barrier(2)
def go(r): b.wait(); create(r)
t1 = threading.Thread(target=go, args=("a",))
t2 = threading.Thread(target=go, args=("b",))
t1.start(); t2.start(); t1.join(); t2.join()
assert len(records) == 1, f"Got {len(records)} records"
print("FIX-8 PASS")
