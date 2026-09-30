"""
Single-instance lock with flock().

The kernel drops the lock when the process exits or crashes, so there is
no stale PID file and no PID-reuse false positive (the shared core's lock
file fallback has both problems).
"""

import fcntl
import os

from . import paths

LOCK_FILE_NAME = 'instance.lock'


def default_lock_path(environ=None):
    runtime = paths.runtime_dir(environ)
    base = runtime if runtime else paths.data_dir(environ)
    return os.path.join(base, LOCK_FILE_NAME)


class InstanceLock:

    def __init__(self, path=None):
        self.path = path or default_lock_path()
        self._fd = None

    def acquire(self):
        """Return True if this process now holds the lock."""
        if self._fd is not None:
            return True
        paths.ensure_dir(os.path.dirname(self.path))
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            return False
        except OSError:
            os.close(fd)
            raise
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode())
        self._fd = fd
        return True

    def release(self):
        if self._fd is None:
            return
        try:
            fcntl.flock(self._fd, fcntl.LOCK_UN)
        finally:
            os.close(self._fd)
            self._fd = None
