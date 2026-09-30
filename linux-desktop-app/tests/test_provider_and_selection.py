"""
Tests for the backend selection table, the platform provider and the launcher.

Spec: phase 1a items 14-15; phase 1b AC 17; selection table from the plan §6.2.
"""

import os
import sys
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from PIL import Image

import platform_hooks
import monitor_capture
from timetracker_linux import launcher
from timetracker_linux.capture.result import CaptureResult, CaptureStatus
from timetracker_linux.environment import Environment
from timetracker_linux.provider import LinuxPlatformProvider, install
from timetracker_linux.selection import plan_for


def env(session, desktop):
    return Environment(session_type=session, desktop=desktop, desktop_raw=desktop,
                       distro_id='', distro_version='', distro_pretty='')


class TestSelectionTable:

    @pytest.mark.parametrize('desktop', ['gnome', 'kde', 'sway', 'hyprland', 'wlroots', 'other'])
    def test_x11_never_chosen_on_wayland(self, desktop):
        plan = plan_for(env('wayland', desktop))
        for subsystem in ('window', 'capture', 'idle'):
            assert not any(b.startswith('x11') or b == 'xss' or b == 'pynput_x11'
                           for b in plan[subsystem]), (desktop, subsystem, plan[subsystem])

    def test_x11_session(self):
        plan = plan_for(env('x11', 'cinnamon'))
        assert plan['window'][0] == 'x11_ewmh'
        assert plan['capture'][0] == 'x11'
        assert plan['idle'][0] == 'xss'

    def test_gnome_wayland(self):
        plan = plan_for(env('wayland', 'gnome'))
        assert plan['window'] == ['gnome_extension', 'atspi', 'null']
        assert plan['capture'] == ['gnome_extension', 'portal_screencast', 'null']
        assert plan['idle'][0] == 'mutter'

    def test_kde_wayland(self):
        plan = plan_for(env('wayland', 'kde'))
        assert plan['capture'] == ['kwin', 'portal_screencast', 'null']
        assert plan['window'][0] == 'kwin_script'

    def test_sway(self):
        plan = plan_for(env('wayland', 'sway'))
        assert plan['capture'] == ['wlroots', 'portal_screencast', 'null']
        assert plan['window'][0] == 'sway'

    def test_unknown_session(self):
        plan = plan_for(env('unknown', 'other'))
        assert plan['capture'] == ['null']
        assert plan['window'] == ['null']

    def test_every_chain_ends_with_fallback(self):
        for session in ('x11', 'wayland', 'unknown'):
            for desktop in ('gnome', 'kde', 'sway', 'hyprland', 'wlroots', 'cinnamon', 'other'):
                plan = plan_for(env(session, desktop))
                assert plan['capture'][-1] == 'null'
                assert plan['window'][-1] == 'null'


class FakeCaptureService:
    def __init__(self, results):
        self.results = list(results)
        self.expected = []

    def capture(self, expected_window_id=None):
        self.expected.append(expected_window_id)
        return self.results.pop(0) if len(self.results) > 1 else self.results[0]

    def stats(self):
        return {'active_backend': 'fake', 'backends': ['fake'], 'by_status': {}}

    def reprobe(self):
        self.reprobed = True


class FakeWindowService:
    def __init__(self, window):
        self.window = window
        self.backend_names = ['fake']
        self.active_backend_name = 'fake'
        self._backends = []

    def get_focused_window(self):
        return dict(self.window) if self.window else None

    def has_backend(self):
        return self.window is not None

    def reset(self):
        pass


def _provider(window=None, results=None, **kw):
    return LinuxPlatformProvider(
        environment=env('wayland', 'gnome'), connect_buses=False,
        window_service=FakeWindowService(window),
        capture_service=FakeCaptureService(results or [CaptureResult(image=None, status=CaptureStatus.ERROR)]),
        idle_service=kw.get('idle_service') or SimpleNamespace(get_idle_seconds=lambda: 12.0,
                                                               active_backend_name='mutter', reset=lambda: None),
        session_events=kw.get('session_events') or SimpleNamespace(is_locked=lambda: False,
                                                                   start=lambda app: True),
        instance_lock=kw.get('instance_lock') or SimpleNamespace(acquire=lambda: True, release=lambda: None))


