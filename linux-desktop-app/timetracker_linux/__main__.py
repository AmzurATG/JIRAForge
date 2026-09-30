"""
Entry point: `python -m timetracker_linux` and the frozen TimeTracker binary.

  (no args)      start the tracker (tray + local web UI)
  --autostart    same, started from the XDG autostart entry
  --doctor       print desktop capabilities and chosen backends
  --self-test    check the bundle (imports, OCR, privacy filter, SQLCipher)
"""

import argparse
import sys


def main(argv=None):
    parser = argparse.ArgumentParser(prog='timetracker')
    parser.add_argument('--doctor', action='store_true',
                        help='print desktop capabilities and the backends that will be used')
    parser.add_argument('--json', action='store_true', help='with --doctor: JSON output')
    parser.add_argument('--self-test', action='store_true', help='verify the installed bundle and exit')
    parser.add_argument('--autostart', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    if args.doctor:
        from .doctor import main as doctor_main
        return doctor_main(as_json=args.json)
    if args.self_test:
        from .self_test import main as self_test_main
        return self_test_main()

    from .launcher import run_app
    return run_app()


if __name__ == '__main__':
    sys.exit(main())
