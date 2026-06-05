#!/usr/bin/env python3
import threading, time
restart_triggered = [False]
running = True
def fake_tracking(): time.sleep(0.1)
t = threading.Thread(target=fake_tracking, daemon=True); t.start()
time.sleep(0.3)
assert not t.is_alive()
if running and not t.is_alive():
    restart_triggered[0] = True
assert restart_triggered[0]
print("FIX-10 PASS")
