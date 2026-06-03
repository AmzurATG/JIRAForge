# PyInstaller runtime hook: pyi_rth_onnxruntime.py
#
# onnxruntime bundles its core shared library (libonnxruntime.so) inside
# onnxruntime/capi/ inside _MEIPASS.  When the C extension
# onnxruntime_pybind11_state.so is loaded by the frozen importer, the OS
# dynamic linker must be able to find libonnxruntime.so.  On Linux, RPATH
# ($ORIGIN) on the .so should handle this, but some distributions strip RPATH
# from bundled .so files.  Prepending the capi directory to LD_LIBRARY_PATH
# before any onnxruntime import guarantees the linker finds the library.

import os
import sys

if hasattr(sys, '_MEIPASS'):
    _capi_dir = os.path.join(sys._MEIPASS, 'onnxruntime', 'capi')
    if os.path.isdir(_capi_dir):
        _existing = os.environ.get('LD_LIBRARY_PATH', '')
        if _capi_dir not in _existing:
            os.environ['LD_LIBRARY_PATH'] = (
                _capi_dir + (':' + _existing if _existing else '')
            )
