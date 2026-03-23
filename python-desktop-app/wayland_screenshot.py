"""
Wayland Screenshot Capture via XDG ScreenCast Portal
=====================================================

Implements the XDG ScreenCast Portal protocol for capturing screenshots
on Wayland compositors using D-Bus, PipeWire, and GStreamer.

Architecture::

    Desktop App ──[capture_screenshot()]──→ ScreenCast Portal (D-Bus)
                                                │
                                                ├── CreateSession
                                                ├── SelectSources
                                                ├── Start
                                                └── OpenPipeWireRemote → GStreamer pipeline

The portal flow requests permission once, then reuses a restore token
so subsequent captures do not show a permission dialog.

Requirements (system packages):
    python3-gi python3-gi-cairo gir1.2-gstreamer-1.0
    gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good
"""

import os
import io
import json
import time
import threading
import logging

logger = logging.getLogger(__name__)

# Token storage
_TOKEN_DIR = os.path.join(
    os.environ.get('XDG_DATA_HOME', os.path.expanduser('~/.local/share')),
    'timetracker'
)
_TOKEN_FILE = os.path.join(_TOKEN_DIR, '.screencast_token')

# Session state
_session = {
    'initialized': False,
    'pipewire_fd': None,
    'pipewire_node_id': None,
    'session_handle': None,
    'restore_token': None,
    'lock': threading.Lock(),
}

# ---------------------------------------------------------------------------
# GI imports — deferred so module can be imported safely
# ---------------------------------------------------------------------------

_GI_AVAILABLE = False
_Gst = None
_GLib = None
_Gio = None

def _ensure_gi():
    """Import GStreamer + GLib via GObject Introspection. Raises ImportError on failure."""
    global _GI_AVAILABLE, _Gst, _GLib, _Gio
    if _GI_AVAILABLE:
        return
    import gi
    gi.require_version('Gst', '1.0')
    gi.require_version('Gio', '2.0')
    from gi.repository import Gst, GLib, Gio  # noqa: N813
    Gst.init(None)
    _Gst = Gst
    _GLib = GLib
    _Gio = Gio
    _GI_AVAILABLE = True


# ---------------------------------------------------------------------------
# Restore-token persistence
# ---------------------------------------------------------------------------

def _load_restore_token():
    """Load the saved restore token from disk (if any)."""
    try:
        if os.path.isfile(_TOKEN_FILE):
            with open(_TOKEN_FILE, 'r') as fh:
                data = json.load(fh)
                return data.get('token')
    except Exception:
        pass
    return None


def _save_restore_token(token):
    """Persist the restore token so next session skips the permission dialog."""
    try:
        os.makedirs(_TOKEN_DIR, exist_ok=True)
        with open(_TOKEN_FILE, 'w') as fh:
            json.dump({'token': token}, fh)
    except Exception as exc:
        logger.warning("Could not save ScreenCast restore token: %s", exc)


# ---------------------------------------------------------------------------
# Portal D-Bus interaction
# ---------------------------------------------------------------------------

def _init_screencast_session():
    """Run the 4-step ScreenCast portal protocol and populate ``_session``."""
    _ensure_gi()

    import dbus  # local import — already optional-checked by caller

    bus = dbus.SessionBus()
    portal = bus.get_object(
        'org.freedesktop.portal.Desktop',
        '/org/freedesktop/portal/desktop'
    )
    screencast = dbus.Interface(portal, 'org.freedesktop.portal.ScreenCast')

    # Unique token for this session
    sender = bus.get_unique_name().replace('.', '_').replace(':', '')
    token_counter = int(time.time() * 1000) & 0xFFFFFFFF

    # ---- Step 1: CreateSession ----
    session_token = f"tt_session_{token_counter}"
    create_opts = dbus.Dictionary({
        'handle_token': f"tt_handle_{token_counter}",
        'session_handle_token': session_token,
    }, signature='sv')

    result_path = screencast.CreateSession(create_opts)
    session_handle = _wait_for_response(bus, result_path, "CreateSession")
    _session['session_handle'] = session_handle

    # ---- Step 2: SelectSources ----
    token_counter += 1
    select_opts = dbus.Dictionary({
        'handle_token': f"tt_handle_{token_counter}",
        'types': dbus.UInt32(1),  # 1 = MONITOR
        'multiple': False,
        'persist_mode': dbus.UInt32(2),  # 2 = persist until revoked
    }, signature='sv')

    # Include restore token if available
    restore_token = _load_restore_token()
    if restore_token:
        select_opts['restore_token'] = restore_token

    result_path = screencast.SelectSources(session_handle, select_opts)
    _wait_for_response(bus, result_path, "SelectSources")

    # ---- Step 3: Start ----
    token_counter += 1
    start_opts = dbus.Dictionary({
        'handle_token': f"tt_handle_{token_counter}",
    }, signature='sv')

    start_result = screencast.Start(session_handle, "", start_opts)
    start_data = _wait_for_response(bus, start_result, "Start", return_data=True)

    # Save restore token for next time
    new_token = start_data.get('restore_token')
    if new_token:
        _save_restore_token(str(new_token))
        _session['restore_token'] = str(new_token)

    # Extract stream info
    streams = start_data.get('streams', [])
    if not streams:
        raise RuntimeError("ScreenCast portal returned no streams")

    node_id = int(streams[0][0])
    _session['pipewire_node_id'] = node_id

    # ---- Step 4: OpenPipeWireRemote ----
    pw_fd = screencast.OpenPipeWireRemote(session_handle, dbus.Dictionary({}, signature='sv'))
    _session['pipewire_fd'] = pw_fd.take()
    _session['initialized'] = True

    logger.info("ScreenCast session initialised (node_id=%d)", node_id)


