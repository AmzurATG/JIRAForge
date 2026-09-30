"""Interface every capture backend implements."""

from typing import Protocol

from ..result import CaptureResult


class CaptureBackend(Protocol):
    name: str

    def is_available(self) -> bool:
        """Cheap check that this backend can work in the current session."""

    def capture(self) -> CaptureResult:
        """Capture the focused window's monitor.

        Must return one monitor's image, or a result with image=None and a
        status explaining why. Must never return several monitors.
        May block; CaptureService enforces the time budget.
        """
