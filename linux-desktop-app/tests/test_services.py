"""
Tests for autostart, location, app identity and update notices.

Spec: plan/2026-09-29_linux-desktop-app_phase1b-core-seams-and-services.md (AC 15-16, B.10-B.11)
"""

import socket
from types import SimpleNamespace
from unittest.mock import Mock

from fakes import FakeBus
from timetracker_linux import app_identity, autostart, location, updates

# ------------------------------------------------------------------ autostart


def test_autostart_enable_detect_disable(tmp_path):
    env = {'HOME': str(tmp_path)}
    assert autostart.is_enabled(env, system_dirs=()) is False
    autostart.enable('/opt/timetracker/TimeTracker --autostart', env)
    path = autostart.user_autostart_file(env)
    content = open(path).read()
    assert 'Exec=/opt/timetracker/TimeTracker --autostart' in content
    assert 'X-GNOME-Autostart-enabled=true' in content
    assert autostart.is_enabled(env, system_dirs=()) is True
    autostart.disable(env, system_dirs=())
    assert autostart.is_enabled(env, system_dirs=()) is False


def test_disable_system_entry_writes_hidden_override(tmp_path):
    system = tmp_path / 'xdg'
    system.mkdir()
    (system / 'com.amzur.timetracker.desktop').write_text('[Desktop Entry]\nExec=x\n')
    env = {'HOME': str(tmp_path / 'home')}
    assert autostart.is_enabled(env, system_dirs=(str(system),)) is True
    autostart.disable(env, system_dirs=(str(system),))
    assert 'Hidden=true' in open(autostart.user_autostart_file(env)).read()
    assert autostart.is_enabled(env, system_dirs=(str(system),)) is False


def test_exec_quoting():
    assert autostart.quote_exec_arg('/opt/timetracker/TimeTracker') == '/opt/timetracker/TimeTracker'
    assert autostart.quote_exec_arg('/home/a b/TimeTracker') == '"/home/a b/TimeTracker"'


# ------------------------------------------------------------------- location

ROUTES = """Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask
docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF
wlp2s0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000
"""


def test_default_route_interface():
    assert location.default_route_interface(ROUTES) == 'wlp2s0'
    assert location.default_route_interface('Iface\tDestination\n') is None


def test_local_ip_from_default_route(tmp_path):
    route = tmp_path / 'route'
    route.write_text(ROUTES)
    fake_psutil = SimpleNamespace(net_if_addrs=lambda: {
        'wlp2s0': [SimpleNamespace(family=socket.AF_INET6, address='fe80::1'),
                   SimpleNamespace(family=socket.AF_INET, address='192.168.1.23')],
        'docker0': [SimpleNamespace(family=socket.AF_INET, address='172.17.0.1')]})
    assert location.get_local_ip(str(route), fake_psutil, udp_probe=False) == '192.168.1.23'


def test_local_ip_never_loopback(tmp_path):
    route = tmp_path / 'route'
    route.write_text(ROUTES)
    fake_psutil = SimpleNamespace(net_if_addrs=lambda: {
        'wlp2s0': [SimpleNamespace(family=socket.AF_INET, address='127.0.1.1')]})
    assert location.get_local_ip(str(route), fake_psutil, udp_probe=False) is None


def test_nmcli_parsing():
    out = 'no:Neighbour\nyes:Office\\:5G\n'
    assert location.parse_nmcli_ssid(out) == 'Office:5G'
    assert location.parse_nmcli_ssid('no:A\n') is None


def test_ssid_from_networkmanager():
    nm = 'org.freedesktop.NetworkManager'
    bus = FakeBus(properties={
        (nm, nm, 'ActiveConnections'): ['/ac/1', '/ac/2'],
        (nm, f'{nm}.Connection.Active', 'Type'): '802-11-wireless',
        (nm, f'{nm}.Connection.Active', 'Devices'): ['/dev/3'],
        (nm, f'{nm}.Device.Wireless', 'ActiveAccessPoint'): '/ap/9',
        (nm, f'{nm}.AccessPoint', 'Ssid'): b'Amzur-Office',
    })
    assert location.get_wifi_ssid(bus) == 'Amzur-Office'


