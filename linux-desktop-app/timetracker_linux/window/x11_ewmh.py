"""
Focused window on X11 via EWMH (_NET_ACTIVE_WINDOW), python-xlib.

Only used when XDG_SESSION_TYPE=x11. Under Wayland, EWMH only sees
XWayland windows and must never be trusted.
"""

import threading

from .common import empty_window, monitor_for_rect


def window_from_props(props, monitors):
    """Build the common window dict from raw X properties (pure; unit tested).

    props: window_id, title, wm_class (instance, class), pid, state (atom names),
           geometry (x, y, w, h in root coordinates), frame_extents (l, r, t, b)
    monitors: [{'name', 'rect': (x, y, w, h)}]
    """
    window = empty_window()
    window['window_id'] = f"x11:{props['window_id']:#x}"
    window['title'] = props.get('title') or ''
    wm_class = props.get('wm_class') or ('', '')
    window['wm_class'] = (wm_class[1] or wm_class[0] or '').lower()
    window['pid'] = props.get('pid')
    window['minimized'] = '_NET_WM_STATE_HIDDEN' in (props.get('state') or ())
    geometry = props.get('geometry')
    if geometry:
        left, right, top, bottom = props.get('frame_extents') or (0, 0, 0, 0)
        x, y, w, h = geometry
        frame = (x - left, y - top, w + left + right, h + top + bottom)
        monitor = monitor_for_rect(frame, monitors)
        if monitor is not None:
            window['monitor_name'] = monitor['name']
            window['monitor_rect'] = monitor['rect']
    return window


class X11Display:
    """Thin python-xlib glue, shared by the window and capture backends."""

    def __init__(self, display_factory=None):
        self._factory = display_factory
        self._display = None
        self._atoms = {}
        self.lock = threading.Lock()

    @property
    def display(self):
        if self._display is None:
            if self._factory is not None:
                self._display = self._factory()
            else:
                from Xlib import display
                self._display = display.Display()
        return self._display

    def reset(self):
        try:
            if self._display is not None:
                self._display.close()
        except Exception:
            pass
        self._display = None
        self._atoms = {}

    def atom(self, name):
        if name not in self._atoms:
            self._atoms[name] = self.display.intern_atom(name)
        return self._atoms[name]

    def monitors(self):
        from Xlib.ext import randr
        root = self.display.screen().root
        result = []
        for m in randr.get_monitors(root, is_active=True).monitors:
            name = self.display.get_atom_name(m.name) if m.name else f'monitor-{len(result)}'
            result.append({'name': name, 'rect': (m.x, m.y, m.width_in_pixels, m.height_in_pixels),
                           'primary': bool(m.primary)})
        if not result:
            screen = self.display.screen()
            result.append({'name': 'screen', 'rect': (0, 0, screen.width_in_pixels,
                                                     screen.height_in_pixels), 'primary': True})
        return result

    def _prop(self, window, name, type_name=None):
        from Xlib import X
        prop_type = self.atom(type_name) if type_name else X.AnyPropertyType
        prop = window.get_full_property(self.atom(name), prop_type)
        return prop.value if prop is not None else None

    def active_window_props(self):
        """Raw properties of the active window, or None if nothing is focused."""
        d = self.display
        root = d.screen().root
        value = self._prop(root, '_NET_ACTIVE_WINDOW')
        window_id = int(value[0]) if value is not None and len(value) else 0
        if not window_id:
            return None
        window = d.create_resource_object('window', window_id)

        title = self._prop(window, '_NET_WM_NAME', 'UTF8_STRING')
        if title is None:
            title = self._prop(window, 'WM_NAME')
        if isinstance(title, bytes):
            title = title.decode('utf-8', 'replace')
        pid_value = self._prop(window, '_NET_WM_PID')
        state_value = self._prop(window, '_NET_WM_STATE')
        extents = self._prop(window, '_NET_FRAME_EXTENTS')
        try:
            wm_class = window.get_wm_class() or ('', '')
        except Exception:
            wm_class = ('', '')
        geometry = None
        try:
            g = window.get_geometry()
            origin = window.translate_coords(root, 0, 0)
            geometry = (-origin.x, -origin.y, g.width, g.height)
        except Exception:
            pass
        return {
            'window_id': window_id,
            'title': title or '',
            'wm_class': wm_class,
            'pid': int(pid_value[0]) if pid_value is not None and len(pid_value) else None,
            'state': [d.get_atom_name(a) for a in state_value] if state_value is not None else [],
            'geometry': geometry,
            'frame_extents': tuple(extents) if extents is not None and len(extents) == 4 else None,
        }


class X11EwmhWindow:
    name = 'x11_ewmh'

    def __init__(self, x11=None):
        self.x11 = x11 or X11Display()

    def is_available(self):
        try:
            with self.x11.lock:
                return bool(self.x11.display)
        except Exception:
            return False

    def focused_window(self):
        with self.x11.lock:
            try:
                props = self.x11.active_window_props()
                if props is None:
                    return None
                return window_from_props(props, self.x11.monitors())
            except Exception:
                self.x11.reset()        # reconnect next time (X server restart, etc.)
                raise
