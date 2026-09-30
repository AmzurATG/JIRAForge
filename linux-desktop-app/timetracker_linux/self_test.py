"""
`timetracker --self-test`: verify an installed bundle works on this machine.

Run by the package smoke tests in clean containers of every supported
distro (plan §6.14 step 6). Needs no display, no login and no network.
Exit code 0 only if every check passes.
"""

import os
import sys
import tempfile
import time
import traceback


def _check_imports():
    from .launcher import ensure_core_importable
    ensure_core_importable()
    os.environ.setdefault('PYSTRAY_BACKEND', 'dummy')
    import flask, supabase, requests, keyring, psutil, jeepney  # noqa: F401
    import db_connection, auth, ocr, privacy, monitor_capture, platform_hooks  # noqa: F401
    return 'core and third-party modules import'


def _check_ocr():
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new('RGB', (900, 200), 'white')
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.load_default(size=40)
    except TypeError:
        font = ImageFont.load_default()
    draw.text((20, 60), 'PROJ-1234 Sprint review', fill='black', font=font)
    from ocr.engines.rapidocr_engine import RapidOCREngine
    engine = RapidOCREngine()
    if not engine.is_available():
        raise RuntimeError('RapidOCR engine not available (models missing from the bundle?)')
    import numpy as np
    result = engine.extract_text(np.array(image))
    text = (result.get('text') or '').upper()
    if 'PROJ' not in text:
        raise RuntimeError(f'unexpected OCR text: {text!r}')
    return f"RapidOCR read {text.strip()!r}"


def _check_privacy():
    from privacy import PrivacyFilter
    privacy_filter = PrivacyFilter()
    # Presidio + spaCy must really be running: regex detectors alone still redact
    # e-mail addresses, which hid a broken Presidio in an earlier build.
    presidio = [d for d in getattr(privacy_filter, '_detectors', [])
                if type(d).__name__ == 'PresidioDetector']
    if not presidio or not getattr(presidio[0], '_available', False) or presidio[0]._analyzer is None:
        raise RuntimeError('Presidio is not active: PII detection would be regex-only')
    engine = type(presidio[0]._analyzer.nlp_engine).__name__
    if 'Spacy' not in engine:
        raise RuntimeError(f'Presidio runs without spaCy ({engine}): names/addresses not detected')
    redacted = privacy_filter.redact('contact john.doe@example.com today')
    if 'john.doe@example.com' in redacted.get('text', ''):
        raise RuntimeError('privacy filter did not redact an e-mail address')
    return f"Presidio + {engine} active; redacted {redacted.get('redactions_count', '?')} item(s)"


def _check_sqlcipher():
    from db_connection import SQLCIPHER_AVAILABLE, sqlcipher
    if not SQLCIPHER_AVAILABLE:
        raise RuntimeError('sqlcipher3 is not importable; the offline DB would be unencrypted')
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'test.db')
        conn = sqlcipher.connect(path)
        conn.execute("PRAGMA key = \"x'" + '0' * 64 + "'\"")
        conn.execute('CREATE TABLE t (x)')
        conn.execute('INSERT INTO t VALUES (1)')
        conn.commit()
        conn.close()
        with open(path, 'rb') as f:
            if f.read(16).startswith(b'SQLite format 3'):
                raise RuntimeError('database file is not encrypted')
    return 'SQLCipher encrypts the offline database'


def _check_keyring():
    import keyring
    backend = keyring.get_keyring()
    name = f'{type(backend).__module__}.{type(backend).__name__}'
    if name.startswith('keyring.backends.fail'):
        return f'keyring backend {name} (no Secret Service here; encrypted-file fallback will be used)'
    return f'keyring backend {name}'


CHECKS = [
    ('imports', _check_imports),
    ('ocr', _check_ocr),
    ('privacy', _check_privacy),
    ('sqlcipher', _check_sqlcipher),
    ('keyring', _check_keyring),
]


def main():
    failures = 0
    for name, check in CHECKS:
        start = time.monotonic()
        try:
            detail = check()
            print(f'[PASS] {name:<10} {detail} ({time.monotonic() - start:.1f}s)')
        except Exception as e:
            failures += 1
            print(f'[FAIL] {name:<10} {type(e).__name__}: {e}')
            if os.environ.get('TIMETRACKER_SELF_TEST_VERBOSE'):
                traceback.print_exc()
    print('self-test ' + ('passed' if not failures else f'FAILED ({failures} check(s))'))
    return 0 if not failures else 1


if __name__ == '__main__':
    sys.exit(main())
