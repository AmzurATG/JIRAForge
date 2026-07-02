"""
PROOF / REGRESSION TEST: Email & Chat on-screen BODY redaction.

This exercises the REAL shipped code in desktop_app.py (not a replica):
  - the actual TimeTracker._should_redact_body() decision,
  - the actual REDACTED_BODY_PLACEHOLDER value,
  - the actual title-marker / process lists.

It proves that when the user is in Gmail, Google Chat or Outlook, the on-screen
BODY is masked to '***' (the screen text is never OCR'd, so it cannot be stored
locally or uploaded), while the window TITLE is still kept and the time is still
tracked. It also proves that normal work apps (VS Code, Jira, Slack, etc.) are
unchanged.

How the value gets used in production (for reviewers):
  - desktop_app.process_window_event(): when _should_redact_body() is True the
    productive/unknown branch SKIPS OCR and sets the record body to
    REDACTED_BODY_PLACEHOLDER ('***').
  - desktop_app.should_skip_screenshot(): the same surfaces are skipped on the
    legacy screenshot path too (defence in depth).

Run as a readable proof report (what to show end users):
    python tests/test_email_chat_body_redaction.py

Run under pytest (suite / CI):
    python -m pytest tests/test_email_chat_body_redaction.py -v
"""
import os
import sys

# Make desktop_app importable whether invoked from the repo root or tests/.
APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

import desktop_app  # the real module under test

# Build a TimeTracker WITHOUT running __init__ (no auth/DB/tray side effects).
# _should_redact_body() reads only module-level config + its arguments, so this
# guarantees we are calling the exact shipped method, not a re-implementation.
_TT = desktop_app.TimeTracker.__new__(desktop_app.TimeTracker)


def _redacts(app_name, window_title):
    """Call the real shipped decision function."""
    return _TT._should_redact_body(app_name, window_title)


# (process_name, window_title, human_description)
EMAIL_CHAT_SURFACES = [
    ('chrome.exe',   'Inbox (12) - jane.doe@company.com - Gmail',   'Gmail (Chrome)'),
    ('msedge.exe',   'Sent - jane@company.com - Gmail',             'Gmail (Edge)'),
    ('chrome.exe',   'mail.google.com/mail/u/0/#inbox',             'Gmail (URL in title)'),
    ('chrome.exe',   'Acme Project - Google Chat',                  'Google Chat (Chrome)'),
    ('chrome.exe',   'chat.google.com/u/0/#chat/space/AAA',         'Google Chat (URL in title)'),
    ('chrome.exe',   'Mail - Jane Doe - Outlook',                   'Outlook on the web'),
    ('outlook.exe',  'Inbox - jane@company.com - Outlook',          'Outlook desktop (classic)'),
    ('HxOutlook.exe', 'Mail',                                       'New Outlook / Windows Mail'),
    ('olk.exe',      'Inbox',                                       'New Outlook (olk.exe)'),
]

NORMAL_WORK_SURFACES = [
    ('code.exe',     'auth.py - myproject - Visual Studio Code',    'VS Code'),
    ('chrome.exe',   'SCRUM-42 Fix login bug - Jira',               'Jira board'),
    ('chrome.exe',   'React useEffect - Stack Overflow',            'Stack Overflow'),
    ('chrome.exe',   'Sprint Planning - Confluence',                'Confluence'),
    ('slack.exe',    'general (Acme) - Slack',                      'Slack desktop'),
    ('explorer.exe', 'Documents',                                   'File Explorer'),
]


# --------------------------------------------------------------------------
# pytest tests (these run the real code)
# --------------------------------------------------------------------------

def test_body_mask_value_is_three_stars():
    assert desktop_app.REDACTED_BODY_PLACEHOLDER == '***'


def test_email_and_chat_bodies_are_redacted():
    for app, title, desc in EMAIL_CHAT_SURFACES:
        assert _redacts(app, title) is True, \
            "%s should be body-redacted: app=%r title=%r" % (desc, app, title)


