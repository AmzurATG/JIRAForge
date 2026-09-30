"""
Which backends to try, in order, for each subsystem (plan §6.2).

Names only; the provider maps names to implemented backend classes and
drops names that are not implemented yet. Every capture and window chain
ends in 'null', so an unsupported desktop is reported, never guessed.
"""

_WLROOTS_FAMILIES = ('sway', 'hyprland', 'wlroots')


def plan_for(environment):
    session = environment.session_type
    desktop = environment.desktop

    if session == 'x11':
        return {
            'window': ['x11_ewmh', 'null'],
            'capture': ['x11', 'null'],
            'idle': ['xss', 'pynput_x11', 'logind_idlehint'],
        }

    if session != 'wayland':
        return {'window': ['null'], 'capture': ['null'], 'idle': ['logind_idlehint']}

    if desktop == 'gnome':
        return {
            'window': ['gnome_extension', 'atspi', 'null'],
            'capture': ['gnome_extension', 'portal_screencast', 'null'],
            'idle': ['mutter', 'logind_idlehint'],
        }
    if desktop == 'kde':
        return {
            'window': ['kwin_script', 'atspi', 'null'],
            'capture': ['kwin', 'portal_screencast', 'null'],
            'idle': ['wayland_idle_notify', 'freedesktop_screensaver', 'logind_idlehint'],
        }
    if desktop in _WLROOTS_FAMILIES:
        window = [desktop] if desktop in ('sway', 'hyprland') else []
        return {
            'window': window + ['atspi', 'null'],
            'capture': ['wlroots', 'portal_screencast', 'null'],
            'idle': ['wayland_idle_notify', 'logind_idlehint'],
        }
    return {
        'window': ['atspi', 'null'],
        'capture': ['portal_screencast', 'null'],
        'idle': ['wayland_idle_notify', 'freedesktop_screensaver', 'logind_idlehint'],
    }
