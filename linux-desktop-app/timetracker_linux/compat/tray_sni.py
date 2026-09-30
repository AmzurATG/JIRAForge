"""
pystray-compatible tray icon over StatusNotifierItem + com.canonical.dbusmenu.

Works on KDE, GNOME with the AppIndicator extension (Ubuntu's default),
Cinnamon, Xfce, MATE, waybar and other SNI hosts, with no GTK/GLib in the
process (the old build loaded the distro's python3-gi into the bundled
Python, which only worked when their versions happened to match).

The launcher assigns this class to `pystray.Icon`, so the core's tray code
(pystray Menu/MenuItem, icon.menu = ..., run(setup=...)) is unchanged.
If no SNI host is running, the item waits and registers when one appears.
"""

import logging
import os
import threading

from PIL import Image

import pystray._base as pystray_base

from ..dbus_bus import DBusMethodError

logger = logging.getLogger(__name__)

ITEM_PATH = '/StatusNotifierItem'
MENU_PATH = '/MenuBar'
ITEM_IFACE = 'org.kde.StatusNotifierItem'
MENU_IFACE = 'com.canonical.dbusmenu'
WATCHER = ('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher')
PROPS_IFACE = 'org.freedesktop.DBus.Properties'
ICON_SIZES = (16, 22, 32, 48)

_ITEM_XML = f'''<node>
 <interface name="{ITEM_IFACE}">
  <property name="Category" type="s" access="read"/><property name="Id" type="s" access="read"/>
  <property name="Title" type="s" access="read"/><property name="Status" type="s" access="read"/>
  <property name="WindowId" type="i" access="read"/><property name="IconName" type="s" access="read"/>
  <property name="IconPixmap" type="a(iiay)" access="read"/><property name="ItemIsMenu" type="b" access="read"/>
  <property name="Menu" type="o" access="read"/><property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
  <method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
  <signal name="NewIcon"/><signal name="NewTitle"/><signal name="NewToolTip"/>
  <signal name="NewStatus"><arg type="s"/></signal>
 </interface>
</node>'''

_MENU_XML = f'''<node>
 <interface name="{MENU_IFACE}">
  <property name="Version" type="u" access="read"/><property name="Status" type="s" access="read"/>
  <property name="TextDirection" type="s" access="read"/><property name="IconThemePath" type="as" access="read"/>
  <method name="GetLayout"><arg type="i" direction="in"/><arg type="i" direction="in"/>
   <arg type="as" direction="in"/><arg type="u" direction="out"/><arg type="(ia{{sv}}av)" direction="out"/></method>
  <method name="GetGroupProperties"><arg type="ai" direction="in"/><arg type="as" direction="in"/>
   <arg type="a(ia{{sv}})" direction="out"/></method>
  <method name="GetProperty"><arg type="i" direction="in"/><arg type="s" direction="in"/>
   <arg type="v" direction="out"/></method>
  <method name="Event"><arg type="i" direction="in"/><arg type="s" direction="in"/>
   <arg type="v" direction="in"/><arg type="u" direction="in"/></method>
  <method name="EventGroup"><arg type="a(isvu)" direction="in"/><arg type="ai" direction="out"/></method>
  <method name="AboutToShow"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
  <method name="AboutToShowGroup"><arg type="ai" direction="in"/><arg type="ai" direction="out"/>
   <arg type="ai" direction="out"/></method>
  <signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal>
  <signal name="ItemsPropertiesUpdated"><arg type="a(ia{{sv}})"/><arg type="a(ias)"/></signal>
 </interface>
</node>'''


def icon_pixmaps(image):
    """PIL image → SNI IconPixmap: [(w, h, ARGB32 big-endian bytes)] in several sizes."""
    rgba = image.convert('RGBA')
    pixmaps = []
    for size in ICON_SIZES:
        scaled = rgba if rgba.size == (size, size) else rgba.resize((size, size), Image.LANCZOS)
        r, g, b, a = scaled.split()
        pixmaps.append((size, size, Image.merge('RGBA', (a, r, g, b)).tobytes()))
    return pixmaps


