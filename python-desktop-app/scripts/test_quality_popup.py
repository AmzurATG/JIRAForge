#!/usr/bin/env python3
"""
Manual test script for Description Quality Popup.

This script allows manual testing of the DescriptionQualityPopup functionality
on Linux systems, including both X11 and Wayland.

Usage:
    python scripts/test_quality_popup.py [OPTIONS]

Options:
    --wayland       Force Wayland mode (set WAYLAND_DISPLAY env var)
    --x11           Force X11 mode (unset Wayland env vars)
    --minimal       Show popup with minimal UI (for debugging)
    --single        Show popup with single nudge
    --many          Show popup with many nudges (test scrolling)
    --no-destroy    Don't auto-destroy popup (for visual inspection)

Examples:
    # Test on current display server
    python scripts/test_quality_popup.py
    
    # Force Wayland mode
    python scripts/test_quality_popup.py --wayland
    
    # Force X11 mode
    python scripts/test_quality_popup.py --x11
    
    # Test with single nudge
    python scripts/test_quality_popup.py --single

Requirements:
    - Python 3.8+
    - tkinter (python3-tk package on Debian/Ubuntu)
    - A display server (X11 or Wayland)
"""

import sys
import os
import argparse
import time

# Ensure we can import from parent directory
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description='Test Description Quality Popup on Linux',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument(
        '--wayland', 
        action='store_true', 
        help='Force Wayland mode'
    )
    parser.add_argument(
        '--x11', 
        action='store_true', 
        help='Force X11 mode'
    )
    parser.add_argument(
        '--minimal', 
        action='store_true', 
        help='Minimal UI mode for debugging'
    )
    parser.add_argument(
        '--single', 
        action='store_true', 
        help='Show popup with single nudge'
    )
    parser.add_argument(
        '--many', 
        action='store_true', 
        help='Show popup with many nudges (10+)'
    )
    parser.add_argument(
        '--no-destroy', 
        action='store_true', 
        help="Don't auto-destroy popup"
    )
    parser.add_argument(
        '--timeout', 
        type=int, 
        default=0,
        help='Auto-close popup after N seconds (0 = manual close)'
    )
    return parser.parse_args()


def setup_environment(args):
    """Configure environment based on arguments."""
    if args.wayland and args.x11:
        print("Error: Cannot specify both --wayland and --x11")
        sys.exit(1)
    
    if args.wayland:
        os.environ['WAYLAND_DISPLAY'] = 'wayland-test'
        os.environ['XDG_SESSION_TYPE'] = 'wayland'
        print("🔧 Forcing Wayland mode")
    elif args.x11:
        os.environ.pop('WAYLAND_DISPLAY', None)
        os.environ['XDG_SESSION_TYPE'] = 'x11'
        os.environ.setdefault('DISPLAY', ':0')
        print("🔧 Forcing X11 mode")


def print_environment_info():
    """Print current environment information."""
    print(f"\n{'='*50}")
    print("ENVIRONMENT INFORMATION")
    print('='*50)
    print(f"Platform:           {sys.platform}")
    print(f"Python:             {sys.version.split()[0]}")
    print(f"DISPLAY:            {os.environ.get('DISPLAY', 'not set')}")
    print(f"WAYLAND_DISPLAY:    {os.environ.get('WAYLAND_DISPLAY', 'not set')}")
    print(f"XDG_SESSION_TYPE:   {os.environ.get('XDG_SESSION_TYPE', 'not set')}")
    print(f"XDG_CURRENT_DESKTOP:{os.environ.get('XDG_CURRENT_DESKTOP', 'not set')}")
    
    # Determine display server
    if os.environ.get('WAYLAND_DISPLAY'):
        display_server = "Wayland"
    elif os.environ.get('DISPLAY'):
        display_server = "X11"
    else:
        display_server = "Unknown"
    print(f"Display Server:     {display_server}")
    print()


def check_dependencies():
    """Check required dependencies are available."""
    print(f"{'='*50}")
    print("DEPENDENCY CHECK")
    print('='*50)
    
    # Check tkinter
    try:
        import tkinter as tk
        from tkinter import ttk
        print(f"✓ tkinter available (Tk {tk.TkVersion}, Tcl {tk.TclVersion})")
    except ImportError as e:
        print(f"✗ tkinter not available: {e}")
        print("  Install with: sudo apt install python3-tk")
        sys.exit(1)
    
    # Check webbrowser
    try:
        import webbrowser
        print("✓ webbrowser module available")
    except ImportError:
        print("✗ webbrowser not available")
    
    # Check for display
    if not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
        print("✗ No display available (set DISPLAY or WAYLAND_DISPLAY)")
        sys.exit(1)
    else:
        print("✓ Display available")
    
    print()