def test_ssid_falls_back_to_nmcli():
    bus = FakeBus()     # NetworkManager property reads fail
    run = Mock(return_value=SimpleNamespace(returncode=0, stdout='yes:HomeNet\n'))
    assert location.get_wifi_ssid(bus, run=run) == 'HomeNet'
    assert run.call_args.args[0] == ['nmcli', '-t', '-f', 'ACTIVE,SSID', 'dev', 'wifi']


# ------------------------------------------------------------- app identity

def _normalize(name):
    import re
    value = re.sub(r'\.(exe|app|dmg|msi|deb|rpm|snap|flatpak|bin)$', '', name.strip().lower())
    return re.sub(r'[\s\-_\.]+', '', value)


def test_linux_names_reach_windows_canonical_keys():
    """The core's normalizer + these aliases map Linux names onto admin (Windows) keys."""
    base_aliases = {'chrome': 'chrome', 'googlechrome': 'chrome', 'microsoftedge': 'msedge', 'code': 'vscode'}
    aliases = dict(base_aliases, **app_identity.LINUX_PROCESS_ALIASES)

    def canonical(name):
        normalized = _normalize(name)
        return aliases.get(normalized, normalized)

    assert canonical('google-chrome-stable') == 'chrome'
    assert canonical('google-chrome') == 'chrome'
    assert canonical('chromium-browser') == 'chrome'
    assert canonical('microsoft-edge-stable') == 'msedge'
    assert canonical('firefox-esr') == 'firefox'
    assert canonical('jetbrains-idea') == canonical('idea64.exe') == 'idea64'
    assert canonical('code') == 'vscode'


def test_email_clients_redacted_like_outlook():
    tables = app_identity.process_tables()
    assert {'thunderbird', 'evolution', 'geary', 'kmail'} <= tables['redacted_body_processes']
    assert 'google-chrome' in tables['browser_processes']


def test_desktop_entries_and_search(tmp_path):
    apps = tmp_path / 'applications'
    apps.mkdir()
    (apps / 'zoom.desktop').write_text('[Desktop Entry]\nType=Application\nName=Zoom Workplace\n'
                                       'Comment=Video meetings\nExec=/usr/bin/zoom %U\nStartupWMClass=zoom\n')
    (apps / 'hidden.desktop').write_text('[Desktop Entry]\nType=Application\nName=Hidden\nNoDisplay=true\n'
                                         'Exec=hidden\n')
    entries = app_identity.read_desktop_entries([str(apps)])
    assert [e['id'] for e in entries] == ['zoom']
    matches = app_identity.search_running_apps('zoom', entries=entries, running_names={'zoom', 'zoom-helper'})
    assert matches[0]['identifier'] == 'zoom'
    assert matches[0]['display_name'] == 'Zoom Workplace'
    assert matches[0]['confidence'] == 'high'
    assert any(m['identifier'] == 'zoom-helper' for m in matches)
    assert app_identity.search_running_apps('z', entries=entries, running_names=set()) == []


# -------------------------------------------------------------------- updates

def test_package_install_update_notice_once():
    notifier = Mock()
    handler = updates.UpdateNotifier(notifier_factory=lambda: notifier, mode='package')
    app = SimpleNamespace(update_available=False, update_required=False)
    info = {'latest_version': '1.5.0', 'is_mandatory': False, 'download_url': 'https://x/tt.deb'}
    assert handler.handle(app, info) is True
    handler.handle(app, info)
    assert notifier.notify.call_count == 1
    title, message = notifier.notify.call_args.args
    assert 'system software updater' in message
    assert notifier.notify.call_args.kwargs['launch'] == ''
    assert app.update_available is True and app.update_required is False


def test_mandatory_update_pauses_and_user_install_gets_link():
    notifier = Mock()
    handler = updates.UpdateNotifier(notifier_factory=lambda: notifier, mode='user')
    app = SimpleNamespace(update_available=False, update_required=False)
    handler.handle(app, {'latest_version': '2.0.0', 'is_mandatory': True, 'download_url': 'https://x/tt.tar.gz'})
    assert app.update_required is True
    assert notifier.notify.call_args.kwargs['launch'] == 'https://x/tt.tar.gz'
    assert 'paused' in notifier.notify.call_args.args[1]


def test_install_mode():
    assert updates.install_mode('/usr/bin/python3', frozen=False) == 'dev'
    assert updates.install_mode('/opt/timetracker/TimeTracker', frozen=True) == 'package'
    assert updates.install_mode('/home/u/.local/opt/timetracker/TimeTracker', frozen=True) == 'user'