class TestProvider:

    def teardown_method(self):
        platform_hooks.clear()

    def test_capture_expects_last_focused_window(self):
        image = Image.new('RGB', (4, 4))
        provider = _provider({'window_id': 'w1', 'title': 't', 'app': 'a'},
                             [CaptureResult(image=image, status=CaptureStatus.OK, window_id='w1')])
        provider.get_focused_window()
        assert provider.capture_focused_monitor() is not None
        assert provider.capture_service.expected == ['w1']

    def test_frame_reused_for_same_window_within_10s(self):
        image = Image.new('RGB', (4, 4))
        provider = _provider({'window_id': 'w1', 'title': 't', 'app': 'a'},
                             [CaptureResult(image=image, status=CaptureStatus.OK, window_id='w1')])
        provider.get_focused_window()
        provider.capture_focused_monitor()
        provider.capture_focused_monitor()
        assert len(provider.capture_service.expected) == 1

    def test_no_frame_reuse_across_windows(self):
        image = Image.new('RGB', (4, 4))
        provider = _provider({'window_id': 'w1', 'title': 't', 'app': 'a'},
                             [CaptureResult(image=image, status=CaptureStatus.OK, window_id='w1')])
        provider.get_focused_window()
        provider.capture_focused_monitor()
        provider.window_service.window = {'window_id': 'w2', 'title': 'u', 'app': 'b'}
        provider.get_focused_window()
        provider.capture_focused_monitor()
        assert provider.capture_service.expected == ['w1', 'w2']

    def test_input_hooks_only_on_x11(self):
        assert _provider().use_input_hooks() is False
        provider = _provider()
        provider.environment = env('x11', 'xfce')
        assert provider.use_input_hooks() is True

    def test_seams_delegate(self):
        provider = _provider()
        assert provider.get_system_idle_seconds() == 12.0
        assert provider.is_screen_locked() is False
        assert provider.install_application() is True
        assert provider.update_platform == 'linux'
        assert 'thunderbird' in provider.process_tables()['redacted_body_processes']

    def test_unlock_reprobes_backends(self):
        events = {}
        provider = _provider(session_events=SimpleNamespace(
            is_locked=lambda: False, start=lambda relay: events.setdefault('relay', relay) and True))
        app = Mock()
        provider.start_session_events(app)
        events['relay']._on_screen_unlock()
        app._on_screen_unlock.assert_called_once()
        assert provider.capture_service.reprobed is True

    def test_install_registers_with_core(self):
        provider = install(_provider())
        assert platform_hooks.get() is provider
        assert monitor_capture.capture_focused_monitor() is None

    def test_second_launch_opens_running_instance(self, monkeypatch):
        from timetracker_linux.compat import winotify
        opened = []
        monkeypatch.setattr(winotify, 'open_url', opened.append)
        monkeypatch.setitem(sys.modules, 'desktop_app',
                            SimpleNamespace(get_env_var=lambda key, default=None: '51778'))
        assert _provider().acquire_single_instance() is True
        assert opened == []
        held = SimpleNamespace(acquire=lambda: False, release=lambda: None)
        assert _provider(instance_lock=held).acquire_single_instance() is False
        assert opened == ['http://localhost:51778/']

    def test_diagnostics_shape(self):
        d = _provider().diagnostics()
        assert d['session_type'] == 'wayland'
        assert d['idle_backend'] == 'mutter'
        assert 'install_mode' in d