def test_normal_work_apps_are_not_redacted():
    for app, title, desc in NORMAL_WORK_SURFACES:
        assert _redacts(app, title) is False, \
            "%s must NOT be redacted: app=%r title=%r" % (desc, app, title)


def test_empty_and_unknown_inputs_are_safe():
    assert _redacts('', '') is False
    assert _redacts(None, None) is False
    # A marker word in a NON-browser, NON-mail process must not trigger redaction.
    assert _redacts('explorer.exe', 'Gmail') is False


def test_target_surfaces_are_configured():
    assert 'gmail' in desktop_app.REDACTED_BODY_TITLE_MARKERS
    assert 'google chat' in desktop_app.REDACTED_BODY_TITLE_MARKERS
    assert 'outlook' in desktop_app.REDACTED_BODY_TITLE_MARKERS
    assert 'outlook.exe' in desktop_app.REDACTED_BODY_PROCESSES


# --------------------------------------------------------------------------
# End-to-end: drive the REAL process_window_event and read the stored row
# --------------------------------------------------------------------------

def _drive_pipeline(app_name, window_title, classification='productive'):
    """Run the REAL TimeTracker.process_window_event end-to-end against a
    throwaway in-memory session DB and return the row written to active_sessions.

    Only what the handler needs is wired up:
      - a real ActiveSessionManager backed by an in-memory SQLite DB,
      - a stub classifier (so we control the classification deterministically),
      - ocr.facade.get_facade patched to a no-op (the title PII step is not what
        this case covers and would otherwise load the OCR/Presidio stack).
    The OCR processor is None on purpose: for email/chat the handler must reach
    the masked-body branch WITHOUT attempting OCR.
    """
    import sqlite3
    import types
    import ocr.facade as facade_mod

    conn = sqlite3.connect(':memory:', check_same_thread=False)
    conn.execute(
        '''CREATE TABLE active_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            window_title TEXT, application_name TEXT, classification TEXT,
            ocr_text TEXT, ocr_method TEXT, ocr_confidence REAL, ocr_error_message TEXT,
            total_time_seconds REAL DEFAULT 0, visit_count INTEGER DEFAULT 1,
            first_seen TEXT, last_seen TEXT, timer_started_at TEXT)'''
    )
    conn.commit()

    class _StubDB:
        def get_connection(self):
            return conn

    class _StubClassifier:
        def classify(self, app, title):
            return (classification, 'url')

    sm = desktop_app.ActiveSessionManager(_StubDB())

    tt = desktop_app.TimeTracker.__new__(desktop_app.TimeTracker)
    tt.classification_manager = _StubClassifier()
    tt.session_manager = sm
    tt.ocr_processor = None  # email/chat path must NOT require OCR

    saved = getattr(facade_mod, 'get_facade', None)
    facade_mod.get_facade = lambda *a, **k: types.SimpleNamespace(_privacy_filter=None)
    try:
        tt.process_window_event({'app': app_name, 'title': window_title})
    finally:
        if saved is not None:
            facade_mod.get_facade = saved

    cur = conn.cursor()
    cur.execute('SELECT window_title, application_name, classification, '
                'ocr_text, ocr_method, ocr_confidence FROM active_sessions')
    rows = cur.fetchall()
    conn.close()
    if not rows:
        return None
    wt, an, cl, ocr_text, ocr_method, ocr_conf = rows[0]
    return {'window_title': wt, 'application_name': an, 'classification': cl,
            'ocr_text': ocr_text, 'ocr_method': ocr_method, 'ocr_confidence': ocr_conf}


def test_e2e_gmail_body_stored_as_mask():
    row = _drive_pipeline('chrome.exe', 'Inbox (3) - jane@company.com - Gmail')
    assert row is not None, "expected a session row to be written"
    assert row['ocr_text'] == '***'
    assert row['ocr_method'] == 'redacted_body'


def test_e2e_outlook_desktop_body_stored_as_mask():
    row = _drive_pipeline('outlook.exe', 'Inbox - jane@company.com - Outlook')
    assert row is not None
    assert row['ocr_text'] == '***'
    assert row['ocr_method'] == 'redacted_body'


