"""
Tests for the winotify adapter and the SNI tray icon.

Spec: plan/2026-09-29_linux-desktop-app_phase1b-core-seams-and-services.md (AC 13-14)
"""

import threading
import time

import pytest
from PIL import Image

import pystray
from fakes import FakeBus, FakeMessage
from timetracker_linux.compat import tray_sni, winotify
from timetracker_linux.compat.tray_sni import ITEM_PATH, MENU_PATH, icon_pixmaps

N = winotify.NOTIFICATIONS


# ------------------------------------------------------------- notifications

def _notifier(caps=('actions', 'body'), opened=None):
    bus = FakeBus(answers={
        (N[0], N[2], 'GetCapabilities'): (list(caps),),
        (N[0], N[2], 'Notify'): (17,),
    })
    notifier = winotify.Notifier(bus_factory=lambda: bus,
                                 opener=(opened.append if opened is not None else lambda url: None))
    return notifier, bus


def _notify_args(bus):
    return [c for c in bus.calls if c[3] == 'Notify'][-1][4]


def test_notification_fields_and_timeout():
    notifier, bus = _notifier()
    winotify.set_notifier(notifier)
    note = winotify.Notification(app_id='TimeTracker', title='Update Ready', msg='v2 is ready', duration='long')
    note.set_audio(winotify.audio.Default, loop=False)
    note.show()
    app_name, replaces, icon, summary, body, actions, hints, timeout = _notify_args(bus)
    assert (app_name, replaces, summary, body) == ('TimeTracker', 0, 'Update Ready', 'v2 is ready')
    assert timeout == 25000
    assert hints['desktop-entry'] == ('s', 'com.amzur.timetracker')
    assert actions == []


def test_actions_only_when_supported_and_opened_on_click():
    opened = []
    notifier, bus = _notifier(opened=opened)
    winotify.set_notifier(notifier)
    note = winotify.Notification(app_id='TimeTracker', title='t', msg='m')
    note.add_actions(label='Install Now', launch='http://localhost:51778/api/update/install')
    note.show()
    actions = _notify_args(bus)[5]
    assert actions == ['action-0', 'Install Now']
    bus.fire(N[2], 'ActionInvoked', (17, 'action-0'))
    assert opened == ['http://localhost:51778/api/update/install']
    bus.fire(N[2], 'NotificationClosed', (17, 2))
    bus.fire(N[2], 'ActionInvoked', (17, 'action-0'))
    assert len(opened) == 1


def test_no_actions_without_capability():
    notifier, bus = _notifier(caps=('body',))
    winotify.set_notifier(notifier)
    note = winotify.Notification(app_id='TimeTracker', title='t', msg='m', launch='http://x')
    note.add_actions(label='Go', launch='http://y')
    note.show()
    assert _notify_args(bus)[5] == []


def test_markup_escaped_when_supported():
    notifier, bus = _notifier(caps=('body', 'body-markup'))
    winotify.set_notifier(notifier)
    winotify.Notification(app_id='x', title='t', msg='a < b & c').show()
    assert _notify_args(bus)[4] == 'a &lt; b &amp; c'


def test_silent_audio_hint():
    notifier, bus = _notifier()
    winotify.set_notifier(notifier)
    note = winotify.Notification(app_id='x', title='t', msg='m')
    note.set_audio(winotify.audio.Silent, loop=False)
    note.show()
    assert _notify_args(bus)[6]['suppress-sound'] == ('b', True)


def test_notify_failure_does_not_raise():
    bus = FakeBus(answers={(N[0], N[2], 'GetCapabilities'): RuntimeError('no server'),
                           (N[0], N[2], 'Notify'): RuntimeError('no server')})
    notifier = winotify.Notifier(bus_factory=lambda: bus)
    assert notifier.notify('t', 'm') is None


# ---------------------------------------------------------------------- tray

def _menu(clicked):
    return pystray.Menu(
        pystray.MenuItem(lambda text: 'Logged in as: a@b.c', lambda icon, item: clicked.append('login')),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('Disabled_item', lambda: None, enabled=False),
        pystray.MenuItem('Up to date - Click to Check', lambda icon, item: clicked.append('update')),
    )


@pytest.fixture
def tray():
    bus = FakeBus(answers={('org.kde.StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher',
                            'RegisterStatusNotifierItem'): ()})
    clicked = []
    icon = tray_sni.Icon('TimeTracker', Image.new('RGBA', (16, 16), (0, 82, 204, 255)), menu=_menu(clicked))
    icon.bus_factory = lambda: bus
    icon._run_detached()
    yield icon, bus, clicked
    icon._stop()


def call(bus, path, interface, member, body=()):
    return bus.exports[path](FakeMessage(body, member=member, interface=interface, path=path))


def test_registers_and_serves_properties(tray):
    icon, bus, _ = tray
    assert icon.registered is True
    sig, (props,) = call(bus, ITEM_PATH, 'org.freedesktop.DBus.Properties', 'GetAll', ('org.kde.StatusNotifierItem',))
    assert props['Menu'] == ('o', MENU_PATH)
    assert props['ItemIsMenu'] == ('b', True)
    pixmaps = props['IconPixmap'][1]
    assert [p[0] for p in pixmaps] == [16, 22, 32, 48]
    assert len(pixmaps[0][2]) == 16 * 16 * 4


def test_argb_byte_order():
    (w, h, data), *_ = icon_pixmaps(Image.new('RGBA', (16, 16), (10, 20, 30, 255)))
    assert data[:4] == bytes([255, 10, 20, 30])


