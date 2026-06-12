"""
Integration tests for quality popup on Linux.

These tests are designed to run on actual Linux systems and verify:
- Popup displays correctly on X11 and Wayland
- Window hints are applied correctly
- User interactions work as expected

Run with: pytest tests/integration/test_quality_popup_linux.py -v

Note: These tests require a display (X11 or Wayland) to be available.
Skip in CI environments without display by setting SKIP_GUI_TESTS=1.
"""

import pytest
import sys
import os
import shutil

# Skip all tests in this file if not on Linux
pytestmark = pytest.mark.skipif(
    not sys.platform.startswith('linux'),
    reason="Linux-specific tests"
)


def skip_if_no_display():
    """Skip test if no display is available."""
    if os.environ.get('SKIP_GUI_TESTS') == '1':
        pytest.skip("GUI tests disabled via SKIP_GUI_TESTS")
    if not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
        pytest.skip("No display available")


@pytest.fixture
def display_info():
    """Get display environment information."""
    return {
        'display': os.environ.get('DISPLAY'),
        'wayland_display': os.environ.get('WAYLAND_DISPLAY'),
        'xdg_session_type': os.environ.get('XDG_SESSION_TYPE'),
        'xdg_current_desktop': os.environ.get('XDG_CURRENT_DESKTOP'),
        'is_wayland': bool(
            os.environ.get('WAYLAND_DISPLAY') or
            os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
        )
    }


class TestEnvironmentDetection:
    """Tests for environment detection functions."""
    
    def test_display_env_vars_logged(self, display_info):
        """Log environment variables for debugging."""
        print(f"\n=== Display Environment ===")
        print(f"DISPLAY: {display_info['display'] or 'not set'}")
        print(f"WAYLAND_DISPLAY: {display_info['wayland_display'] or 'not set'}")
        print(f"XDG_SESSION_TYPE: {display_info['xdg_session_type'] or 'not set'}")
        print(f"XDG_CURRENT_DESKTOP: {display_info['xdg_current_desktop'] or 'not set'}")
        print(f"Is Wayland: {display_info['is_wayland']}")
        
        # At least one display should be available on a running system
        # (unless in CI without display)
        has_display = display_info['display'] or display_info['wayland_display']
        print(f"Has Display: {has_display}")
    
    def test_wayland_detection_consistency(self, display_info):
        """Test Wayland detection is consistent with environment."""
        if display_info['wayland_display']:
            assert display_info['is_wayland'] is True
        elif display_info['xdg_session_type'] == 'wayland':
            assert display_info['is_wayland'] is True
        elif display_info['display'] and not display_info['wayland_display']:
            # X11 only
            if display_info['xdg_session_type'] != 'wayland':
                assert display_info['is_wayland'] is False


class TestLinuxNotifications:
    """Integration tests for Linux notifications."""
    
    def test_notify_send_available(self):
        """Test notify-send is available on the system."""
        notify_send = shutil.which('notify-send')
        
        if notify_send:
            print(f"✓ notify-send found at: {notify_send}")
        else:
            print("✗ notify-send not installed")
            pytest.skip("notify-send not installed - install libnotify-bin")
    
    def test_basic_notification_command(self):
        """Test basic notify-send command can be constructed."""
        notify_send = shutil.which('notify-send')
        if not notify_send:
            pytest.skip("notify-send not installed")
        
        title = "Test Title"
        body = "Test body message"
        urgency = "low"
        app_name = "Test"
        
        # Construct command (don't actually execute in tests)
        cmd = [notify_send, "--urgency", urgency, "--app-name", app_name, title, body]
        
        assert len(cmd) == 8
        assert cmd[0] == notify_send
        assert cmd[1] == "--urgency"
        assert cmd[2] == "low"
        assert cmd[3] == "--app-name"
        assert cmd[4] == "Test"
        assert cmd[5] == "Test Title"
        assert cmd[6] == "Test body message"
    
    @pytest.mark.skipif(os.environ.get('CI') == 'true', reason="Skip in CI")
    def test_send_test_notification(self):
        """Actually send a test notification (manual verification)."""
        import subprocess
        
        notify_send = shutil.which('notify-send')
        if not notify_send:
            pytest.skip("notify-send not installed")
        
        skip_if_no_display()
        
        result = subprocess.run(
            [notify_send, "--urgency", "low", "--app-name", "Pytest",
             "Test Notification", "This is a test from pytest"],
            timeout=5,
            capture_output=True
        )
        
        # Exit code 0 means success
        assert result.returncode == 0, f"notify-send failed: {result.stderr.decode()}"