def create_sample_nudges(count='default'):
    """Create sample nudge data for testing."""
    base_nudges = [
        {
            'id': 'nudge-1',
            'issueKey': 'PROJ-123',
            'issueUrl': 'https://example.atlassian.net/browse/PROJ-123',
            'appUrl': 'https://example.atlassian.net/jira/software/projects/PROJ/boards/1',
            'score': 25,
            'summary': 'This is a ticket with a very poor description that needs significant improvement'
        },
        {
            'id': 'nudge-2',
            'issueKey': 'PROJ-456',
            'issueUrl': 'https://example.atlassian.net/browse/PROJ-456',
            'appUrl': 'https://example.atlassian.net/jira/software/projects/PROJ/boards/1',
            'score': 55,
            'summary': 'Medium quality ticket - could use some clarification'
        },
        {
            'id': 'nudge-3',
            'issueKey': 'PROJ-789',
            'issueUrl': 'https://example.atlassian.net/browse/PROJ-789',
            'appUrl': 'https://example.atlassian.net/jira/software/projects/PROJ/boards/1',
            'score': 70,
            'summary': 'Borderline ticket - minor improvements needed'
        },
        {
            'id': 'nudge-4',
            'issueKey': 'PROJ-101',
            'issueUrl': 'https://example.atlassian.net/browse/PROJ-101',
            'appUrl': 'https://example.atlassian.net/jira/software/projects/PROJ/boards/1',
            'score': 35,
            'summary': 'Another low quality ticket for testing scrolling behavior'
        },
        {
            'id': 'nudge-5',
            'issueKey': 'PROJ-202',
            'issueUrl': 'https://example.atlassian.net/browse/PROJ-202',
            'appUrl': 'https://example.atlassian.net/jira/software/projects/PROJ/boards/1',
            'score': 42,
            'summary': 'Fifth ticket to test the max nudges limit'
        }
    ]
    
    if count == 'single':
        return [base_nudges[0]]
    elif count == 'many':
        # Create 15 nudges for scroll testing
        many_nudges = []
        for i in range(15):
            many_nudges.append({
                'id': f'nudge-{i+1}',
                'issueKey': f'PROJ-{100+i}',
                'issueUrl': f'https://example.atlassian.net/browse/PROJ-{100+i}',
                'appUrl': 'https://example.atlassian.net/jira/software/projects/PROJ/boards/1',
                'score': 20 + (i * 4),
                'summary': f'Test ticket {i+1} - This is a sample description for scrolling test'
            })
        return many_nudges
    else:
        return base_nudges