class TestLauncher:

    def test_winotify_module_registered(self):
        launcher.install_notifications()
        import winotify
        assert hasattr(winotify, 'Notification') and hasattr(winotify, 'audio')

    def test_browser_opens_through_system_xdg_open(self, monkeypatch):
        import webbrowser
        from timetracker_linux.compat import winotify
        opened = []
        monkeypatch.setattr(winotify, 'open_url', opened.append)
        for name in ('open', 'open_new', 'open_new_tab'):
            monkeypatch.setattr(webbrowser, name, getattr(webbrowser, name))
        launcher.install_browser()
        assert webbrowser.open('http://localhost:51778/login') is True
        webbrowser.open_new_tab('http://localhost:51778/')
        assert opened == ['http://localhost:51778/login', 'http://localhost:51778/']

    def test_frozen_app_uses_bundled_fontconfig(self, monkeypatch, tmp_path):
        from timetracker_linux import childenv
        conf = tmp_path / 'fontconfig' / 'fonts.conf'
        conf.parent.mkdir()
        conf.write_text('<fontconfig/>')
        monkeypatch.setattr(sys, 'frozen', True, raising=False)
        monkeypatch.setattr(sys, '_MEIPASS', str(tmp_path), raising=False)
        monkeypatch.delenv('FONTCONFIG_FILE', raising=False)
        launcher.install_fontconfig()
        assert os.environ['FONTCONFIG_FILE'] == str(conf)
        assert 'FONTCONFIG_FILE' not in childenv.clean_env()

    def test_fontconfig_left_alone_from_source_or_when_user_set(self, monkeypatch, tmp_path):
        monkeypatch.setattr(sys, '_MEIPASS', str(tmp_path), raising=False)
        monkeypatch.delenv('FONTCONFIG_FILE', raising=False)
        monkeypatch.delattr(sys, 'frozen', raising=False)
        launcher.install_fontconfig()
        assert 'FONTCONFIG_FILE' not in os.environ
        monkeypatch.setattr(sys, 'frozen', True, raising=False)
        monkeypatch.setenv('FONTCONFIG_FILE', '/home/u/fonts.conf')
        launcher.install_fontconfig()
        assert os.environ['FONTCONFIG_FILE'] == '/home/u/fonts.conf'

    def test_shipped_fontconfig_rejects_colour_bitmap_fonts(self):
        import xml.etree.ElementTree as ET
        conf = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(launcher.__file__))),
                            'fontconfig', 'fonts.conf')
        root = ET.parse(conf).getroot()
        assert root.find('include').text == '/etc/fonts/fonts.conf'
        patterns = [{e.get('name'): e.find('bool').text for e in p.findall('patelt')}
                    for p in root.iter('pattern')]
        assert {'outline': 'false', 'scalable': 'true'} in patterns

    def test_tray_sni_with_session_bus(self):
        import pystray
        from timetracker_linux.compat import tray_sni
        provider = SimpleNamespace(session_bus=object(), environment=env('wayland', 'gnome'))
        assert launcher.install_tray(provider) == 'sni'
        assert pystray.Icon is tray_sni.Icon

    def test_no_tray_without_bus_on_wayland(self):
        import pystray
        from timetracker_linux.compat import tray_none
        provider = SimpleNamespace(session_bus=None, environment=env('wayland', 'sway'))
        assert launcher.install_tray(provider) == 'none'
        assert pystray.Icon is tray_none.Icon

    def test_sigterm_raises_system_exit(self):
        import signal
        previous = signal.getsignal(signal.SIGTERM)
        try:
            launcher.install_signal_handlers()
            with pytest.raises(SystemExit):
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
        finally:
            signal.signal(signal.SIGTERM, previous)
            signal.signal(signal.SIGHUP, signal.SIG_DFL)

    def test_untrackable_desktop_warns(self, monkeypatch):
        sent = []
        from timetracker_linux.compat import winotify
        monkeypatch.setattr(winotify, 'get_notifier', lambda: SimpleNamespace(
            notify=lambda title, message, **kw: sent.append(title)))
        launcher.warn_if_untrackable(_provider(window=None))
        assert sent == ['TimeTracker cannot track this desktop']
        sent.clear()
        launcher.warn_if_untrackable(_provider(window={'window_id': 'w'}))
        assert sent == []

    def test_run_app_order(self, monkeypatch):
        """Provider, winotify and tray are installed before desktop_app is imported."""
        order = []
        fake_core = SimpleNamespace(main=lambda: order.append(('main', platform_hooks.get() is not None,
                                                               'winotify' in sys.modules)))
        monkeypatch.setitem(sys.modules, 'desktop_app', fake_core)
        monkeypatch.setattr(launcher, 'prepare_directories', lambda: None)
        monkeypatch.setattr(launcher, 'install_browser', lambda: None)
        monkeypatch.setattr(launcher, 'install_signal_handlers', lambda: order.append('signals'))
        monkeypatch.setattr(launcher, 'install_tray', lambda provider: order.append('tray') or 'none')
        monkeypatch.setattr(launcher, 'warn_if_untrackable', lambda provider: None)
        launcher.run_app(provider_factory=lambda: _provider(window={'window_id': 'w'}))
        assert order == ['tray', 'signals', ('main', True, True)]
        platform_hooks.clear()
