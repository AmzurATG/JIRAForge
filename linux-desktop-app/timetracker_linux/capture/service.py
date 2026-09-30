"""
CaptureService: runs capture backends with a time budget and fallback.

Rules (from the old build's failures, plan §3.1):
- A capture never blocks the caller longer than the budget (C-7). A backend
  that hangs is not called again until its previous call returns.
- Every frame is validated; black or blank frames never reach OCR (C-4).
- A frame taken while a different window had focus is discarded (C-7).
- After `failure_threshold` consecutive failures the next backend is used,
  and the preferred one is retried later or on reprobe() (C-6).
"""

import logging
import threading
import time
from collections import Counter

from .result import CaptureResult, CaptureStatus
from .validator import FrameValidator

logger = logging.getLogger(__name__)


class CaptureService:

    def __init__(self, backends, validator=None, budget_s=1.5, failure_threshold=5,
                 retry_preferred_after_s=1800, clock=time.monotonic):
        self._backends = list(backends)
        self._validator = validator or FrameValidator()
        self._budget_s = budget_s
        self._failure_threshold = failure_threshold
        self._retry_after_s = retry_preferred_after_s
        self._clock = clock
        self._lock = threading.Lock()
        self._active = None                 # index into self._backends
        self._switched_at = None            # clock() when we left the preferred backend
        self._consecutive_failures = 0
        self._inflight = {}                 # backend name → worker thread still running
        self._by_status = Counter()
        self._switches = 0
        self.last_result = None

    # ------------------------------------------------------------------ public

    @property
    def active_backend_name(self):
        with self._lock:
            index = self._current_index()
        return self._backends[index].name if index is not None else None

    def capture(self, expected_window_id=None):
        with self._lock:
            index = self._current_index()
            if index is None:
                result = CaptureResult(image=None, status=CaptureStatus.BACKEND_UNAVAILABLE,
                                       detail='no capture backend configured')
                return self._finish(result, None)
            backend = self._backends[index]

        start = time.monotonic()
        result = self._run_with_budget(backend)
        result.backend = result.backend or backend.name
        result.elapsed_ms = (time.monotonic() - start) * 1000.0

        if result.status == CaptureStatus.OK:
            if (expected_window_id is not None and result.window_id is not None
                    and result.window_id != expected_window_id):
                result.image = None
                result.status = CaptureStatus.STALE_WINDOW
                result.detail = 'focus changed before the frame was taken'
            else:
                verdict = self._validator.check(result.image, result.monitor_size)
                if verdict != CaptureStatus.OK:
                    result.image = None
                    result.status = verdict
                    result.detail = result.detail or f'frame rejected: {verdict.value}'

        with self._lock:
            return self._finish(result, index)

    def reprobe(self):
        """Forget the current choice; the next capture starts at the preferred backend."""
        with self._lock:
            self._active = None
            self._switched_at = None
            self._consecutive_failures = 0

    def stats(self):
        with self._lock:
            index = self._current_index(check_retry=False)
            return {
                'active_backend': self._backends[index].name if index is not None else None,
                'backends': [b.name for b in self._backends],
                'consecutive_failures': self._consecutive_failures,
                'switches': self._switches,
                'by_status': dict(self._by_status),
                'last': self.last_result.summary() if self.last_result else None,
            }

    # ----------------------------------------------------------------- private

    def _current_index(self, check_retry=True):
        """Index of the backend to use now (caller holds the lock)."""
        if (check_retry and self._active is not None and self._switched_at is not None
                and self._clock() - self._switched_at >= self._retry_after_s):
            logger.info("[CAPTURE] retrying preferred capture backend")
            self._active = None
            self._switched_at = None
            self._consecutive_failures = 0
        if self._active is None:
            self._active = self._first_available(0)
        return self._active

    def _first_available(self, start):
        for i in range(start, len(self._backends)):
            backend = self._backends[i]
            try:
                if backend.is_available():
                    return i
            except Exception as e:
                logger.info(f"[CAPTURE] backend '{backend.name}' availability check failed: {e}")
        return None

    def _run_with_budget(self, backend):
        worker = self._inflight.get(backend.name)
        if worker is not None and worker.is_alive():
            return CaptureResult(image=None, status=CaptureStatus.TIMEOUT, backend=backend.name,
                                 detail='previous capture still running')

        box = {}

        def run():
            try:
                box['result'] = backend.capture()
            except Exception as e:
                box['result'] = CaptureResult(image=None, status=CaptureStatus.ERROR,
                                              backend=backend.name, detail=f'{type(e).__name__}: {e}')

        worker = threading.Thread(target=run, name=f'capture-{backend.name}', daemon=True)
        self._inflight[backend.name] = worker
        worker.start()
        worker.join(self._budget_s)
        if worker.is_alive():
            # The late result lands in `box`, which nobody reads any more.
            return CaptureResult(image=None, status=CaptureStatus.TIMEOUT, backend=backend.name,
                                 detail=f'no frame within {self._budget_s:.1f}s')
        result = box.get('result')
        if not isinstance(result, CaptureResult):
            return CaptureResult(image=None, status=CaptureStatus.ERROR, backend=backend.name,
                                 detail='backend returned no result')
        return result

    def _finish(self, result, index):
        """Record the result and move to the next backend if needed (lock held)."""
        self._by_status[result.status.value] += 1
        self.last_result = result
        if index is None or index != self._active:
            return result

        if result.status.is_failure:
            self._consecutive_failures += 1
            if self._consecutive_failures >= self._failure_threshold:
                self._advance(index, result)
        elif result.status == CaptureStatus.OK:
            self._consecutive_failures = 0
        return result

    def _advance(self, index, result):
        following = self._first_available(index + 1)
        failing = self._backends[index].name
        self._consecutive_failures = 0
        if following is None:
            logger.warning(f"[CAPTURE] backend '{failing}' keeps failing ({result.status.value}: "
                           f"{result.detail}); no other backend available")
            return
        logger.warning(f"[CAPTURE] backend '{failing}' failed {self._failure_threshold} times "
                       f"({result.status.value}: {result.detail}); switching to "
                       f"'{self._backends[following].name}'")
        self._active = following
        self._switches += 1
        if self._switched_at is None:
            self._switched_at = self._clock()
