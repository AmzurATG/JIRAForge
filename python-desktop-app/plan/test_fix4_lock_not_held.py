#!/usr/bin/env python3
import threading, time
lock = threading.Lock()
free_during_http = threading.Event()
def fake_http():
    ok = lock.acquire(blocking=False)
    if ok:
        free_during_http.set()
        lock.release()
def enter_idle_fixed():
    with lock:
        pass  # state change
    fake_http()  # outside lock
t = threading.Thread(target=enter_idle_fixed)
t.start(); t.join()
assert free_during_http.is_set(), "Lock was held during HTTP call!"
print("FIX-4 PASS")
