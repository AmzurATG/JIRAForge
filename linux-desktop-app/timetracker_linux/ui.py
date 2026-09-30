"""
Linux additions to the local web UI (consent page paragraph, Settings status
card) and the "Remove my data and sign out" action (plan §6.11, §6.15, §8.2).

HTML fragments reuse the core pages' CSS classes. All dynamic values are
escaped.
"""

import html
import logging
import os
import shutil

from . import autostart, paths

logger = logging.getLogger(__name__)

KEYRING_SERVICE = 'TimeTracker'
EXTRA_KEYRING_KEYS = ('db_encryption_key', 'screencast_restore_token')


def consent_section_html():
    return '''
        <div class="section">
            <div class="section-title">Linux desktops</div>
            <div class="data-item">
                <span class="data-icon">&#128421;</span>
                <div class="data-text">
                    <strong>Reading the screen you work on</strong>
                    <span>TimeTracker reads the text on the monitor you are using, on this computer.
                    The picture itself is never saved or uploaded.</span>
                </div>
            </div>
            <div class="data-item">
                <span class="data-icon">&#128274;</span>
                <div class="data-text">
                    <strong>One-time permission</strong>
                    <span>Some Linux desktops ask once for screen access. Select the monitors you work on
                    and choose "Remember". On GNOME you may be asked to log out and back in once.</span>
                </div>
            </div>
            <div class="data-item">
                <span class="data-icon">&#128308;</span>
                <div class="data-text">
                    <strong>Screen-sharing indicator</strong>
                    <span>Your desktop may show a "screen is being shared" icon while tracking is active.
                    It disappears when you pause, lock the screen or are away.</span>
                </div>
            </div>
        </div>
'''


def _status_rows(provider):
    d = provider.diagnostics()
    capture = provider.get_capture_status() or {}
    last = capture.get('last') or {}
    capture_line = capture.get('active_backend') or 'none'
    if capture_line == 'null':
        capture_line = 'unavailable'
    detail = last.get('detail') if last.get('status') not in (None, 'OK') else ''
    window = d.get('window_backend') or ('unavailable' if not provider.has_window_source() else 'starting')
    rows = [
        ('Desktop', f"{d.get('desktop_raw') or d.get('desktop')} ({d.get('session_type')})"),
        ('Window tracking', window),
        ('Screen text capture', capture_line + (f' - {detail}' if detail else '')),
        ('Idle detection', d.get('idle_backend') or 'unavailable'),
    ]
    return ''.join(
        f'<div class="setting-row"><div class="setting-info"><div class="setting-label">{html.escape(k)}</div>'
        f'<div class="setting-description">{html.escape(str(v))}</div></div></div>' for k, v in rows)


def settings_section_html(provider):
    has_portal = any(getattr(b, 'name', '') == 'portal_screencast'
                     for b in getattr(provider.capture_service, '_backends', []))
    allow_button = ('<button type="button" onclick="ttAllowScreen()">Allow screen access</button>'
                    if has_portal else '')
    return f'''
                <div class="setting-section" id="linux-integration">
                    <h3>&#128039; Linux desktop integration</h3>
                    {_status_rows(provider)}
                    <div style="margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap;">
                        {allow_button}
                        <button type="button" style="background:#dc3545;color:#fff" onclick="ttRemoveData()">
                            Remove my data and sign out</button>
                    </div>
                    <script>
                    function ttLinuxPost(url) {{
                        return fetch(url, {{method: 'POST', headers: {{'Content-Type': 'application/json'}},
                                            body: JSON.stringify({{confirm: true}})}})
                            .then(r => r.json()).then(d => alert(d.message))
                            .catch(() => alert('Request failed'));
                    }}
                    function ttAllowScreen() {{
                        ttLinuxPost('/api/platform/allow-screen-access');
                    }}
                    function ttRemoveData() {{
                        if (confirm('Sign out and delete all TimeTracker data on this computer? ' +
                                    'Data already synced to your organization is not affected.')) {{
                            ttLinuxPost('/api/platform/remove-my-data');
                        }}
                    }}
                    </script>
                </div>
'''


def is_local_origin(origin, web_port):
    """True only for requests made by the app's own pages (browsers set Origin)."""
    return origin in (f'http://localhost:{web_port}', f'http://127.0.0.1:{web_port}')


def _safe_rmtree(path, expected_leaf):
    if path and os.path.basename(os.path.normpath(path)).lower() == expected_leaf.lower() and os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)


def remove_user_data(app, keyring_module=None, sensitive_keys=()):
    """Sign out and delete this user's local TimeTracker data. Returns a summary list."""
    done = []
    try:
        app.stop_tracking()
    except Exception:
        pass
    try:
        app.auth_manager.logout()
        done.append('signed out')
    except Exception as e:
        logger.warning(f'[LINUX] logout during data removal failed: {e}')
    try:
        app.db_manager.close_all()
    except Exception:
        pass
    if keyring_module is None:
        try:
            import keyring as keyring_module
        except Exception:
            keyring_module = None
    if keyring_module is not None:
        for key in tuple(sensitive_keys) + EXTRA_KEYRING_KEYS:
            for suffix in ('', '_chunks') + tuple(f'_chunk_{i}' for i in range(16)):
                try:
                    keyring_module.delete_password(KEYRING_SERVICE, key + suffix)
                except Exception:
                    pass
        done.append('keyring entries deleted')
    autostart.disable()
    done.append('autostart disabled')
    _safe_rmtree(paths.data_dir(), 'TimeTracker')
    _safe_rmtree(paths.config_dir(), 'timetracker')
    _safe_rmtree(paths.state_dir(), 'TimeTracker')
    done.append('local data deleted')
    logger.info(f"[LINUX] user data removed: {', '.join(done)}")
    return done
