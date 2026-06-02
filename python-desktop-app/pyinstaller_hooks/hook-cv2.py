# Patched hook-cv2.py
#
# Overrides the upstream _pyinstaller_hooks_contrib version which crashes with
# TypeError when cv2 is installed as a namespace package (no __file__ / origin).
# This happens with some opencv-python builds where the compiled extension (.so)
# is missing or placed in a non-standard location.
#
# If cv2 has a proper file path we collect its binaries and data files normally.
# If it is a namespace-only package we return empty collections so PyInstaller
# can continue without crashing.

import pathlib
import os

binaries = []
datas = []
hiddenimports = []

try:
    from PyInstaller.utils.hooks import (
        get_module_file_attribute,
        collect_dynamic_libs,
        collect_data_files,
    )

    cv2_file = get_module_file_attribute('cv2')

    if cv2_file is not None and os.path.exists(cv2_file):
        # Normal installation: collect binaries from the package directory.
        pkg_path = pathlib.Path(cv2_file).parent
        for so in pkg_path.rglob('*.so*'):
            rel = so.parent.relative_to(pkg_path.parent)
            binaries.append((str(so), str(rel)))
        try:
            datas += collect_data_files('cv2')
        except Exception:
            pass
    else:
        # Namespace package or broken install — nothing to collect, skip silently.
        import sys
        print(
            '[WARN] hook-cv2: cv2 has no file path (namespace/broken package) '
            '— skipping cv2 binary collection.',
            file=sys.stderr,
        )

except Exception as exc:
    import sys
    print(f'[WARN] hook-cv2: unexpected error during cv2 collection: {exc}', file=sys.stderr)