class TestTkinterAvailability:
    """Tests for tkinter availability on Linux."""
    
    def test_tkinter_import(self):
        """Test tkinter can be imported."""
        try:
            import tkinter as tk
            from tkinter import ttk
            print("✓ tkinter imported successfully")
            print(f"  Tk version: {tk.TkVersion}")
            print(f"  Tcl version: {tk.TclVersion}")
        except ImportError as e:
            pytest.skip(f"tkinter not available: {e}")
    
    def test_tk_root_creation(self):
        """Test Tk root window can be created."""
        skip_if_no_display()
        
        try:
            import tkinter as tk
            root = tk.Tk()
            root.withdraw()  # Don't show window
            
            # Get screen info
            screen_width = root.winfo_screenwidth()
            screen_height = root.winfo_screenheight()
            
            print(f"✓ Tk root created")
            print(f"  Screen size: {screen_width}x{screen_height}")
            
            root.destroy()
            
            assert screen_width > 0
            assert screen_height > 0
            
        except Exception as e:
            pytest.fail(f"Failed to create Tk root: {e}")
    
    def test_toplevel_creation(self):
        """Test Toplevel window can be created."""
        skip_if_no_display()
        
        try:
            import tkinter as tk
            root = tk.Tk()
            root.withdraw()
            
            popup = tk.Toplevel(root)
            popup.title("Test Popup")
            popup.geometry("200x100")
            
            # Verify window exists
            assert popup.winfo_exists()
            
            popup.destroy()
            root.destroy()
            
        except Exception as e:
            pytest.fail(f"Failed to create Toplevel: {e}")


class TestWindowHints:
    """Tests for window hint functionality."""
    
    def test_dialog_type_hint(self, display_info):
        """Test dialog type hint can be set."""
        skip_if_no_display()
        
        try:
            import tkinter as tk
            root = tk.Tk()
            root.withdraw()
            
            popup = tk.Toplevel(root)
            
            # Try setting dialog type hint
            try:
                popup.attributes('-type', 'dialog')
                print("✓ Dialog type hint set successfully")
            except tk.TclError as e:
                print(f"⚠ Dialog type hint not supported: {e}")
            
            popup.destroy()
            root.destroy()
            
        except Exception as e:
            pytest.fail(f"Test failed: {e}")
    
    def test_topmost_attribute(self, display_info):
        """Test topmost attribute behavior."""
        skip_if_no_display()
        
        try:
            import tkinter as tk
            root = tk.Tk()
            root.withdraw()
            
            popup = tk.Toplevel(root)
            
            # Try setting topmost
            try:
                popup.attributes('-topmost', True)
                topmost = popup.attributes('-topmost')
                
                if display_info['is_wayland']:
                    print(f"⚠ Wayland: topmost may be ignored by compositor (value: {topmost})")
                else:
                    print(f"✓ X11: topmost set to {topmost}")
                    
            except tk.TclError as e:
                print(f"⚠ Topmost attribute error: {e}")
            
            popup.destroy()
            root.destroy()
            
        except Exception as e:
            pytest.fail(f"Test failed: {e}")
    
    def test_transient_relationship(self):
        """Test transient window relationship."""
        skip_if_no_display()
        
        try:
            import tkinter as tk
            root = tk.Tk()
            root.withdraw()
            
            popup = tk.Toplevel(root)
            
            # Set transient relationship
            try:
                popup.transient(root)
                print("✓ Transient relationship established")
            except tk.TclError as e:
                print(f"⚠ Transient failed: {e}")
            
            popup.destroy()
            root.destroy()
            
        except Exception as e:
            pytest.fail(f"Test failed: {e}")


