"""
Phase 1 validation gate: Atlassian repeated-authorization behavior.
Plan: plan/2026-06-12_auth_server-side-token-custody.md

Empirically answers the one question Atlassian does not document:
when the SAME user authorizes the app a SECOND time, does the FIRST
refresh-token chain keep working, or is it invalidated?

Also confirms the documented 10-minute reuse interval that the server-side
custody retry logic relies on.

USAGE (run with any Python 3.8+ that has `requests`):
    1. QUIT the TimeTracker tray app (it occupies port 51777).
    2. Make sure the browser is logged in to the DISPOSABLE Atlassian test
       account only (never a real user's — this test kills token chains).
    3. python scripts/phase1_rotation_grant_test.py
    4. Click "Accept" twice when the browser opens (check the consent page
       shows the TEST account's email each time).

The script never prints token values — only outcomes. Results are written to
scripts/phase1_results.md.

SAFETY: read-only against the AI server (code exchange + refresh proxy only —
no user rows are created; migrate-custody is intentionally NOT called).
"""

import base64
import hashlib
import http.server
import json
import os
import secrets
import threading
import time
import webbrowser
from datetime import datetime, timezone

import requests

AI_SERVER = os.environ.get('PHASE1_AI_SERVER', 'https://timetracker-forge.amzur.com')
REDIRECT_URI = 'http://localhost:51777/auth/callback'
AUTHORIZE_URL = 'https://auth.atlassian.com/authorize'
SCOPES = 'read:me read:jira-work write:jira-work offline_access'
PORT = 51777

RESULTS = []


def log_result(step, outcome, detail):
    RESULTS.append({'step': step, 'outcome': outcome, 'detail': detail,
                    'at': datetime.now(timezone.utc).isoformat()})
    print(f"  [{outcome}] {step} — {detail}")


def get_client_id():
    r = requests.get(f"{AI_SERVER}/api/auth/config", timeout=15)
    r.raise_for_status()
    client_id = r.json().get('clientId')
    if not client_id:
        raise SystemExit('AI server did not return a clientId')
    return client_id


class _CodeCatcher(http.server.BaseHTTPRequestHandler):
    """One-shot localhost listener that captures the OAuth ?code=... redirect."""
    captured = {}

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(self.path)
        if parsed.path != '/auth/callback':
            self.send_response(404)
            self.end_headers()
            return
        params = parse_qs(parsed.query)
        _CodeCatcher.captured = {
            'code': (params.get('code') or [None])[0],
            'state': (params.get('state') or [None])[0],
            'error': (params.get('error') or [None])[0],
        }
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'<h2>Captured. You can close this tab and return to the terminal.</h2>')

    def log_message(self, *args):
        pass  # silence request logging


def authorize_once(client_id, label):
    """Run one full authorization: browser consent -> code -> tokens."""
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b'=').decode()
    state = secrets.token_urlsafe(24)

    from urllib.parse import urlencode
    url = AUTHORIZE_URL + '?' + urlencode({
        'audience': 'api.atlassian.com',
        'client_id': client_id,
        'scope': SCOPES,
        'redirect_uri': REDIRECT_URI,
        'state': state,
        'response_type': 'code',
        'prompt': 'consent',
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
    })

    _CodeCatcher.captured = {}
    server = http.server.HTTPServer(('localhost', PORT), _CodeCatcher)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    print(f"\n=== Authorization {label} ===")
    print("Opening browser. VERIFY the consent page shows the TEST account, then Accept.")
    webbrowser.open(url)

    deadline = time.time() + 300
    try:
        while time.time() < deadline and not _CodeCatcher.captured.get('code') \
                and not _CodeCatcher.captured.get('error'):
            time.sleep(0.5)
    finally:
        server.shutdown()

    cap = _CodeCatcher.captured
    if cap.get('error'):
        raise SystemExit(f"Authorization {label} failed: {cap['error']}")
    if not cap.get('code'):
        raise SystemExit(f"Authorization {label} timed out (no consent within 5 minutes)")
    if cap.get('state') != state:
        raise SystemExit(f"Authorization {label}: state mismatch — aborting")

    r = requests.post(f"{AI_SERVER}/api/auth/atlassian/callback", json={
        'code': cap['code'],
        'redirect_uri': REDIRECT_URI,
        'code_verifier': verifier,
    }, timeout=30)
    body = r.json()
    if r.status_code != 200 or not body.get('success'):
        raise RuntimeError(f"Code exchange {label} failed: HTTP {r.status_code} {body.get('error')}")
    log_result(f'authorize {label}', 'OK', 'code exchanged, chain established')
    return {'access': body['access_token'], 'refresh': body['refresh_token']}


STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'phase1_state.json')


def authorize_with_retry(client_id, label, max_attempts=3):
    """Authorization codes are single-use and short-lived; a double-submitted
    consent or stale tab yields 'authorization_code is invalid'. Retry with a
    fresh PKCE pair instead of losing the whole run. Established chains are
    persisted so a later crash can never lose an earlier authorization."""
    state = {}
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, 'r', encoding='utf-8') as f:
            state = json.load(f)
    if label in state:
        print(f"[resume] chain {label} already established in a previous run — reusing")
        return state[label]

    last_error = None
    for attempt in range(1, max_attempts + 1):
        try:
            chain = authorize_once(client_id, f'{label} (attempt {attempt})')
            state[label] = chain
            with open(STATE_FILE, 'w', encoding='utf-8') as f:
                json.dump(state, f)
            return chain
        except RuntimeError as e:
            last_error = e
            print(f"  [RETRY] {e}")
            print("  Close any leftover Atlassian tabs, then accept the NEW consent that opens.")
    raise SystemExit(f"Authorization {label} failed after {max_attempts} attempts: {last_error}")


def try_refresh(refresh_token, step):
    """Refresh via the AI server proxy; returns (ok, new_refresh_or_None)."""
    r = requests.post(f"{AI_SERVER}/api/auth/refresh-token",
                      json={'refresh_token': refresh_token}, timeout=30)
    try:
        body = r.json()
    except Exception:
        body = {}
    if r.status_code == 200 and body.get('success'):
        log_result(step, 'OK', 'refresh succeeded (chain alive, rotated)')
        return True, body.get('refresh_token')
    detail = f"HTTP {r.status_code} errorCode={body.get('errorCode')} error={body.get('error')!r}"
    log_result(step, 'REJECTED', detail)
    return False, None


def main():
    print(f"Phase 1 gate test — AI server: {AI_SERVER}")
    client_id = get_client_id()
    print(f"Client ID acquired from server config ({client_id[:6]}...)")

    # Two independent authorizations by the same test account.
    chain_a = authorize_with_retry(client_id, 'A')
    chain_b = authorize_with_retry(client_id, 'B')

    print("\n=== Measurements ===")

    # T1 — THE key question: does chain A survive a second authorization?
    ok_a1, rt_a2 = try_refresh(chain_a['refresh'],
                               'T1: refresh chain A AFTER authorization B was created')

    # T2 — sanity: the newest chain must work.
    ok_b1, rt_b2 = try_refresh(chain_b['refresh'],
                               'T2: refresh chain B (newest grant)')

    # T3 — cross-effect: after B rotated, is A (still) usable?
    if ok_a1 and rt_a2:
        try_refresh(rt_a2, 'T3: refresh chain A again after chain B rotated')
    else:
        log_result('T3: refresh chain A again after chain B rotated', 'SKIPPED',
                   'chain A already dead at T1')

    # T4 — documented 10-minute reuse interval: RT_B1 was consumed at T2 moments
    # ago; per Atlassian docs a prompt same-token retry must still succeed.
    if ok_b1:
        try_refresh(chain_b['refresh'],
                    'T4: REUSE chain B\'s consumed token within the 10-min window')
    else:
        log_result('T4: reuse window check', 'SKIPPED', 'chain B refresh failed at T2')

    # Write findings.
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'phase1_results.md')
    with open(out, 'w', encoding='utf-8') as f:
        f.write('# Phase 1 gate results — Atlassian repeated-authorization behavior\n\n')
        f.write(f'Run: {datetime.now(timezone.utc).isoformat()}  \n')
        f.write(f'AI server: {AI_SERVER}  \n\n')
        f.write('| Step | Outcome | Detail |\n|---|---|---|\n')
        for row in RESULTS:
            f.write(f"| {row['step']} | {row['outcome']} | {row['detail']} |\n")
        f.write('\n## Interpretation\n\n')
        f.write('- **T1 OK** -> old chains survive re-authorization: multi-device users are unaffected during rollout.\n')
        f.write('- **T1 REJECTED** -> a new login kills prior chains: a second-device login forces a one-time re-login on the first device (handled by the re-login prompt).\n')
        f.write('- **T4 OK** -> the 10-minute reuse interval is confirmed; the server-side same-token retry is safe.\n')
    print(f"\nResults written to {out}")
    # The state file holds the disposable account's (now mostly consumed)
    # tokens — remove it the moment the measurements are done.
    try:
        os.remove(STATE_FILE)
        print("Token state file deleted.")
    except OSError:
        pass
    print("Done. The disposable account can now be deleted / its app access revoked.")


if __name__ == '__main__':
    main()