def create_mock_popup_class():
    """Create a mock DescriptionQualityPopup class for testing."""
    import tkinter as tk
    from tkinter import ttk
    
    class MockDescriptionQualityPopup:
        """Mock popup for testing when real class is not available."""
        
        WINDOW_WIDTH = 550
        WINDOW_HEIGHT = 420
        BG_COLOR = '#2D2D2D'
        FG_COLOR = '#E0E0E0'
        ACCENT_COLOR = '#4A9EFF'
        WARNING_COLOR = '#FFA500'
        DANGER_COLOR = '#FF5252'
        SUCCESS_COLOR = '#4CAF50'
        
        def __init__(self, parent, nudges, user_name, on_improve, on_snooze, on_dismiss, on_close=None):
            self.parent = parent
            self.nudges = nudges
            self.user_name = user_name
            self.on_improve = on_improve
            self.on_snooze = on_snooze
            self.on_dismiss = on_dismiss
            self.on_close = on_close
            self._is_destroyed = False
            
            self._create_popup()
        
        def _is_wayland(self):
            return bool(
                os.environ.get('WAYLAND_DISPLAY') or
                os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
            )
        
        def _create_popup(self):
            self.popup = tk.Toplevel(self.parent)
            self.popup.title("Time Tracker — Improve Ticket Quality")
            self.popup.configure(bg=self.BG_COLOR)
            self.popup.resizable(False, False)
            
            # Center window
            self.popup.update_idletasks()
            sw = self.popup.winfo_screenwidth()
            sh = self.popup.winfo_screenheight()
            x = (sw - self.WINDOW_WIDTH) // 2
            y = (sh - self.WINDOW_HEIGHT) // 2
            self.popup.geometry(f"{self.WINDOW_WIDTH}x{self.WINDOW_HEIGHT}+{x}+{y}")
            
            # Platform-specific hints
            if self._is_wayland():
                try:
                    self.popup.attributes('-type', 'dialog')
                except tk.TclError:
                    pass
            else:
                try:
                    self.popup.attributes('-topmost', True)
                except tk.TclError:
                    pass
            
            try:
                self.popup.transient(self.parent)
            except tk.TclError:
                pass
            
            self.popup.lift()
            self.popup.focus_set()
            
            self.popup.protocol("WM_DELETE_WINDOW", self._on_close)
            
            self._create_ui()
        
        def _get_score_color(self, score):
            if score >= 80:
                return self.SUCCESS_COLOR
            elif score >= 50:
                return self.WARNING_COLOR
            else:
                return self.DANGER_COLOR
        
        def _create_ui(self):
            # Header
            header = tk.Frame(self.popup, bg=self.BG_COLOR, padx=10, pady=10)
            header.pack(fill='x')
            
            greeting = f"Hi {self.user_name}," if self.user_name else "Hi there,"
            tk.Label(
                header, text=greeting,
                font=('Helvetica', 14, 'bold'),
                bg=self.BG_COLOR, fg=self.FG_COLOR
            ).pack(anchor='w')
            
            count = len(self.nudges)
            tk.Label(
                header,
                text=f"You have {count} ticket{'s' if count != 1 else ''} that could use clearer descriptions:",
                font=('Helvetica', 11),
                bg=self.BG_COLOR, fg='#AAAAAA',
                wraplength=self.WINDOW_WIDTH - 20
            ).pack(anchor='w', pady=(5, 0))
            
            # List area
            list_container = tk.Frame(self.popup, bg=self.BG_COLOR, padx=10)
            list_container.pack(fill='both', expand=True)
            
            canvas = tk.Canvas(list_container, bg=self.BG_COLOR, highlightthickness=0)
            scrollbar = ttk.Scrollbar(list_container, orient='vertical', command=canvas.yview)
            
            scrollable = tk.Frame(canvas, bg=self.BG_COLOR)
            scrollable.bind('<Configure>', lambda e: canvas.configure(scrollregion=canvas.bbox('all')))
            
            canvas.create_window((0, 0), window=scrollable, anchor='nw', width=self.WINDOW_WIDTH - 40)
            canvas.configure(yscrollcommand=scrollbar.set)
            
            # Mouse wheel
            def scroll_up(e):
                canvas.yview_scroll(-1, 'units')
            def scroll_down(e):
                canvas.yview_scroll(1, 'units')
            canvas.bind_all('<Button-4>', scroll_up)
            canvas.bind_all('<Button-5>', scroll_down)
            
            for i, nudge in enumerate(self.nudges):
                row_bg = '#363636' if i % 2 == 0 else self.BG_COLOR
                row = tk.Frame(scrollable, bg=row_bg, padx=8, pady=8)
                row.pack(fill='x', pady=(0, 2))
                
                info = tk.Frame(row, bg=row_bg)
                info.pack(side='left', fill='x', expand=True)
                
                key_frame = tk.Frame(info, bg=row_bg)
                key_frame.pack(anchor='w')
                
                tk.Label(
                    key_frame, text=nudge.get('issueKey', 'Unknown'),
                    font=('Helvetica', 11, 'bold'),
                    bg=row_bg, fg=self.ACCENT_COLOR, cursor='hand2'
                ).pack(side='left')
                
                score = nudge.get('score', 0)
                tk.Label(
                    key_frame, text=f" (Score: {score})",
                    font=('Helvetica', 10),
                    bg=row_bg, fg=self._get_score_color(score)
                ).pack(side='left')
                
                summary = nudge.get('summary', 'No summary')[:57]
                if len(nudge.get('summary', '')) > 57:
                    summary += '...'
                tk.Label(
                    info, text=summary,
                    font=('Helvetica', 10),
                    bg=row_bg, fg='#CCCCCC', anchor='w'
                ).pack(anchor='w')
                
                actions = tk.Frame(row, bg=row_bg)
                actions.pack(side='right')
                
                tk.Button(
                    actions, text="✨ Improve",
                    font=('Helvetica', 9),
                    bg=self.SUCCESS_COLOR, fg='white',
                    relief='flat', padx=8, pady=2,
                    command=lambda n=nudge: self._handle_improve(n)
                ).pack(side='left', padx=(0, 5))
                
                tk.Button(
                    actions, text="✕",
                    font=('Helvetica', 9),
                    bg='#444444', fg='#AAAAAA',
                    relief='flat', padx=6, pady=2,
                    command=lambda n=nudge: self._handle_dismiss(n)
                ).pack(side='left')
            
            canvas.pack(side='left', fill='both', expand=True)
            if len(self.nudges) > 3:
                scrollbar.pack(side='right', fill='y')
            
            # Footer
            footer = tk.Frame(self.popup, bg=self.BG_COLOR, padx=10, pady=10)
            footer.pack(fill='x')
            
            tk.Frame(footer, bg='#444444', height=1).pack(fill='x', pady=(0, 10))
            
            btn_container = tk.Frame(footer, bg=self.BG_COLOR)
            btn_container.pack(fill='x')
            
            tk.Button(
                btn_container, text="📊 Open My Focus",
                font=('Helvetica', 10),
                bg=self.ACCENT_COLOR, fg='white',
                relief='flat', padx=12, pady=5,
                command=self._open_my_focus
            ).pack(side='left')
            
            tk.Button(
                btn_container, text="Dismiss All",
                font=('Helvetica', 10),
                bg='#555555', fg='white',
                relief='flat', padx=12, pady=5,
                command=self._dismiss_all
            ).pack(side='right')
        
        def _handle_improve(self, nudge):
            print(f"  → IMPROVE: {nudge['issueKey']}")
            if self.on_improve:
                self.on_improve(nudge)
        
        def _handle_dismiss(self, nudge):
            print(f"  → DISMISS: {nudge['issueKey']}")
            if self.on_dismiss:
                self.on_dismiss(nudge)
        
        def _open_my_focus(self):
            print("  → OPEN MY FOCUS clicked")
        
        def _dismiss_all(self):
            print("  → DISMISS ALL clicked")
            self._on_close()
        
        def _on_close(self):
            if self._is_destroyed:
                return
            self._is_destroyed = True
            print("  → Popup CLOSED")
            if self.on_close:
                self.on_close()
            try:
                self.popup.destroy()
            except:
                pass
        
        def destroy(self):
            self._on_close()
    
    return MockDescriptionQualityPopup