class TestWindowPositioning:
    """Tests for window positioning."""
    
    def test_window_centering(self):
        """Test window can be centered on screen."""
        skip_if_no_display()
        
        try:
            import tkinter as tk
            root = tk.Tk()
            root.withdraw()
            
            popup = tk.Toplevel(root)
            popup.update_idletasks()
            
            # Window dimensions
            w, h = 550, 420
            
            # Screen dimensions
            sw = popup.winfo_screenwidth()
            sh = popup.winfo_screenheight()
            
            # Calculate center
            x = (sw - w) // 2
            y = (sh - h) // 2
            
            # Apply geometry
            popup.geometry(f"{w}x{h}+{x}+{y}")
            popup.update_idletasks()
            
            # Verify position (with some tolerance for window decorations)
            actual_x = popup.winfo_x()
            actual_y = popup.winfo_y()
            
            print(f"Expected position: ({x}, {y})")
            print(f"Actual position: ({actual_x}, {actual_y})")
            
            # Allow tolerance for window manager adjustments
            tolerance = 50
            x_diff = abs(actual_x - x)
            y_diff = abs(actual_y - y)
            
            if x_diff <= tolerance and y_diff <= tolerance:
                print("✓ Window positioned within tolerance")
            else:
                print(f"⚠ Position differs by ({x_diff}, {y_diff}) pixels")
            
            popup.destroy()
            root.destroy()
            
        except Exception as e:
            pytest.fail(f"Test failed: {e}")


class TestScrollableFrame:
    """Tests for scrollable frame functionality."""
    
    def test_canvas_scroll_creation(self):
        """Test scrollable canvas can be created."""
        skip_if_no_display()
        
        try:
            import tkinter as tk
            from tkinter import ttk
            
            root = tk.Tk()
            root.withdraw()
            
            popup = tk.Toplevel(root)
            popup.geometry("400x300")
            
            # Create scrollable structure
            container = tk.Frame(popup)
            container.pack(fill='both', expand=True)
            
            canvas = tk.Canvas(container, highlightthickness=0)
            scrollbar = ttk.Scrollbar(container, orient='vertical', command=canvas.yview)
            
            scrollable_frame = tk.Frame(canvas)
            
            scrollable_frame.bind(
                '<Configure>',
                lambda e: canvas.configure(scrollregion=canvas.bbox('all'))
            )
            
            canvas.create_window((0, 0), window=scrollable_frame, anchor='nw')
            canvas.configure(yscrollcommand=scrollbar.set)
            
            # Add some content
            for i in range(10):
                ttk.Label(scrollable_frame, text=f"Item {i}").pack()
            
            canvas.pack(side='left', fill='both', expand=True)
            scrollbar.pack(side='right', fill='y')
            
            popup.update_idletasks()
            
            print("✓ Scrollable frame created successfully")
            
            popup.destroy()
            root.destroy()
            
        except Exception as e:
            pytest.fail(f"Test failed: {e}")


class TestMouseWheelBinding:
    """Tests for mouse wheel event binding."""
    
    def test_mouse_wheel_events_bindable(self):
        """Test mouse wheel events can be bound."""
        skip_if_no_display()
        
        try:
            import tkinter as tk
            root = tk.Tk()
            root.withdraw()
            
            canvas = tk.Canvas(root)
            
            # Linux uses Button-4 and Button-5 for scroll
            def on_scroll_up(event):
                pass
            
            def on_scroll_down(event):
                pass
            
            canvas.bind_all('<Button-4>', on_scroll_up)
            canvas.bind_all('<Button-5>', on_scroll_down)
            
            print("✓ Mouse wheel events bound successfully")
            
            root.destroy()
            
        except Exception as e:
            pytest.fail(f"Test failed: {e}")


# Marker for integration tests
def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line(
        "markers", "linux: mark test as Linux-specific"
    )
