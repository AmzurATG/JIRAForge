// TimeTracker Integration — shared core for the GNOME Shell extension.
//
// Built into two variants by ../build.sh:
//   esm/    GNOME 45+  (ES modules)   header-esm.js    + core.js + footer-esm.js
//   legacy/ GNOME 42-44 (imports.gi)  header-legacy.js + core.js + footer-legacy.js
// The headers define: Gio, GLib, Shell, Main, SHELL_VERSION.
//
// What it offers, on GNOME Shell's own session-bus connection at
// /com/amzur/TimeTracker/Shell (com.amzur.TimeTracker.Shell1):
//   - the focused window (title, app, pid, monitor) — Wayland has no public API
//   - a PNG of the focused window's monitor written into a caller-supplied fd.
//     Shell.Screenshot is used directly: the flash and shutter sound are only
//     added by GNOME's public screenshot D-Bus service, which is not involved.
//
// Security (plan §7.3): every call except GetVersion is accepted only from the
// installed TimeTracker binary (checked via the caller's /proc/<pid>/exe);
// only the focused monitor can be captured; captures are rate-limited and
// refused while the session is locked. Focus signals are unicast to the
// authenticated client, never broadcast (they carry window titles).

const TT_OBJECT_PATH = '/com/amzur/TimeTracker/Shell';
const TT_PROTOCOL = 1;
const TT_EXTENSION_VERSION = '1.0.0';
const TT_SYSTEM_EXECUTABLES = ['/opt/timetracker/TimeTracker'];
const TT_MIN_CAPTURE_INTERVAL_MS = 2000;
const TT_ERROR_DENIED = 'com.amzur.TimeTracker.Error.AccessDenied';
const TT_ERROR_FAILED = 'com.amzur.TimeTracker.Error.Failed';

const TT_INTERFACE_XML = `<node>
  <interface name="com.amzur.TimeTracker.Shell1">
    <method name="GetVersion">
      <arg type="u" direction="out" name="protocol"/>
      <arg type="s" direction="out" name="extension_version"/>
      <arg type="s" direction="out" name="shell_version"/>
    </method>
    <method name="GetFocusedWindow">
      <arg type="a{sv}" direction="out" name="window"/>
    </method>
    <method name="IsLocked">
      <arg type="b" direction="out" name="locked"/>
    </method>
    <method name="Subscribe"/>
    <method name="CaptureFocusedMonitor">
      <arg type="h" direction="in" name="fd"/>
      <arg type="a{sv}" direction="in" name="options"/>
      <arg type="a{sv}" direction="out" name="result"/>
    </method>
    <signal name="FocusChanged">
      <arg type="a{sv}" name="window"/>
    </signal>
  </interface>
</node>`;

function ttAllowedExecutables(extensionPath) {
    const allowed = TT_SYSTEM_EXECUTABLES.slice();
    // A per-user install (tarball --user, development) may name its own binary.
    // That file is exactly as trusted as the per-user extension files themselves.
    // A system-wide install (/usr/share/gnome-shell/extensions) ignores it.
    if (!extensionPath.startsWith('/usr/')) {
        const path = GLib.build_filenamev(
            [GLib.get_user_config_dir(), 'timetracker', 'extension-allowed-exe']);
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (ok) {
                new TextDecoder().decode(bytes).split('\n')
                    .map(line => line.trim())
                    .filter(line => line.startsWith('/'))
                    .forEach(line => allowed.push(line));
            }
        } catch (e) {
            // no per-user allow list
        }
    }
    return allowed;
}

