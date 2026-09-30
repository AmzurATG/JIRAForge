"""Capture result type shared by all backends."""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional, Tuple


class CaptureStatus(Enum):
    OK = 'OK'
    # Expected skips: nothing to capture right now. Not backend failures.
    SKIPPED_LOCKED = 'SKIPPED_LOCKED'
    SKIPPED_NO_FOCUS = 'SKIPPED_NO_FOCUS'
    SKIPPED_MINIMIZED = 'SKIPPED_MINIMIZED'
    SKIPPED_UNKNOWN_MONITOR = 'SKIPPED_UNKNOWN_MONITOR'
    SKIPPED_RATE_LIMITED = 'SKIPPED_RATE_LIMITED'
    # The focus moved between request and capture; the frame is not wrong,
    # it belongs to another session. Not a backend failure either.
    STALE_WINDOW = 'STALE_WINDOW'
    # Failures: count towards switching to the next backend.
    BLACK_FRAME = 'BLACK_FRAME'
    INVALID_SIZE = 'INVALID_SIZE'
    TIMEOUT = 'TIMEOUT'
    DENIED = 'DENIED'
    BACKEND_UNAVAILABLE = 'BACKEND_UNAVAILABLE'
    ERROR = 'ERROR'

    @property
    def is_failure(self):
        return self in _FAILURES


_FAILURES = frozenset({
    CaptureStatus.BLACK_FRAME,
    CaptureStatus.INVALID_SIZE,
    CaptureStatus.TIMEOUT,
    CaptureStatus.DENIED,
    CaptureStatus.BACKEND_UNAVAILABLE,
    CaptureStatus.ERROR,
})


@dataclass
class CaptureResult:
    image: Optional[Any]                        # PIL.Image or None
    status: CaptureStatus
    backend: str = ''
    window_id: Optional[str] = None             # focused window when the frame was taken
    monitor_name: Optional[str] = None
    monitor_size: Optional[Tuple[int, int]] = None   # physical pixels, for size check
    scale: float = 1.0
    elapsed_ms: Optional[float] = None
    detail: str = ''
    extra: dict = field(default_factory=dict)

    def summary(self):
        """Dict for logs and diagnostics (never includes the image)."""
        return {
            'status': self.status.value,
            'backend': self.backend,
            'monitor': self.monitor_name,
            'size': list(self.image.size) if self.image is not None else None,
            'scale': self.scale,
            'elapsed_ms': round(self.elapsed_ms, 1) if self.elapsed_ms is not None else None,
            'detail': self.detail,
        }
