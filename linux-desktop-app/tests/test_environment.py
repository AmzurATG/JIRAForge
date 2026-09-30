"""
Tests for environment detection.

Spec: plan/2026-09-29_linux-desktop-app_phase1-foundation.md (AC 7-9)
"""

import pytest

from timetracker_linux import environment
from timetracker_linux.environment import detect, probe_dbus


UBUNTU_2404 = '''PRETTY_NAME="Ubuntu 24.04.5 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
ID=ubuntu
ID_LIKE=debian
'''

FEDORA = '''NAME="Fedora Linux"
VERSION_ID=43
ID=fedora
PRETTY_NAME="Fedora Linux 43 (Workstation Edition)"
'''


class TestSessionType:
    """AC 7"""

    def test_wayland_with_display_is_not_x11(self):
        env = {'XDG_SESSION_TYPE': 'wayland', 'DISPLAY': ':0', 'WAYLAND_DISPLAY': 'wayland-0'}
        assert detect(env, UBUNTU_2404).session_type == 'wayland'

    def test_wayland_without_wayland_display_still_wayland(self):
        env = {'XDG_SESSION_TYPE': 'wayland', 'DISPLAY': ':0'}
        assert detect(env, UBUNTU_2404).session_type == 'wayland'

    def test_x11_only_when_declared(self):
        assert detect({'XDG_SESSION_TYPE': 'x11', 'DISPLAY': ':0'}, None).session_type == 'x11'

    def test_missing_session_type_uses_wayland_display(self):
        env = {'WAYLAND_DISPLAY': 'wayland-0', 'DISPLAY': ':0'}
        assert detect(env, None).session_type == 'wayland'

    def test_missing_session_type_display_only_is_x11(self):
        assert detect({'DISPLAY': ':0'}, None).session_type == 'x11'

    def test_nothing_is_unknown(self):
        assert detect({}, None).session_type == 'unknown'

    def test_tty_session_type_with_wayland_display(self):
        env = {'XDG_SESSION_TYPE': 'tty', 'WAYLAND_DISPLAY': 'wayland-1'}
        assert detect(env, None).session_type == 'wayland'


class TestDesktopFamily:
    """AC 8"""

    @pytest.mark.parametrize('raw, family', [
        ('ubuntu:GNOME', 'gnome'),
        ('GNOME', 'gnome'),
        ('GNOME-Classic:GNOME', 'gnome'),
        ('KDE', 'kde'),
        ('sway', 'sway'),
        ('Hyprland', 'hyprland'),
        ('labwc:wlroots', 'wlroots'),
        ('river', 'wlroots'),
        ('X-Cinnamon', 'cinnamon'),
        ('XFCE', 'xfce'),
        ('MATE', 'mate'),
        ('Pop:COSMIC', 'other'),
        ('', 'other'),
    ])
    def test_family(self, raw, family):
        env = {'XDG_SESSION_TYPE': 'wayland', 'XDG_CURRENT_DESKTOP': raw}
        result = detect(env, None)
        assert result.desktop == family
        assert result.desktop_raw == raw

    def test_sway_from_socket_when_desktop_missing(self):
        env = {'XDG_SESSION_TYPE': 'wayland', 'SWAYSOCK': '/run/user/1000/sway-ipc.sock'}
        assert detect(env, None).desktop == 'sway'

    def test_hyprland_from_signature_when_desktop_missing(self):
        env = {'XDG_SESSION_TYPE': 'wayland', 'HYPRLAND_INSTANCE_SIGNATURE': 'abc'}
        assert detect(env, None).desktop == 'hyprland'

    def test_os_release_parsed(self):
        result = detect({'XDG_SESSION_TYPE': 'wayland'}, UBUNTU_2404)
        assert result.distro_id == 'ubuntu'
        assert result.distro_version == '24.04'
        assert result.distro_pretty == 'Ubuntu 24.04.5 LTS'

    def test_os_release_unquoted(self):
        result = detect({}, FEDORA)
        assert result.distro_id == 'fedora'
        assert result.distro_version == '43'

    def test_os_release_missing(self):
        result = detect({}, None)
        assert result.distro_id == ''
        assert result.distro_pretty == ''


class _FakeDBus:
    """Fake DBusClient: maps (kind, *args) to a value or an exception."""

    def __init__(self, answers):
        self.answers = answers

    def _answer(self, key):
        value = self.answers.get(key, LookupError('no such service'))
        if isinstance(value, Exception):
            raise value
        return value

    def get_property(self, bus_name, path, interface, name):
        return self._answer(('prop', bus_name, interface, name))

    def name_has_owner(self, bus_name):
        return self._answer(('owner', bus_name))

    def call(self, bus_name, path, interface, method, signature='', args=()):
        return self._answer(('call', bus_name, interface, method))


class TestProbeDbus:
    """AC 9"""

    def test_no_bus_returns_errors_without_raising(self):
        def factory():
            raise OSError('no session bus')

        result = probe_dbus(client_factory=factory)
        assert result['bus'] is False
        assert 'no session bus' in result['error']

    def test_partial_results(self):
        fake = _FakeDBus({
            ('prop', 'org.gnome.Shell', 'org.gnome.Shell', 'ShellVersion'): '46.0',
            ('owner', 'org.kde.KWin'): False,
            ('prop', 'org.freedesktop.portal.Desktop',
             'org.freedesktop.portal.ScreenCast', 'version'): 5,
            ('call', 'org.gnome.Shell', 'org.gnome.Shell.Extensions', 'GetExtensionInfo'):
                RuntimeError('extension service missing'),
        })
        result = probe_dbus(client_factory=lambda: fake)
        assert result['bus'] is True
        assert result['gnome_shell_version'] == '46.0'
        assert result['kwin'] is False
        assert result['portal_screencast_version'] == 5
        assert result['gnome_extension_state'] is None

    def test_everything_missing(self):
        result = probe_dbus(client_factory=lambda: _FakeDBus({}))
        assert result['bus'] is True
        assert result['gnome_shell_version'] is None
        assert result['kwin'] is None
        assert result['portal_screencast_version'] is None

    def test_extension_state_reported(self):
        fake = _FakeDBus({
            ('call', 'org.gnome.Shell', 'org.gnome.Shell.Extensions', 'GetExtensionInfo'):
                {'state': 1.0, 'version': 1},
        })
        result = probe_dbus(client_factory=lambda: fake)
        assert result['gnome_extension_state'] == 'ENABLED'

    def test_extension_not_installed(self):
        fake = _FakeDBus({
            ('call', 'org.gnome.Shell', 'org.gnome.Shell.Extensions', 'GetExtensionInfo'): {},
        })
        result = probe_dbus(client_factory=lambda: fake)
        assert result['gnome_extension_state'] == 'NOT_INSTALLED'


def test_extension_state_names():
    assert environment.extension_state_name(1) == 'ENABLED'
    assert environment.extension_state_name(2) == 'DISABLED'
    assert environment.extension_state_name(3) == 'ERROR'
    assert environment.extension_state_name(4) == 'OUT_OF_DATE'
    assert environment.extension_state_name(6) == 'INITIALIZED'
    assert environment.extension_state_name(99) == 'UNINSTALLED'
    assert environment.extension_state_name(42) == 'UNKNOWN(42)'