class MenuModel:
    """Flattens a pystray Menu into dbusmenu ids and layout tuples."""

    def __init__(self):
        self.revision = 1
        self._items = {}

    def layout(self, menu):
        self._items = {}
        counter = [0]

        def build(menu_obj):
            children = []
            for item in (menu_obj or []):
                counter[0] += 1
                item_id = counter[0]
                self._items[item_id] = item
                children.append(('(ia{sv}av)', self._node(item_id, item, build)))
            return children

        root = (0, {'children-display': ('s', 'submenu')}, build(menu))
        return root

    def _node(self, item_id, item, build):
        if item is pystray_base.Menu.SEPARATOR:
            return (item_id, {'type': ('s', 'separator')}, [])
        props = {
            'label': ('s', (item.text or '').replace('_', '__')),
            'enabled': ('b', bool(item.enabled)),
            'visible': ('b', True),
        }
        checked = item.checked
        if checked is not None:
            props['toggle-type'] = ('s', 'radio' if item.radio else 'checkmark')
            props['toggle-state'] = ('i', 1 if checked else 0)
        children = []
        if item.submenu is not None:
            props['children-display'] = ('s', 'submenu')
            children = build(item.submenu)
        return (item_id, props, children)

    def item(self, item_id):
        return self._items.get(item_id)

    def item_ids(self):
        return list(self._items)

    def properties(self, item_id):
        item = self._items.get(item_id)
        if item is None:
            return None
        return self._node(item_id, item, lambda _menu: [])[1]