function ttCallerExecutable(sender) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'GetConnectionUnixProcessID', new GLib.Variant('(s)', [sender]),
            new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, 2000, null,
            (connection, result) => {
                try {
                    const [pid] = connection.call_finish(result).deepUnpack();
                    let exe = GLib.file_read_link(`/proc/${pid}/exe`);
                    // A binary replaced by a package upgrade reads "<path> (deleted)".
                    if (exe.endsWith(' (deleted)'))
                        exe = exe.slice(0, -' (deleted)'.length);
                    resolve(exe);
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function ttVariantDict(values) {
    const dict = {};
    for (const [key, [type, value]] of Object.entries(values))
        dict[key] = new GLib.Variant(type, value);
    return dict;
}

class TimeTrackerService {
    constructor(extensionPath) {
        this._extensionPath = extensionPath;
        this._dbus = null;
        this._authorized = new Map();       // unique bus name → true/false
        this._subscribers = new Set();
        this._lastCaptureUs = 0;
        this._focusSignal = 0;
        this._titleWindow = null;
        this._titleSignal = 0;
        this._nameOwnerSignal = 0;
    }

    enable() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(TT_INTERFACE_XML, this);
        this._dbus.export(Gio.DBus.session, TT_OBJECT_PATH);
        this._focusSignal = global.display.connect('notify::focus-window', () => this._onFocusChanged());
        // Forget authorizations of disconnected clients.
        this._nameOwnerSignal = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                const [name, , newOwner] = params.deepUnpack();
                if (!newOwner) {
                    this._authorized.delete(name);
                    this._subscribers.delete(name);
                }
            });
        this._onFocusChanged();
    }

    disable() {
        if (this._focusSignal)
            global.display.disconnect(this._focusSignal);
        this._focusSignal = 0;
        this._disconnectTitle();
        if (this._nameOwnerSignal)
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerSignal);
        this._nameOwnerSignal = 0;
        if (this._dbus) {
            this._dbus.flush();
            this._dbus.unexport();
        }
        this._dbus = null;
        this._authorized.clear();
        this._subscribers.clear();
    }

    // --------------------------------------------------------------- auth

    async _authorize(invocation) {
        const sender = invocation.get_sender();
        if (this._authorized.has(sender))
            return this._authorized.get(sender);
        let allowed = false;
        try {
            const exe = await ttCallerExecutable(sender);
            allowed = ttAllowedExecutables(this._extensionPath).includes(exe);
            if (!allowed)
                console.warn(`TimeTracker extension: rejected caller ${exe}`);
        } catch (e) {
            allowed = false;
        }
        this._authorized.set(sender, allowed);
        return allowed;
    }

    async _guard(invocation) {
        if (await this._authorize(invocation))
            return true;
        invocation.return_dbus_error(TT_ERROR_DENIED, 'Only the installed TimeTracker app may use this interface');
        return false;
    }

    // -------------------------------------------------------------- state

    _isLocked() {
        return Boolean(Main.sessionMode.isLocked || (Main.screenShield && Main.screenShield.locked));
    }

    _windowInfo() {
        const win = global.display.focus_window;
        const base = {
            locked: ['b', this._isLocked()],
            overview: ['b', Boolean(Main.overview && Main.overview.visible)],
        };
        if (!win)
            return ttVariantDict(Object.assign(base, {focused: ['b', false]}));

        const app = Shell.WindowTracker.get_default().get_window_app(win);
        let appId = app ? app.get_id() || '' : '';
        if (appId.endsWith('.desktop'))
            appId = appId.slice(0, -'.desktop'.length);
        if (appId.startsWith('window:'))
            appId = '';
        const monitor = win.get_monitor();
        const geometry = global.display.get_monitor_geometry(monitor);
        return ttVariantDict(Object.assign(base, {
            focused: ['b', true],
            title: ['s', win.get_title() || ''],
            wm_class: ['s', win.get_wm_class() || ''],
            app_id: ['s', appId],
            pid: ['i', win.get_pid()],
            window_id: ['s', String(win.get_stable_sequence())],
            monitor_index: ['i', monitor],
            monitor_x: ['i', geometry.x],
            monitor_y: ['i', geometry.y],
            monitor_width: ['i', geometry.width],
            monitor_height: ['i', geometry.height],
            scale: ['d', global.display.get_monitor_scale(monitor)],
            minimized: ['b', Boolean(win.minimized)],
            fullscreen: ['b', Boolean(win.fullscreen)],
        }));
    }

    // ------------------------------------------------------------ signals

    _disconnectTitle() {
        if (this._titleWindow && this._titleSignal)
            this._titleWindow.disconnect(this._titleSignal);
        this._titleWindow = null;
        this._titleSignal = 0;
    }

    _onFocusChanged() {
        this._disconnectTitle();
        const win = global.display.focus_window;
        if (win) {
            this._titleWindow = win;
            this._titleSignal = win.connect('notify::title', () => this._emitFocus());
        }
        this._emitFocus();
    }

    _emitFocus() {
        if (!this._dbus || this._subscribers.size === 0)
            return;
        const params = new GLib.Variant('(a{sv})', [this._windowInfo()]);
        for (const subscriber of this._subscribers) {
            try {
                Gio.DBus.session.emit_signal(subscriber, TT_OBJECT_PATH,
                    'com.amzur.TimeTracker.Shell1', 'FocusChanged', params);
            } catch (e) {
                this._subscribers.delete(subscriber);
            }
        }
    }

    // ------------------------------------------------------------ methods

    GetVersion() {
        return [TT_PROTOCOL, TT_EXTENSION_VERSION, SHELL_VERSION];
    }

    async GetFocusedWindowAsync(params, invocation) {
        if (!await this._guard(invocation))
            return;
        invocation.return_value(new GLib.Variant('(a{sv})', [this._windowInfo()]));
    }

    async IsLockedAsync(params, invocation) {
        if (!await this._guard(invocation))
            return;
        invocation.return_value(new GLib.Variant('(b)', [this._isLocked()]));
    }

    async SubscribeAsync(params, invocation) {
        if (!await this._guard(invocation))
            return;
        this._subscribers.add(invocation.get_sender());
        invocation.return_value(null);
    }

    async CaptureFocusedMonitorAsync(params, invocation) {
        if (!await this._guard(invocation))
            return;
        const reply = values => invocation.return_value(
            new GLib.Variant('(a{sv})', [ttVariantDict(values)]));

        const [fdIndex] = params;
        const fdList = invocation.get_message().get_unix_fd_list();
        let fd = -1;
        try {
            fd = fdList.get(fdIndex);
        } catch (e) {
            invocation.return_dbus_error(TT_ERROR_FAILED, 'no file descriptor passed');
            return;
        }
        const closeFd = () => {
            try {
                if (fd >= 0)
                    GLib.close(fd);
            } catch (e) {
                // already closed
            }
            fd = -1;
        };

        if (this._isLocked()) {
            closeFd();
            reply({status: ['s', 'locked']});
            return;
        }
        const win = global.display.focus_window;
        if (!win || (Main.overview && Main.overview.visible)) {
            closeFd();
            reply({status: ['s', 'no_focus']});
            return;
        }
        if (win.minimized) {
            closeFd();
            reply({status: ['s', 'minimized']});
            return;
        }
        const now = GLib.get_monotonic_time();
        if (now - this._lastCaptureUs < TT_MIN_CAPTURE_INTERVAL_MS * 1000) {
            closeFd();
            reply({status: ['s', 'rate_limited']});
            return;
        }
        this._lastCaptureUs = now;

        const monitor = win.get_monitor();
        const geometry = global.display.get_monitor_geometry(monitor);
        const scale = global.display.get_monitor_scale(monitor);
        const windowId = String(win.get_stable_sequence());
        if (!TT_UnixOutputStream) {
            closeFd();
            invocation.return_dbus_error(TT_ERROR_FAILED, 'Unix output streams unavailable');
            return;
        }
        const stream = new TT_UnixOutputStream({fd, close_fd: true});
        fd = -1;                        // owned by the stream now
        const screenshot = new Shell.Screenshot();
        try {
            screenshot.screenshot_area(geometry.x, geometry.y, geometry.width, geometry.height, stream,
                (shooter, result) => {
                    let ok = false;
                    try {
                        [ok] = shooter.screenshot_area_finish(result);
                    } catch (e) {
                        ok = false;
                    }
                    try {
                        stream.close(null);
                    } catch (e) {
                        // ignore
                    }
                    reply({
                        status: ['s', ok ? 'ok' : 'error'],
                        format: ['s', 'png'],
                        window_id: ['s', windowId],
                        monitor_index: ['i', monitor],
                        monitor_x: ['i', geometry.x],
                        monitor_y: ['i', geometry.y],
                        monitor_width: ['i', geometry.width],
                        monitor_height: ['i', geometry.height],
                        scale: ['d', scale],
                    });
                });
        } catch (e) {
            try {
                stream.close(null);
            } catch (e2) {
                // ignore
            }
            invocation.return_dbus_error(TT_ERROR_FAILED, `${e}`);
        }
    }
}
