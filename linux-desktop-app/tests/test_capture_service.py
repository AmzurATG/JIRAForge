"""
Tests for CaptureService.

Spec: plan/2026-09-29_linux-desktop-app_phase1-foundation.md (AC 11-14)
"""

import threading
import time

import pytest
from PIL import Image, ImageDraw

from timetracker_linux.capture.result import CaptureResult, CaptureStatus
from timetracker_linux.capture.service import CaptureService
from timetracker_linux.capture.backends.null import NullBackend


def _good_image():
    img = Image.new('RGB', (320, 200), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    for row in range(10):
        draw.text((10, 5 + row * 18), 'PROJ-42 some text on screen', fill=(0, 0, 0))
    return img


class FakeBackend:
    def __init__(self, name, results=None, available=True, block=None):
        self.name = name
        self.results = list(results or [])
        self.available = available
        self.block = block
        self.calls = 0

    def is_available(self):
        if isinstance(self.available, Exception):
            raise self.available
        return self.available

    def capture(self):
        self.calls += 1
        if self.block is not None:
            self.block.wait()
        if self.results:
            result = self.results.pop(0) if len(self.results) > 1 else self.results[0]
        else:
            result = CaptureResult(image=_good_image(), status=CaptureStatus.OK)
        return result


def ok(window_id=None):
    return CaptureResult(image=_good_image(), status=CaptureStatus.OK, window_id=window_id)


def err():
    return CaptureResult(image=None, status=CaptureStatus.ERROR, detail='boom')


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class TestBudget:
    """AC 11"""

    def test_hanging_backend_times_out(self):
        gate = threading.Event()
        slow = FakeBackend('slow', block=gate)
        service = CaptureService([slow], budget_s=0.3)
        start = time.monotonic()
        result = service.capture()
        elapsed = time.monotonic() - start
        gate.set()
        assert result.status == CaptureStatus.TIMEOUT
        assert result.image is None
        assert elapsed < 0.4

    def test_late_result_not_used(self):
        gate = threading.Event()
        slow = FakeBackend('slow', block=gate)
        service = CaptureService([slow], budget_s=0.2)
        first = service.capture()
        assert first.status == CaptureStatus.TIMEOUT
        gate.set()
        time.sleep(0.1)
        assert service.last_result.status == CaptureStatus.TIMEOUT

    def test_still_running_backend_is_not_called_again(self):
        gate = threading.Event()
        slow = FakeBackend('slow', block=gate)
        service = CaptureService([slow], budget_s=0.1)
        service.capture()
        second = service.capture()
        gate.set()
        assert second.status == CaptureStatus.TIMEOUT
        assert slow.calls == 1


class TestFallback:
    """AC 12"""

    def test_switches_after_threshold(self):
        bad = FakeBackend('bad', results=[err()])
        good = FakeBackend('good')
        service = CaptureService([bad, good], failure_threshold=5)
        for _ in range(5):
            assert service.capture().status == CaptureStatus.ERROR
        assert service.active_backend_name == 'good'
        result = service.capture()
        assert result.status == CaptureStatus.OK
        assert result.backend == 'good'
        assert bad.calls == 5

    def test_black_frames_count_as_failures(self):
        black = CaptureResult(image=Image.new('RGB', (320, 200)), status=CaptureStatus.OK)
        bad = FakeBackend('black', results=[black])
        good = FakeBackend('good')
        service = CaptureService([bad, good], failure_threshold=3)
        statuses = [service.capture().status for _ in range(3)]
        assert statuses == [CaptureStatus.BLACK_FRAME] * 3
        assert service.active_backend_name == 'good'

    def test_skips_do_not_count(self):
        skip = CaptureResult(image=None, status=CaptureStatus.SKIPPED_LOCKED)
        a = FakeBackend('a', results=[skip])
        b = FakeBackend('b')
        service = CaptureService([a, b], failure_threshold=2)
        for _ in range(10):
            assert service.capture().status == CaptureStatus.SKIPPED_LOCKED
        assert service.active_backend_name == 'a'

    def test_success_resets_counter(self):
        a = FakeBackend('a', results=[err(), err(), ok(), err(), err()])
        b = FakeBackend('b')
        service = CaptureService([a, b], failure_threshold=3)
        for _ in range(5):
            service.capture()
        assert service.active_backend_name == 'a'

    def test_unavailable_backends_skipped(self):
        a = FakeBackend('a', available=False)
        b = FakeBackend('b', available=RuntimeError('probe failed'))
        c = FakeBackend('c')
        service = CaptureService([a, b, c])
        assert service.capture().backend == 'c'

    def test_null_backend_when_nothing_works(self):
        a = FakeBackend('a', available=False)
        service = CaptureService([a, NullBackend('no capture backend for this desktop')])
        result = service.capture()
        assert result.status == CaptureStatus.BACKEND_UNAVAILABLE
        assert result.image is None
        assert 'no capture backend' in result.detail

    def test_empty_backend_list(self):
        result = CaptureService([]).capture()
        assert result.status == CaptureStatus.BACKEND_UNAVAILABLE

    def test_backend_exception_is_error(self):
        class Exploding(FakeBackend):
            def capture(self):
                raise RuntimeError('kaboom')

        result = CaptureService([Exploding('x')]).capture()
        assert result.status == CaptureStatus.ERROR
        assert 'kaboom' in result.detail


class TestRetryPreferred:
    """AC 13"""

    def _switched_service(self, clock):
        preferred = FakeBackend('preferred', results=[err()])
        fallback = FakeBackend('fallback')
        service = CaptureService([preferred, fallback], failure_threshold=2,
                                 retry_preferred_after_s=1800, clock=clock)
        service.capture()
        service.capture()
        assert service.active_backend_name == 'fallback'
        return service, preferred

    def test_retry_after_interval(self):
        clock = FakeClock()
        service, preferred = self._switched_service(clock)
        preferred.results = [ok()]
        clock.now += 1799
        assert service.capture().backend == 'fallback'
        clock.now += 2
        assert service.capture().backend == 'preferred'

    def test_reprobe_retries_now(self):
        clock = FakeClock()
        service, preferred = self._switched_service(clock)
        preferred.results = [ok()]
        service.reprobe()
        assert service.capture().backend == 'preferred'


class TestStaleWindow:
    """AC 14"""

    def test_mismatched_window_discarded(self):
        backend = FakeBackend('a', results=[ok(window_id='win-B')])
        result = CaptureService([backend]).capture(expected_window_id='win-A')
        assert result.status == CaptureStatus.STALE_WINDOW
        assert result.image is None

    def test_matching_window_kept(self):
        backend = FakeBackend('a', results=[ok(window_id='win-A')])
        result = CaptureService([backend]).capture(expected_window_id='win-A')
        assert result.status == CaptureStatus.OK
        assert result.image is not None

    def test_unknown_window_id_accepted(self):
        backend = FakeBackend('a', results=[ok(window_id=None)])
        assert CaptureService([backend]).capture(expected_window_id='win-A').status == CaptureStatus.OK

    def test_stale_is_not_a_backend_failure(self):
        a = FakeBackend('a', results=[ok(window_id='other')])
        b = FakeBackend('b')
        service = CaptureService([a, b], failure_threshold=2)
        for _ in range(5):
            service.capture(expected_window_id='mine')
        assert service.active_backend_name == 'a'


def test_stats_and_elapsed():
    service = CaptureService([FakeBackend('a')])
    result = service.capture()
    assert result.elapsed_ms is not None and result.elapsed_ms >= 0
    stats = service.stats()
    assert stats['by_status']['OK'] == 1
    assert stats['active_backend'] == 'a'
