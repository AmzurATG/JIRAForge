"""Backend used when no real capture method works: tracks title + time only."""

from ..result import CaptureResult, CaptureStatus


class NullBackend:

    def __init__(self, reason='no screen capture method available on this desktop'):
        self.name = 'null'
        self.reason = reason

    def is_available(self):
        return True

    def capture(self):
        return CaptureResult(image=None, status=CaptureStatus.BACKEND_UNAVAILABLE,
                             backend=self.name, detail=self.reason)
