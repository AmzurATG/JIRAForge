#!/usr/bin/env python3
"""Test AT-SPI2 window detection with improved logic"""

import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

def test_atspi_detection():
    """Test the improved AT-SPI2 detection logic"""
    Atspi.init()
    desktop = Atspi.get_desktop(0)
    ACTIVE = Atspi.StateType.ACTIVE
    FOCUSED = Atspi.StateType.FOCUSED
    
    # Expanded list of system apps to skip
    SYSTEM_APPS = {
        'gnome-shell', 'gnome-software', 'ibus-daemon', 'gsd-color',
        'gsd-keyboard', 'gsd-wacom', 'gsd-power', 'gsd-media-keys',
        'gsd-xsettings', 'ibus-x11', 'ibus-extension-gtk3',
        'xdg-desktop-portal-gtk', 'xdg-desktop-portal-gnome',
        'update-notifier', 'gjs', 'evolution-alarm-notify'
    }
    
    app_count = desktop.get_child_count()
    print(f"Desktop has {app_count} apps")
    print()
    
    # Collect all candidate windows
    candidates = []
    for i in range(app_count):
        app = desktop.get_child_at_index(i)
        if not app:
            continue
        app_name = app.get_name() or ''
        
        # Skip system apps
        if app_name in SYSTEM_APPS:
            print(f"[SKIP] {app_name} (system app)")
            continue
        
        print(f"[APP] {app_name}")
        for j in range(app.get_child_count()):
            win = app.get_child_at_index(j)
            if not win:
                continue
            try:
                state_set = win.get_state_set()
                if not state_set:
                    continue
                
                title = win.get_name() or ''
                is_active = state_set.contains(ACTIVE)
                is_focused = state_set.contains(FOCUSED)
                
                status = []
                if is_focused:
                    status.append("FOCUSED")
                if is_active:
                    status.append("ACTIVE")
                
                if status:
                    status_str = " | ".join(status)
                    has_title = "✓" if title else "✗"
                    print(f"  Window {j}: [{status_str}] {has_title} title=\"{title[:60]}\"")
                    
                    if title:  # Only add to candidates if has title
                        priority = 2 if is_focused else 1
                        candidates.append((priority, title, app_name))
            except Exception as e:
                print(f"  Window {j}: Error - {e}")
    
    print()
    print("=" * 70)
    print("CANDIDATES")
    print("=" * 70)
    
    if candidates:
        candidates.sort(key=lambda x: x[0], reverse=True)
        print(f"Found {len(candidates)} candidate windows")
        print()
        for i, (priority, title, app_name) in enumerate(candidates, 1):
            priority_str = "FOCUSED" if priority == 2 else "ACTIVE"
            marker = ">>> SELECTED <<<" if i == 1 else ""
            print(f"{i}. [{priority_str}] {app_name}")
            print(f"   Title: {title[:60]}")
            print(f"   {marker}")
            print()
        
        print("=" * 70)
        print("RESULT")
        print("=" * 70)
        _, best_title, best_app = candidates[0]
        print(f"App:   {best_app}")
        print(f"Title: {best_title}")
    else:
        print("No active/focused windows found with titles")

if __name__ == "__main__":
    test_atspi_detection()
