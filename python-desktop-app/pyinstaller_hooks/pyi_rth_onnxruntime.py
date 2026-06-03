# PyInstaller runtime hook: pyi_rth_onnxruntime.py
#
# onnxruntime bundles its core shared library (libonnxruntime.so) inside
# onnxruntime/capi/ inside _MEIPASS.  When the C extension
# onnxruntime_pybind11_state.so is loaded by the frozen importer, the OS
# dynamic linker must be able to find libonnxruntime.so.  On Linux, RPATH
# ($ORIGIN) on the .so should handle this, but some distributions strip RPATH
# from bundled .so files.  Prepending the capi directory AND the bundle root
# to LD_LIBRARY_PATH before any onnxruntime import guarantees the linker finds
# the library regardless of which path collect_dynamic_libs used.

import os
import sys

if hasattr(sys, '_MEIPASS'):
    # Candidate directories where onnxruntime / cv2 shared libs may reside:
    # 1. onnxruntime/capi/ — where collect_dynamic_libs places ort libs
    # 2. sys._MEIPASS root — fallback if collect_dynamic_libs used dest='.'
    _candidate_dirs = [
        os.path.join(sys._MEIPASS, 'onnxruntime', 'capi'),
        sys._MEIPASS,
    ]
    _existing = os.environ.get('LD_LIBRARY_PATH', '')
    _existing_set = set(_existing.split(':')) if _existing else set()
    _new_dirs = [d for d in _candidate_dirs
                 if os.path.isdir(d) and d not in _existing_set]
    if _new_dirs:
        os.environ['LD_LIBRARY_PATH'] = (
            ':'.join(_new_dirs) + (':' + _existing if _existing else '')
        )
