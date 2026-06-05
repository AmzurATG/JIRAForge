#!/usr/bin/env python3
import time
_CB_OPEN_AFTER = 3; _CB_RESET_AFTER = 60
failures = {}
def call_cb(name, resolver):
    cb = failures.get(name, {'count': 0, 'open_until': 0})
    if cb['count'] >= _CB_OPEN_AFTER and time.time() < cb.get('open_until', 0):
        return "SKIPPED"
    if cb['count'] >= _CB_OPEN_AFTER and time.time() >= cb.get('open_until', 0):
        failures[name] = {'count': 0, 'open_until': 0}
    r = resolver()
    if r is None:
        cb2 = failures.setdefault(name, {'count': 0, 'open_until': 0})
        cb2['count'] += 1
        if cb2['count'] >= _CB_OPEN_AFTER:
            cb2['open_until'] = time.time() + _CB_RESET_AFTER
    else:
        failures[name] = {'count': 0, 'open_until': 0}
    return r
calls = [0]
def fail(): calls[0] += 1; return None
for _ in range(3): call_cb('x', fail)
assert calls[0] == 3
r = call_cb('x', fail)
assert r == "SKIPPED" and calls[0] == 3
failures['x']['open_until'] = time.time() - 1
call_cb('x', fail)
assert failures['x']['count'] == 1
print("FIX-6 PASS")
