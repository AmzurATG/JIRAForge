"""
Tests for OCR pipeline reliability fixes O-1 … O-5.

Spec: plan/2026-09-29_python-desktop-app_ocr-pipeline-reliability.md (AC 1-8)
"""

import os
import sqlite3
import sys
import threading
import time
from unittest.mock import Mock, patch

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import desktop_app as da
from ocr import facade as facade_module
from ocr.facade import OCRFacade


# ------------------------------------------------------------ AC 1-2: in-flight

def _slow_ocr_result(delay):
    def run(*args, **kwargs):
        time.sleep(delay)
        return {'text': 'x', 'method': 'rapidocr', 'confidence': 0.9, 'success': True}
    return run


def test_wait_for_ocr_waits_for_every_job():
    with patch.object(da, 'extract_text_from_image', side_effect=_slow_ocr_result(0.3)):
        processor = da.LocalOCRProcessor()
        try:
            done = []
            assert processor.submit_ocr_async(Image.new('RGB', (4, 4)), lambda r: done.append('a'))
            time.sleep(0.05)            # worker picked up A, queue is empty again
            assert processor.submit_ocr_async(Image.new('RGB', (4, 4)), lambda r: done.append('b'))
            time.sleep(0.35)            # A finished, B running
            assert done == ['a']
            assert processor.wait_for_ocr(timeout=0.05) is False
            assert processor.wait_for_ocr(timeout=2.0) is True
            assert done == ['a', 'b']
        finally:
            processor.shutdown()


def test_queue_full_does_not_change_inflight():
    with patch.object(da, 'extract_text_from_image', side_effect=_slow_ocr_result(0.4)):
        processor = da.LocalOCRProcessor()
        try:
            processor.submit_ocr_async(Image.new('RGB', (4, 4)), lambda r: None)
            time.sleep(0.05)
            processor.submit_ocr_async(Image.new('RGB', (4, 4)), lambda r: None)    # queued
            assert processor.submit_ocr_async(Image.new('RGB', (4, 4)), lambda r: None) is False  # full
            assert processor.wait_for_ocr(timeout=3.0) is True
            assert processor._inflight == 0
        finally:
            processor.shutdown()


# --------------------------------------------------- AC 3: replaceable failures

class MemoryDB:
    def __init__(self):
        self.conn = sqlite3.connect(':memory:', check_same_thread=False)
        self.conn.execute('CREATE TABLE active_sessions (id INTEGER PRIMARY KEY, window_title TEXT, '
                          'application_name TEXT, ocr_text TEXT, ocr_method TEXT, ocr_confidence REAL, '
                          'ocr_error_message TEXT)')

    def get_connection(self):
        return self.conn


def _session_with(method, text=None):
    db = MemoryDB()
    db.conn.execute('INSERT INTO active_sessions (window_title, application_name, ocr_text, ocr_method) '
                    'VALUES (?, ?, ?, ?)', ('T', 'app', text, method))
    return da.ActiveSessionManager(db), db


def _stored(db):
    return db.conn.execute('SELECT ocr_text, ocr_method FROM active_sessions').fetchone()


GOOD = {'text': 'PROJ-9 details', 'method': 'rapidocr', 'confidence': 0.91, 'error_message': None}


@pytest.mark.parametrize('failed_method', ['metadata', 'error'])
def test_failed_result_is_replaced(failed_method):
    manager, db = _session_with(failed_method)
    manager.backfill_ocr('T', 'app', GOOD)
    assert _stored(db) == ('PROJ-9 details', 'rapidocr')


def test_empty_method_is_filled():
    manager, db = _session_with(None)
    manager.backfill_ocr('T', 'app', GOOD)
    assert _stored(db) == ('PROJ-9 details', 'rapidocr')


def test_successful_result_is_never_overwritten():
    manager, db = _session_with('rapidocr', 'original text')
    manager.backfill_ocr('T', 'app', dict(GOOD, text='other'))
    assert _stored(db) == ('original text', 'rapidocr')


def test_failed_result_not_replaced_by_another_failure():
    manager, db = _session_with('metadata')
    manager.backfill_ocr('T', 'app', {'text': None, 'method': 'metadata', 'confidence': 0.0,
                                      'error_message': 'No text found'})
    assert _stored(db) == (None, 'metadata')


# ------------------------------------------------------ AC 4: budgeted backfill

