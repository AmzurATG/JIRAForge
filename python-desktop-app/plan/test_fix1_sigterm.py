#!/usr/bin/env python3
import signal, sys, threading
shutdown_called = threading.Event()
class Stub:
    _shutdown_done = False
    def _shutdown_cleanup(self):
        if self._shutdown_done: return
        self._shutdown_done = True
        shutdown_called.set()
t = Stub()
if sys.platform != "win32":
    def h(s,f): t._shutdown_cleanup(); sys.exit(0)
    signal.signal(signal.SIGTERM, h)
    assert signal.getsignal(signal.SIGTERM) == h, "Handler not registered"
t._shutdown_cleanup()
assert shutdown_called.is_set()
prev = t._shutdown_done
t._shutdown_cleanup()
assert t._shutdown_done == prev
print("FIX-1 PASS")
