"""Helpers shared by capture backends."""

from ..result import CaptureResult, CaptureStatus


def precheck_window(window, backend_name):
    """Skip result for windows that must not be captured, else None."""
    if window is None:
        return CaptureResult(image=None, status=CaptureStatus.SKIPPED_NO_FOCUS, backend=backend_name,
                             detail='no focused window')
    if window.get('minimized'):
        return CaptureResult(image=None, status=CaptureStatus.SKIPPED_MINIMIZED, backend=backend_name,
                             window_id=window.get('window_id'), detail='focused window is minimized')
    return None
