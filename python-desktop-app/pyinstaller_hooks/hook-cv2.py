# Patched hook-cv2.py
#
# Overrides the upstream _pyinstaller_hooks_contrib version to:
#  1. Survive gracefully when cv2 is a namespace package (no __file__).
#  2. Set module_collection_mode = 'py' so PyInstaller collects cv2 source files
#     rather than compiling them into PYZ (cv2 uses sys.path tricks that break in
#     PYZ, as documented in pyinstaller/pyinstaller#6945).
#  3. Collect the cv2 C extension (cv2.abi3.so) via hidden imports, using cv2's
#     own config-3.py to discover the extension path (same approach as contrib
#     hook).
#  4. Collect config scripts as data files so cv2's loader can initialise.

import sys
import os
import pathlib

binaries = []
datas = []
hiddenimports = ['numpy']

# cv2 >= 4.6 uses sys.path manipulation that is incompatible with PyInstaller's
# FrozenImporter (PYZ archive). Collect as plain Python source instead.
module_collection_mode = 'py'

try:
    from PyInstaller.utils.hooks import (
        get_module_file_attribute,
        collect_data_files,
    )

    cv2_file = get_module_file_attribute('cv2')

    if cv2_file is None or not os.path.exists(cv2_file):
        # Namespace package or broken install — skip silently.
        print(
            '[WARN] hook-cv2: cv2 has no file path (namespace/broken package) '
            '— skipping cv2 collection.',
            file=sys.stderr,
        )
    else:
        pkg_path = pathlib.Path(cv2_file).parent

        # ── Config scripts ──────────────────────────────────────────────────
        # cv2's loader reads config-3.py (or config-3.X.py) and
        # load_config_py3.py at runtime.  Collect them as data files.
        try:
            datas += collect_data_files(
                'cv2',
                include_py_files=True,
                includes=[
                    'config.py',
                    f'config-{sys.version_info[0]}.{sys.version_info[1]}.py',
                    'config-3.py',
                    'load_config_py3.py',
                ],
            )
        except Exception:
            pass

        # ── C extension (cv2.abi3.so) ────────────────────────────────────
        # cv2 uses its config file to locate the extension at runtime.
        # Replicate that logic here to tell PyInstaller where the .so lives.
        config_candidates = [
            pkg_path / f'config-{sys.version_info[0]}.{sys.version_info[1]}.py',
            pkg_path / 'config-3.py',
        ]
        ext_collected = False
        for cfg in config_candidates:
            if not cfg.exists():
                continue
            try:
                PYTHON_EXTENSIONS_PATHS = []
                LOADER_DIR = str(pkg_path)
                gvars = {'PYTHON_EXTENSIONS_PATHS': PYTHON_EXTENSIONS_PATHS,
                         'LOADER_DIR': LOADER_DIR,
                         '__file__': str(cfg),
                         'sys': sys, 'os': os}
                with open(cfg) as fh:
                    exec(compile(fh.read(), str(cfg), 'exec'), gvars)
                PYTHON_EXTENSIONS_PATHS = gvars.get('PYTHON_EXTENSIONS_PATHS', [])

                for ext_dir in PYTHON_EXTENSIONS_PATHS:
                    ext_path = pathlib.Path(ext_dir)
                    matches = list(ext_path.glob('cv2*.so'))
                    if matches:
                        ext_file = matches[0]
                        dest = pathlib.Path('cv2') / ext_file.parent.relative_to(pkg_path)
                        # Always add the .so as an explicit binary so PyInstaller
                        # places it in _MEIPASS/cv2/ (the package subdirectory).
                        # cv2's bootstrap adds _MEIPASS/cv2/ to sys.path[0] at
                        # runtime and then calls importlib.import_module('cv2')
                        # expecting to find cv2.abi3.so there.  Using
                        # hiddenimports.append('cv2.cv2') was unreliable for
                        # ABI3-tagged extensions — PyInstaller sometimes placed
                        # the .so at the bundle root (_MEIPASS/) instead of the
                        # cv2/ subdirectory, making the runtime lookup fail.
                        binaries.append((str(ext_file), str(dest) if str(dest) != '.' else 'cv2'))
                        ext_collected = True
                        break
                if ext_collected:
                    break
            except Exception as _cfg_err:
                print(f'[WARN] hook-cv2: config exec failed ({cfg.name}): {_cfg_err}',
                      file=sys.stderr)

        if not ext_collected:
            # Fallback: glob for any .so in the package dir and collect directly.
            for so in pkg_path.glob('cv2*.so'):
                binaries.append((str(so), 'cv2'))
                ext_collected = True
                break

        # ── Qt plugins / fonts (non-headless Linux wheels) ───────────────
        if sys.platform.startswith('linux'):
            qt_fonts_dir = pkg_path / 'qt' / 'fonts'
            if qt_fonts_dir.is_dir():
                for f in qt_fonts_dir.rglob('*.ttf'):
                    datas.append((str(f), str(pathlib.Path('cv2') / 'qt' / 'fonts')))
            qt_plugins_dir = pkg_path / 'qt' / 'plugins'
            if qt_plugins_dir.is_dir():
                for f in qt_plugins_dir.rglob('*'):
                    if f.is_file():
                        rel = f.parent.relative_to(pkg_path)
                        datas.append((str(f), str(pathlib.Path('cv2') / rel)))

except Exception as exc:
    print(f'[WARN] hook-cv2: unexpected error during cv2 collection: {exc}', file=sys.stderr)
