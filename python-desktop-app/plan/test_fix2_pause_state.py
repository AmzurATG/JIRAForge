#!/usr/bin/env python3
import threading
from enum import IntEnum
class TS(IntEnum):
    STOPPED=0; ACTIVE=1; IDLE=2; PAUSED=3
lock = threading.Lock()
state = TS.ACTIVE
def pause():
    global state
    with lock: state = TS.PAUSED
def enter_idle(r):
    global state
    with lock:
        if state == TS.IDLE: return False
        if state == TS.PAUSED: return False
        state = TS.IDLE; return True
pause()
assert state == TS.PAUSED
assert enter_idle("x") is False
assert state == TS.PAUSED
state = TS.ACTIVE
assert enter_idle("y") is True and state == TS.IDLE
print("FIX-2 PASS")
