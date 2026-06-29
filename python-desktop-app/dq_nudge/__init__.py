"""
Description-Quality Nudge package (Enhancement #13).

Background poller + tkinter popup that surfaces server-generated nudges for
Jira tickets whose description quality score is below threshold.

Plan: docs/jira_ticket_description_enhancement/13_SCHEDULED_QUALITY_NOTIFICATIONS.md
"""

from .poller import DqNudgePoller
from .popup import DqNudgePopupWindow
from .ack_client import acknowledge_nudges
from .preferences import DqNudgePreferences

__all__ = [
    'DqNudgePoller',
    'DqNudgePopupWindow',
    'acknowledge_nudges',
    'DqNudgePreferences',
]