def main():
    """Main function."""
    args = parse_args()
    setup_environment(args)
    print_environment_info()
    check_dependencies()
    
    import tkinter as tk
    
    # Try to import the real class, fall back to mock
    try:
        from desktop_app import DescriptionQualityPopup
        print("✓ Using real DescriptionQualityPopup class")
        PopupClass = DescriptionQualityPopup
    except (ImportError, AttributeError) as e:
        print(f"⚠ Real class not available ({e}), using mock")
        PopupClass = create_mock_popup_class()
    
    # Determine nudge count
    if args.single:
        nudge_count = 'single'
    elif args.many:
        nudge_count = 'many'
    else:
        nudge_count = 'default'
    
    nudges = create_sample_nudges(nudge_count)
    print(f"\n✓ Created {len(nudges)} sample nudges")
    
    # Callbacks
    def on_improve(nudge):
        print(f"  CALLBACK: on_improve({nudge['issueKey']})")
    
    def on_snooze(nudge, hours):
        print(f"  CALLBACK: on_snooze({nudge['issueKey']}, {hours}h)")
    
    def on_dismiss(nudge):
        print(f"  CALLBACK: on_dismiss({nudge['issueKey']})")
    
    def on_close():
        print("  CALLBACK: on_close()")
        root.quit()
    
    # Create root window
    root = tk.Tk()
    root.withdraw()
    print("✓ Root window created")
    
    # Create popup
    print(f"\n{'='*50}")
    print("CREATING POPUP")
    print('='*50)
    
    try:
        popup = PopupClass(
            parent=root,
            nudges=nudges,
            user_name='Test User',
            on_improve=on_improve,
            on_snooze=on_snooze,
            on_dismiss=on_dismiss,
            on_close=on_close
        )
        print("✓ Popup created successfully")
        
        # Print window info
        popup.popup.update_idletasks()
        print(f"\n{'='*50}")
        print("WINDOW INFO")
        print('='*50)
        print(f"Size:     {popup.popup.winfo_width()}x{popup.popup.winfo_height()}")
        print(f"Position: ({popup.popup.winfo_x()}, {popup.popup.winfo_y()})")
        print(f"Screen:   {popup.popup.winfo_screenwidth()}x{popup.popup.winfo_screenheight()}")
        print(f"Wayland:  {popup._is_wayland()}")
        
    except Exception as e:
        print(f"✗ Failed to create popup: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    
    # Auto-timeout
    if args.timeout > 0:
        print(f"\n⏱ Auto-closing in {args.timeout} seconds...")
        root.after(args.timeout * 1000, lambda: popup.destroy())
    
    print(f"\n{'='*50}")
    print("RUNNING")
    print('='*50)
    print("Close the popup window to exit, or Ctrl+C to interrupt.\n")
    
    try:
        root.mainloop()
    except KeyboardInterrupt:
        print("\n\nInterrupted by user")
    finally:
        try:
            root.destroy()
        except:
            pass
    
    print(f"\n{'='*50}")
    print("TEST COMPLETE")
    print('='*50)


if __name__ == '__main__':
    main()