def test_e2e_title_is_preserved_verbatim():
    title = 'Acme Project - Google Chat'
    row = _drive_pipeline('chrome.exe', title)
    assert row is not None
    assert row['window_title'] == title   # title kept (still tracked)
    assert row['ocr_text'] == '***'       # body masked


def test_e2e_normal_app_is_not_masked():
    # A normal app with no OCR processor takes the OCR branch and returns early,
    # so NO masked row is written. Proves the mask is scoped to email/chat only.
    row = _drive_pipeline('code.exe', 'auth.py - myproject - Visual Studio Code')
    assert row is None


# --------------------------------------------------------------------------
# Human-readable proof report (for demos / end users)
# --------------------------------------------------------------------------

def _print_report():
    star = desktop_app.REDACTED_BODY_PLACEHOLDER
    passed = 0
    failed = 0
    line = '=' * 78
    print(line)
    print(' EMAIL & CHAT BODY REDACTION - PROOF REPORT')
    print(' Source under test : desktop_app.py  (TimeTracker._should_redact_body)')
    print(' Body mask value   : %r' % star)
    print(line)

    print('')
    print(' GROUP A - Email / Chat: on-screen BODY must become %r (never captured)' % star)
    print(' ' + '-' * 76)
    for app, title, desc in EMAIL_CHAT_SURFACES:
        red = _redacts(app, title)
        ok = (red is True)
        passed += ok
        failed += (not ok)
        if red:
            body = "BODY=%r  (screen text NOT captured), TITLE kept, time tracked" % star
        else:
            body = "BODY=OCR'd screen text   <<< LEAK >>>"
        print("  [%s] %-28s %-13s %s" % ('PASS' if ok else 'FAIL', desc, app, body))

    print('')
    print(' GROUP B - Normal work apps: must be UNCHANGED (body still OCR\'d)')
    print(' ' + '-' * 76)
    for app, title, desc in NORMAL_WORK_SURFACES:
        red = _redacts(app, title)
        ok = (red is False)
        passed += ok
        failed += (not ok)
        if red:
            body = "BODY masked   <<< OVER-REDACTION >>>"
        else:
            body = "BODY=OCR'd screen text (normal capture)"
        print("  [%s] %-28s %-13s %s" % ('PASS' if ok else 'FAIL', desc, app, body))

    print('')
    print(' GROUP C - End-to-end: drive the REAL process_window_event, read DB row')
    print(' ' + '-' * 76)
    e2e = [
        ('chrome.exe',  'Inbox (3) - jane@company.com - Gmail', 'Gmail'),
        ('chrome.exe',  'Acme Project - Google Chat',           'Google Chat'),
        ('outlook.exe', 'Inbox - jane@company.com - Outlook',   'Outlook desktop'),
    ]
    for app, title, desc in e2e:
        row = _drive_pipeline(app, title)
        ok = bool(row) and row['ocr_text'] == star and row['ocr_method'] == 'redacted_body'
        passed += ok
        failed += (not ok)
        if row:
            detail = "DB row: ocr_text=%r ocr_method=%r title=%r" % (
                row['ocr_text'], row['ocr_method'], row['window_title'])
        else:
            detail = "no row written   <<< unexpected >>>"
        print("  [%s] %-18s %-12s %s" % ('PASS' if ok else 'FAIL', desc, app, detail))

    row = _drive_pipeline('code.exe', 'auth.py - myproject - Visual Studio Code')
    ok = (row is None)
    passed += ok
    failed += (not ok)
    print("  [%s] %-18s %-12s %s" % ('PASS' if ok else 'FAIL', 'VS Code (control)',
          'code.exe', 'no masked row written (took the OCR path)' if ok
          else 'unexpectedly wrote a masked row'))

    print('')
    print(line)
    print(' RESULT : %d passed, %d failed' % (passed, failed))
    print(' VERDICT: %s' % ('EMAIL & CHAT BODY REDACTION VERIFIED'
                            if failed == 0 else 'FAILED - DO NOT SHIP'))
    print(line)
    return failed == 0


if __name__ == '__main__':
    sys.exit(0 if _print_report() else 1)