def test_backfill_newest_first_within_budget():
    now = [0.0]
    processed = []

    def ocr_from_image(image):
        processed.append(image)
        now[0] += 3.0               # each OCR takes 3 "seconds"
        return {'text': 't', 'method': 'rapidocr', 'confidence': 0.9}

    tracker = da.TimeTracker.__new__(da.TimeTracker)
    tracker.ocr_processor = Mock(ocr_from_image=ocr_from_image)
    tracker.session_manager = Mock()
    pending = {(f'title{i}', 'app'): f'img{i}' for i in range(10)}
    count = tracker._backfill_pending_ocr(pending, budget_s=20, clock=lambda: now[0])
    assert processed[:3] == ['img9', 'img8', 'img7']
    assert count == 7                                   # 7 × 3 s fits in 20 s (stops once over)
    assert tracker.session_manager.backfill_ocr.call_count == 7


def test_backfill_without_ocr_processor():
    tracker = da.TimeTracker.__new__(da.TimeTracker)
    tracker.ocr_processor = None
    tracker.session_manager = Mock()
    assert tracker._backfill_pending_ocr({('t', 'a'): 'img'}, budget_s=20) == 0


# ------------------------------------------------------- AC 5-6: honest reasons

class FakeEngine:
    def __init__(self, result):
        self.result = result

    def get_name(self):
        return 'rapidocr'

    def is_available(self):
        return True

    def extract_text(self, image):
        return dict(self.result)


def _facade(result):
    facade = OCRFacade.__new__(OCRFacade)
    facade.config = da.OCRConfig() if hasattr(da, 'OCRConfig') else __import__('ocr').OCRConfig()
    facade._primary_engine = FakeEngine(result)
    facade._fallback_engines = []
    facade._engine_failure_counts = {}
    facade._engine_backoff_until = {}
    facade._engine_backoff_seconds = 120.0
    facade._engine_init_errors = {}
    facade._privacy_filter = None
    from ocr.tabular_enricher import TabularContextEnricher
    facade._tabular_enricher = TabularContextEnricher()
    return facade


def test_engine_error_is_labelled_and_counted():
    facade = _facade({'text': '', 'confidence': 0.0, 'success': False, 'error': 'onnx session died'})
    result = facade.extract_text(Image.new('RGB', (40, 20)), screenshot_mode=True)
    assert 'Engine error: onnx session died' in result['error_message']
    assert 'Confidence too low' not in result['error_message']
    assert facade._engine_failure_counts['rapidocr'] == 1


def test_no_text_is_not_a_failure():
    facade = _facade({'text': '', 'confidence': 0.0, 'success': True, 'line_count': 0})
    result = facade.extract_text(Image.new('RGB', (40, 20)), screenshot_mode=True)
    assert 'No text found' in result['error_message']
    assert facade._engine_failure_counts.get('rapidocr', 0) == 0


# ------------------------------------------------------------- AC 7: one facade

def test_concurrent_get_facade_builds_once():
    built = []

    class CountingFacade:
        def __init__(self, config=None):
            time.sleep(0.05)
            built.append(self)

        def log_diagnostics(self):
            pass

    facade_module.reset_facade()
    with patch.object(facade_module, 'OCRFacade', CountingFacade):
        threads = [threading.Thread(target=facade_module.get_facade) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    facade_module.reset_facade()
    assert len(built) == 1


# ------------------------------------------------------------ AC 8: BGR input

@pytest.mark.parametrize('image, expected_first_pixel', [
    (np.array([[[255, 0, 0]]], dtype=np.uint8), [0, 0, 255]),              # RGB red → BGR
    (np.array([[[255, 0, 0, 128]]], dtype=np.uint8), [0, 0, 255]),         # RGBA red → BGR
    (np.array([[77]], dtype=np.uint8), [77, 77, 77]),                      # gray → BGR
])
def test_rapidocr_receives_bgr(image, expected_first_pixel):
    from ocr.engines.rapidocr_engine import RapidOCREngine
    engine = RapidOCREngine()
    seen = {}

    def fake_ocr(array):
        seen['array'] = array
        return (None, None)

    engine._ocr = fake_ocr
    with patch('ocr.engines.rapidocr_engine._RAPIDOCR_AVAILABLE', True):
        engine.extract_text(image)
    assert seen['array'].shape[-1] == 3
    assert seen['array'][0, 0].tolist() == expected_first_pixel