class Icon(pystray_base.Icon):
    """pystray backend class (assigned to pystray.Icon by the launcher)."""

    bus_factory = None          # set by the launcher/tests; default: shared session bus

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._bus = None
        self._handles = []
        self._stop_event = threading.Event()
        self._status = 'Active'
        self._pixmaps = []
        self._pixmap_source = None
        self._model = MenuModel()
        self._layout = self._model.layout(None)
        self._service_name = f'org.kde.StatusNotifierItem-{os.getpid()}-1'
        self.registered = False

    # ------------------------------------------------------ pystray backend API

    def _show(self):
        self._set_status('Active')

    def _hide(self):
        self._set_status('Passive')

    def _update_icon(self):
        image = self.icon
        if image is None:
            return
        # The core re-sets the icon every 2 s; only signal real changes.
        source = (image.size, image.mode, image.tobytes())
        if source == self._pixmap_source:
            self._icon_valid = True
            return
        self._pixmap_source = source
        self._pixmaps = icon_pixmaps(image)
        self._icon_valid = True
        self._emit(ITEM_PATH, ITEM_IFACE, 'NewIcon')

    def _update_title(self):
        self._emit(ITEM_PATH, ITEM_IFACE, 'NewTitle')
        self._emit(ITEM_PATH, ITEM_IFACE, 'NewToolTip')

    def _update_menu(self):
        self._rebuild_layout()
        self._emit(MENU_PATH, MENU_IFACE, 'LayoutUpdated', 'ui', (self._model.revision, 0))

    def _run(self):
        self._start()
        self._mark_ready()
        while not self._stop_event.wait(1.0):
            pass

    def _run_detached(self):
        self._start()
        self._mark_ready()

    def _stop(self):
        self._stop_event.set()
        for handle in self._handles:
            try:
                handle.remove()
            except Exception:
                pass
        self._handles = []

    def _notify(self, message, title=None):
        from .winotify import get_notifier
        get_notifier().notify(title or self.title or 'TimeTracker', message)

    def _remove_notification(self):
        pass

    # ---------------------------------------------------------------- D-Bus

    def _start(self):
        self._bus = self.bus_factory() if self.bus_factory else self._shared_bus()
        self._handles.append(self._bus.export(ITEM_PATH, self._handle_item))
        self._handles.append(self._bus.export(MENU_PATH, self._handle_menu))
        try:
            self._bus.request_name(self._service_name)
        except Exception as e:
            logger.info(f'[LINUX] tray: could not own {self._service_name}: {e}')
        self._handles.append(self._bus.subscribe(
            self._on_name_owner_changed, interface='org.freedesktop.DBus', member='NameOwnerChanged'))
        if self.icon is not None:
            self._update_icon()
        self._rebuild_layout()
        self._register()

    @staticmethod
    def _shared_bus():
        from ..dbus_bus import get_bus
        return get_bus('SESSION')

    def _register(self):
        try:
            self._bus.call(*WATCHER, 'RegisterStatusNotifierItem', 's', (self._service_name,))
            if not self.registered:
                logger.info('[LINUX] tray icon registered with the StatusNotifierWatcher')
            self.registered = True
        except Exception as e:
            self.registered = False
            logger.info(f'[LINUX] no tray host yet ({e}); will register when one appears')

    def _on_name_owner_changed(self, message):
        name, _old, new = message.body
        if name == WATCHER[0] and new:
            self._register()
        elif name == WATCHER[0] and not new:
            self.registered = False

    def _emit(self, path, interface, member, signature='', body=()):
        if self._bus is None:
            return
        try:
            self._bus.emit_signal(path, interface, member, signature, body)
        except Exception as e:
            logger.debug(f'tray signal {member} failed: {e}')

    def _set_status(self, status):
        self._status = status
        self._emit(ITEM_PATH, ITEM_IFACE, 'NewStatus', 's', (status,))

    def _rebuild_layout(self):
        self._layout = self._model.layout(self.menu)
        self._model.revision += 1

    # ------------------------------------------------------- item interface

    def _item_properties(self):
        title = self.title or 'TimeTracker'
        return {
            'Category': ('s', 'ApplicationStatus'),
            'Id': ('s', 'com.amzur.timetracker'),
            'Title': ('s', title),
            'Status': ('s', self._status),
            'WindowId': ('i', 0),
            'IconName': ('s', ''),
            'IconPixmap': ('a(iiay)', self._pixmaps),
            'ItemIsMenu': ('b', True),
            'Menu': ('o', MENU_PATH),
            'ToolTip': ('(sa(iiay)ss)', ('', [], title, '')),
        }

    def _handle_item(self, message):
        if message.interface == PROPS_IFACE:
            return _properties_reply(message, ITEM_IFACE, self._item_properties())
        if message.interface == 'org.freedesktop.DBus.Introspectable':
            return 's', (_ITEM_XML,)
        if message.member in ('Activate', 'SecondaryActivate', 'ContextMenu', 'Scroll'):
            if message.member == 'Activate' and self.menu is not None:
                self._run_action(lambda: self.menu(self))      # pystray default item, if any
            return None
        raise DBusMethodError('org.freedesktop.DBus.Error.UnknownMethod', message.member or '')

    # ------------------------------------------------------- menu interface

    def _menu_properties(self):
        return {'Version': ('u', 3), 'Status': ('s', 'normal'), 'TextDirection': ('s', 'ltr'),
                'IconThemePath': ('as', [])}

    def _handle_menu(self, message):
        member, body = message.member, message.body
        if message.interface == PROPS_IFACE:
            return _properties_reply(message, MENU_IFACE, self._menu_properties())
        if message.interface == 'org.freedesktop.DBus.Introspectable':
            return 's', (_MENU_XML,)
        if member == 'GetLayout':
            parent_id = body[0]
            layout = self._layout if parent_id == 0 else self._find_node(self._layout, parent_id)
            if layout is None:
                raise DBusMethodError('org.freedesktop.DBus.Error.InvalidArgs', f'no item {parent_id}')
            return 'u(ia{sv}av)', (self._model.revision, layout)
        if member == 'GetGroupProperties':
            ids = body[0] or self._model.item_ids()
            result = [(i, self._model.properties(i)) for i in ids if self._model.properties(i) is not None]
            return 'a(ia{sv})', (result,)
        if member == 'GetProperty':
            props = self._model.properties(body[0]) or {}
            if body[1] not in props:
                raise DBusMethodError('org.freedesktop.DBus.Error.InvalidArgs', body[1])
            return 'v', (props[body[1]],)
        if member == 'Event':
            self._on_event(body[0], body[1])
            return None
        if member == 'EventGroup':
            missing = [event[0] for event in body[0] if self._model.item(event[0]) is None and event[0] != 0]
            for event in body[0]:
                self._on_event(event[0], event[1])
            return 'ai', (missing,)
        if member == 'AboutToShow':
            # Labels are callables evaluated at render time (e.g. "Logged in as ...").
            self._rebuild_layout()
            return 'b', (True,)
        if member == 'AboutToShowGroup':
            self._rebuild_layout()
            return 'aiai', (list(body[0]), [])
        raise DBusMethodError('org.freedesktop.DBus.Error.UnknownMethod', member or '')

    def _find_node(self, node, item_id):
        if node[0] == item_id:
            return node
        for _sig, child in node[2]:
            found = self._find_node(child, item_id)
            if found is not None:
                return found
        return None

    def _on_event(self, item_id, event_id):
        if event_id != 'clicked':
            return
        item = self._model.item(item_id)
        if item is None or item is pystray_base.Menu.SEPARATOR or not item.enabled:
            return
        self._run_action(lambda: item(self))

    def _run_action(self, action):
        def run():
            try:
                action()
            except Exception as e:
                logger.warning(f'[LINUX] tray action failed: {e}')
        threading.Thread(target=run, name='tray-action', daemon=True).start()


def _properties_reply(message, interface, properties):
    if message.member == 'Get':
        requested_iface, name = message.body
        if requested_iface not in (interface, '') or name not in properties:
            raise DBusMethodError('org.freedesktop.DBus.Error.UnknownProperty', name)
        return 'v', (properties[name],)
    if message.member == 'GetAll':
        return 'a{sv}', (properties if message.body[0] in (interface, '') else {},)
    if message.member == 'Set':
        raise DBusMethodError('org.freedesktop.DBus.Error.PropertyReadOnly', message.body[1])
    raise DBusMethodError('org.freedesktop.DBus.Error.UnknownMethod', message.member or '')