def test_layout_labels_separators_enabled(tray):
    icon, bus, _ = tray
    sig, (revision, layout) = call(bus, MENU_PATH, 'com.canonical.dbusmenu', 'GetLayout', (0, -1, []))
    assert sig == 'u(ia{sv}av)'
    children = [child for _sig, child in layout[2]]
    assert children[0][1]['label'] == ('s', 'Logged in as: a@b.c')
    assert children[1][1] == {'type': ('s', 'separator')}
    assert children[2][1]['label'] == ('s', 'Disabled__item')
    assert children[2][1]['enabled'] == ('b', False)


def test_click_invokes_menu_item(tray):
    icon, bus, clicked = tray
    call(bus, MENU_PATH, 'com.canonical.dbusmenu', 'GetLayout', (0, -1, []))
    call(bus, MENU_PATH, 'com.canonical.dbusmenu', 'Event', (4, 'clicked', ('s', ''), 0))
    deadline = time.time() + 2
    while not clicked and time.time() < deadline:
        time.sleep(0.01)
    assert clicked == ['update']


def test_disabled_item_not_invoked(tray):
    icon, bus, clicked = tray
    call(bus, MENU_PATH, 'com.canonical.dbusmenu', 'Event', (3, 'clicked', ('s', ''), 0))
    time.sleep(0.1)
    assert clicked == []


def test_menu_replacement_emits_layout_updated(tray):
    icon, bus, clicked = tray
    icon.menu = pystray.Menu(pystray.MenuItem('Only item', lambda: None))
    updates = [s for s in bus.signals if s[2] == 'LayoutUpdated']
    assert updates
    sig, (revision, layout) = call(bus, MENU_PATH, 'com.canonical.dbusmenu', 'GetLayout', (0, -1, []))
    assert [child[1]['label'][1] for _s, child in layout[2]] == ['Only item']


def test_icon_update_only_signals_real_changes(tray):
    icon, bus, _ = tray
    icon.visible = True
    before = len([s for s in bus.signals if s[2] == 'NewIcon'])
    icon.icon = Image.new('RGBA', (16, 16), (0, 82, 204, 255))       # same pixels
    assert len([s for s in bus.signals if s[2] == 'NewIcon']) == before
    icon.icon = Image.new('RGBA', (16, 16), (40, 167, 69, 255))      # green
    assert len([s for s in bus.signals if s[2] == 'NewIcon']) == before + 1


def test_registers_when_watcher_appears():
    bus = FakeBus(answers={('org.kde.StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher',
                            'RegisterStatusNotifierItem'): RuntimeError('ServiceUnknown')})
    icon = tray_sni.Icon('TimeTracker', Image.new('RGBA', (16, 16)), menu=_menu([]))
    icon.bus_factory = lambda: bus
    icon._run_detached()
    assert icon.registered is False
    bus.answers[('org.kde.StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher',
                 'RegisterStatusNotifierItem')] = ()
    bus.fire('org.freedesktop.DBus', 'NameOwnerChanged', ('org.kde.StatusNotifierWatcher', '', ':1.5'))
    assert icon.registered is True
    icon._stop()


def test_run_blocks_until_stop():
    bus = FakeBus(answers={('org.kde.StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher',
                            'RegisterStatusNotifierItem'): ()})
    icon = tray_sni.Icon('TimeTracker', Image.new('RGBA', (16, 16)), menu=_menu([]))
    icon.bus_factory = lambda: bus
    ready = threading.Event()
    worker = threading.Thread(target=icon.run, kwargs={'setup': lambda i: ready.set()}, daemon=True)
    worker.start()
    assert ready.wait(3)
    icon.stop()
    worker.join(3)
    assert not worker.is_alive()


# ------------------------------------------------- real session bus (marshalling)

def _real_bus_or_skip():
    from timetracker_linux.dbus_bus import Bus
    try:
        return Bus('SESSION')
    except Exception:
        pytest.skip('no session bus')


def test_tray_marshals_on_real_bus(monkeypatch):
    """Serve the tray on the real session bus, without registering with the
    host (so nothing appears in the user's panel), and query it as a host would."""
    server, client = _real_bus_or_skip(), _real_bus_or_skip()
    monkeypatch.setattr(tray_sni.Icon, '_register', lambda self: None)
    clicked = []
    icon = tray_sni.Icon('TimeTracker', Image.new('RGBA', (16, 16), (0, 82, 204, 255)), menu=_menu(clicked))
    icon.bus_factory = lambda: server
    try:
        icon._run_detached()
        props = client.call(server.unique_name, ITEM_PATH, 'org.freedesktop.DBus.Properties', 'GetAll',
                            's', ('org.kde.StatusNotifierItem',))[0]
        assert props['Menu'] == ('o', MENU_PATH)
        assert props['IconPixmap'][1][0][0] == 16
        revision, layout = client.call(server.unique_name, MENU_PATH, 'com.canonical.dbusmenu',
                                       'GetLayout', 'iias', (0, -1, []))
        labels = [child[1][1]['label'][1] for child in layout[2] if 'label' in child[1][1]]
        assert labels[0] == 'Logged in as: a@b.c'
        client.call(server.unique_name, MENU_PATH, 'com.canonical.dbusmenu', 'Event', 'isvu',
                    (4, 'clicked', ('s', ''), 0))
        deadline = time.time() + 2
        while not clicked and time.time() < deadline:
            time.sleep(0.01)
        assert clicked == ['update']
        (group,) = client.call(server.unique_name, MENU_PATH, 'com.canonical.dbusmenu',
                               'GetGroupProperties', 'aias', ([], []))
        assert len(group) == 4
        (needs_update,) = client.call(server.unique_name, MENU_PATH, 'com.canonical.dbusmenu',
                                      'AboutToShow', 'i', (0,))
        assert needs_update is True
    finally:
        icon._stop()
        server.close()
        client.close()