def _wait_for_response(bus, request_path, step_name, return_data=False, timeout=30):
    """Wait synchronously for the portal ``Response`` signal on *request_path*.

    Returns the session handle (str) or, if *return_data*, the full response dict.
    """
    import dbus
    result = {'done': False, 'data': None, 'error': None}
    loop = _GLib.MainLoop()

    def on_response(response_code, results):
        if response_code != 0:
            result['error'] = f"{step_name} failed (response code {response_code})"
        else:
            result['data'] = dict(results)
        result['done'] = True
        loop.quit()

    bus.add_signal_receiver(
        on_response,
        signal_name='Response',
        dbus_interface='org.freedesktop.portal.Request',
        path=request_path,
    )

    # Timeout safety
    _GLib.timeout_add_seconds(timeout, lambda: (loop.quit(), False)[1])
    loop.run()

    if result['error']:
        raise RuntimeError(result['error'])
    if not result['done']:
        raise RuntimeError(f"{step_name} timed out after {timeout}s")

    if return_data:
        return result['data']

    # For CreateSession, return the session handle
    data = result['data'] or {}
    return data.get('session_handle', str(request_path))


# ---------------------------------------------------------------------------
# GStreamer frame capture
# ---------------------------------------------------------------------------

def _capture_frame():
    """Grab a single frame from the PipeWire stream via GStreamer.

    Returns a PIL.Image.
    """
    _ensure_gi()

    fd = _session['pipewire_fd']
    node_id = _session['pipewire_node_id']

    pipeline_str = (
        f"pipewiresrc fd={fd} path={node_id} num-buffers=1 ! "
        "videoconvert ! "
        "video/x-raw,format=RGB ! "
        "appsink name=sink emit-signals=true max-buffers=1 drop=true"
    )
    pipeline = _Gst.parse_launch(pipeline_str)

    appsink = pipeline.get_by_name('sink')
    captured = {'image': None}

    def on_new_sample(sink):
        sample = sink.emit('pull-sample')
        if sample is None:
            return _Gst.FlowReturn.ERROR
        buf = sample.get_buffer()
        caps = sample.get_caps()
        struct = caps.get_structure(0)
        width = struct.get_int('width')[1]
        height = struct.get_int('height')[1]
        success, mapinfo = buf.map(_Gst.MapFlags.READ)
        if success:
            from PIL import Image
            captured['image'] = Image.frombytes('RGB', (width, height), bytes(mapinfo.data))
            buf.unmap(mapinfo)
        return _Gst.FlowReturn.OK

    appsink.connect('new-sample', on_new_sample)

    pipeline.set_state(_Gst.State.PLAYING)

    # Wait up to 5 seconds for EOS
    bus = pipeline.get_bus()
    bus.timed_pop_filtered(5 * _Gst.SECOND, _Gst.MessageType.EOS | _Gst.MessageType.ERROR)

    pipeline.set_state(_Gst.State.NULL)

    if captured['image'] is None:
        raise RuntimeError("GStreamer pipeline did not produce a frame")

    return captured['image']


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def capture_screenshot():
    """Capture a screenshot via the Wayland ScreenCast Portal.

    Initialises the portal session on first call (may trigger a permission dialog).
    Subsequent calls reuse the session or the persisted restore token.

    Returns a ``PIL.Image`` or ``None`` on failure.
    """
    with _session['lock']:
        try:
            if not _session['initialized']:
                _init_screencast_session()
            return _capture_frame()
        except Exception as exc:
            logger.warning("Wayland screenshot failed: %s", exc)
            # Reset session so next call retries initialization
            _session['initialized'] = False
            _session['pipewire_fd'] = None
            _session['pipewire_node_id'] = None
            _session['session_handle'] = None
            return None


def reset_session():
    """Force re-initialisation of the ScreenCast session."""
    with _session['lock']:
        _session['initialized'] = False
        _session['pipewire_fd'] = None
        _session['pipewire_node_id'] = None
        _session['session_handle'] = None
        logger.info("ScreenCast session reset — will re-initialise on next capture")
