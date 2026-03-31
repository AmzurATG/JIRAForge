"""
macOS Auto-Updater Module for TimeTracker
Handles automatic updates for the TimeTracker macOS app with AI Server integration
Compatible with macOS Tahoe 26.3+ and follows Apple's guidelines
"""
import os
import sys
import json
import requests
import subprocess
import tempfile
import hashlib
import zipfile
import shutil
from pathlib import Path
from datetime import datetime
import time

# For macOS-specific functionality
try:
    import Cocoa
    import Foundation
    COCOA_AVAILABLE = True
except ImportError:
    COCOA_AVAILABLE = False
    print("[WARN] Cocoa/Foundation not available - limited macOS integration")

class MacAppAutoUpdater:
    def __init__(self, current_version, ai_server_url=None, app_path=None):
        self.current_version = current_version
        self.ai_server_url = ai_server_url or 'https://forgesync.amzur.com'
        self.app_path = app_path or self._get_app_path()
        self.temp_dir = tempfile.mkdtemp(prefix='timetracker_update_')
        
    def _get_app_path(self):
        """Get the path to the current app bundle"""
        if getattr(sys, 'frozen', False):
            # Running from PyInstaller bundle
            bundle_dir = sys._MEIPASS
            app_path = Path(bundle_dir).parent.parent.parent
            if app_path.suffix == '.app':
                return str(app_path)
        return None
        
    def check_for_updates(self):
        """
        Check the AI server for available updates.
        Returns update info dict or None if no updates available.
        """
        try:
            update_url = f"{self.ai_server_url}/api/updates/check"
            params = {
                'platform': 'macos',
                'current_version': self.current_version,
            }
            
            response = requests.get(update_url, params=params, timeout=10)
            
            if response.status_code == 200:
                update_info = response.json()
                
                if update_info.get('update_available', False):
                    print(f"[INFO] Update available: v{update_info.get('latest_version')}")
                    return update_info
                else:
                    print(f"[INFO] No updates available (current: v{self.current_version})")
                    return None
                    
            elif response.status_code == 204:
                # No content = no updates available
                return None
            else:
                print(f"[WARN] Update check failed with status {response.status_code}")
                return None
                
        except requests.exceptions.Timeout:
            print(f"[WARN] Update check timed out")
            return None
        except requests.exceptions.RequestException as e:
            print(f"[WARN] Update check failed: {e}")
            return None
        except Exception as e:
            print(f"[ERROR] Unexpected error during update check: {e}")
            return None
            
    def download_update(self, update_info):
        """
        Download the update file from the provided update info.
        Returns path to downloaded file or None on failure.
        """
        if not update_info or 'download_url' not in update_info:
            print("[ERROR] Invalid update info provided")
            return None
            
        download_url = update_info['download_url']
        expected_checksum = update_info.get('checksum')
        
        try:
            print(f"[INFO] Downloading update from: {download_url}")
            
            # Determine file extension from URL or content type
            file_extension = '.dmg'  # Default for macOS
            if download_url.endswith('.zip'):
                file_extension = '.zip'
            elif download_url.endswith('.app.tar.gz'):
                file_extension = '.app.tar.gz'
                
            temp_file = os.path.join(self.temp_dir, f'TimeTracker_update{file_extension}')
            
            response = requests.get(download_url, stream=True, timeout=30)
            response.raise_for_status()
            
            total_size = int(response.headers.get('content-length', 0))
            downloaded = 0
            
            with open(temp_file, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        
                        # Show progress for large downloads
                        if total_size > 0:
                            progress = (downloaded / total_size) * 100
                            if downloaded % (1024 * 1024) == 0:  # Every MB
                                print(f"[INFO] Download progress: {progress:.1f}%")
            
            print(f"[INFO] Download completed: {temp_file}")
            
            # Verify checksum if provided
            if expected_checksum:
                if self.verify_checksum(temp_file, expected_checksum):
                    print("[INFO] Checksum verification passed")
                else:
                    print("[ERROR] Checksum verification failed")
                    os.unlink(temp_file)
                    return None
            else:
                print("[WARN] No checksum provided - skipping verification")
                
            return temp_file
            
        except requests.exceptions.Timeout:
            print(f"[ERROR] Download timed out")
            return None
        except requests.exceptions.RequestException as e:
            print(f"[ERROR] Download failed: {e}")
            return None
        except Exception as e:
            print(f"[ERROR] Unexpected error during download: {e}")
            return None
            
    def verify_checksum(self, file_path, expected_checksum):
        """Verify SHA256 checksum of downloaded file"""
        if not expected_checksum or not os.path.exists(file_path):
            return False
            
        try:
            sha256_hash = hashlib.sha256()
            with open(file_path, "rb") as f:
                for byte_block in iter(lambda: f.read(65536), b""):
                    sha256_hash.update(byte_block)
                    
            actual_checksum = sha256_hash.hexdigest()
            return actual_checksum.lower() == expected_checksum.lower()
            
        except Exception as e:
            print(f"[ERROR] Checksum verification failed: {e}")
            return False
            
    def install_update(self, downloaded_file, update_info):
        """
        Install the downloaded update.
        This will replace the current app and restart it.
        """
        if not downloaded_file or not os.path.exists(downloaded_file):
            print("[ERROR] No valid update file to install")
            return False
            
        if not self.app_path:
            print("[ERROR] Cannot determine current app path")
            return False
            
        try:
            print(f"[INFO] Installing update from: {downloaded_file}")
            
            # Handle different file types
            if downloaded_file.endswith('.dmg'):
                return self._install_from_dmg(downloaded_file, update_info)
            elif downloaded_file.endswith('.zip'):
                return self._install_from_zip(downloaded_file, update_info)
            elif downloaded_file.endswith('.app.tar.gz'):
                return self._install_from_targz(downloaded_file, update_info)
            else:
                print(f"[ERROR] Unsupported update file format: {downloaded_file}")
                return False
                
        except Exception as e:
            print(f"[ERROR] Update installation failed: {e}")
            return False
            
    def _install_from_dmg(self, dmg_path, update_info):
        """Install update from DMG file"""
        try:
            # Mount the DMG
            mount_result = subprocess.run([
                'hdiutil', 'attach', dmg_path, '-nobrowse', '-quiet'
            ], capture_output=True, text=True)
            
            if mount_result.returncode != 0:
                print(f"[ERROR] Failed to mount DMG: {mount_result.stderr}")
                return False
                
            # Find the mount point
            mount_point = None
            for line in mount_result.stdout.split('\n'):
                if '/Volumes/' in line:
                    mount_point = line.split('\t')[-1].strip()
                    break
                    
            if not mount_point:
                print("[ERROR] Could not find DMG mount point")
                return False
                
            print(f"[INFO] DMG mounted at: {mount_point}")
            
            # Find the .app in the DMG
            app_in_dmg = None
            for item in os.listdir(mount_point):
                if item.endswith('.app'):
                    app_in_dmg = os.path.join(mount_point, item)
                    break
                    
            if not app_in_dmg:
                print("[ERROR] No .app found in DMG")
                return False
                
            # Copy the new app to Applications (or replace current app)
            success = self._replace_app(app_in_dmg)
            
            # Unmount the DMG
            subprocess.run(['hdiutil', 'detach', mount_point, '-quiet'])
            
            return success
            
        except Exception as e:
            print(f"[ERROR] DMG installation failed: {e}")
            return False
            
    def _install_from_zip(self, zip_path, update_info):
        """Install update from ZIP file"""
        try:
            extract_dir = os.path.join(self.temp_dir, 'extracted')
            os.makedirs(extract_dir, exist_ok=True)
            
            # Extract ZIP
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(extract_dir)
                
            # Find the .app in extracted files
            app_in_zip = None
            for root, dirs, files in os.walk(extract_dir):
                for dir_name in dirs:
                    if dir_name.endswith('.app'):
                        app_in_zip = os.path.join(root, dir_name)
                        break
                if app_in_zip:
                    break
                    
            if not app_in_zip:
                print("[ERROR] No .app found in ZIP")
                return False
                
            return self._replace_app(app_in_zip)
            
        except Exception as e:  
            print(f"[ERROR] ZIP installation failed: {e}")
            return False
            
    def _install_from_targz(self, targz_path, update_info):
        """Install update from .app.tar.gz file"""
        try:
            extract_dir = os.path.join(self.temp_dir, 'extracted')
            os.makedirs(extract_dir, exist_ok=True)
            
            # Extract tar.gz
            subprocess.run(['tar', '-xzf', targz_path, '-C', extract_dir], check=True)
            
            # Find the .app in extracted files  
            app_in_tar = None
            for root, dirs, files in os.walk(extract_dir):
                for dir_name in dirs:
                    if dir_name.endswith('.app'):
                        app_in_tar = os.path.join(root, dir_name)
                        break
                if app_in_tar:
                    break
                    
            if not app_in_tar:
                print("[ERROR] No .app found in tar.gz")
                return False
                
            return self._replace_app(app_in_tar)
            
        except Exception as e:
            print(f"[ERROR] tar.gz installation failed: {e}")
            return False
            
    def _replace_app(self, new_app_path):
        """Replace the current app with the new one"""
        try:
            if not os.path.exists(new_app_path):
                print(f"[ERROR] New app not found: {new_app_path}")
                return False
                
            print(f"[INFO] Replacing app: {self.app_path}")
            
            # Make a backup of current app
            backup_path = f"{self.app_path}.backup.{int(time.time())}"
            shutil.move(self.app_path, backup_path)
            print(f"[INFO] Created backup: {backup_path}")
            
            # Copy new app to the original location
            shutil.copytree(new_app_path, self.app_path)
            print(f"[INFO] New app installed successfully")
            
            # Set proper permissions
            subprocess.run(['chmod', '+x', f'{self.app_path}/Contents/MacOS/TimeTracker'])
            
            return True
            
        except Exception as e:
            print(f"[ERROR] App replacement failed: {e}")
            return False
            
    def restart_app(self):
        """Restart the application after update"""
        try:
            if not self.app_path:
                print("[ERROR] Cannot restart - app path unknown")
                return False
                
            print("[INFO] Restarting application...")
            
            # Use 'open' command to launch the app  
            subprocess.Popen(['open', self.app_path])
            
            # Give the new app time to start before we exit
            time.sleep(2)
            
            return True
            
        except Exception as e:
            print(f"[ERROR] App restart failed: {e}")
            return False
            
    def cleanup(self):
        """Clean up temporary files"""
        try:
            if os.path.exists(self.temp_dir):
                shutil.rmtree(self.temp_dir)
                print(f"[INFO] Cleaned up temp directory: {self.temp_dir}")
        except Exception as e:
            print(f"[WARN] Cleanup failed: {e}")
            
    def show_update_notification(self, update_info):
        """Show native macOS notification about available update"""
        try:
            if not COCOA_AVAILABLE:
                print(f"[INFO] Update available: v{update_info.get('latest_version', 'unknown')}")
                return
                
            # Use NSUserNotification for macOS notifications
            notification = Cocoa.NSUserNotification.alloc().init()
            notification.setTitle_("TimeTracker Update Available")
            notification.setInformativeText_(f"Version {update_info.get('latest_version')} is ready to install")
            notification.setSoundName_("NSUserNotificationDefaultSoundName")
            notification.setHasActionButton_(True)
            notification.setActionButtonTitle_("Install Now")
            
            center = Cocoa.NSUserNotificationCenter.defaultUserNotificationCenter()
            center.deliverNotification_(notification)
            
        except Exception as e:
            print(f"[ERROR] Failed to show notification: {e}")

def check_and_handle_updates(current_version, ai_server_url=None, auto_install=False):
    """
    Convenience function to check for updates and optionally auto-install
    """
    updater = MacAppAutoUpdater(current_version, ai_server_url)
    
    try:
        # Check for updates
        update_info = updater.check_for_updates()
        
        if not update_info:
            return None  # No updates available
            
        # Show notification
        updater.show_update_notification(update_info)
        
        if auto_install:
            # Download update
            downloaded_file = updater.download_update(update_info)
            
            if downloaded_file:
                # Install update
                if updater.install_update(downloaded_file, update_info):
                    # Restart app
                    updater.restart_app()
                    return True
                    
        return update_info
        
    finally:
        updater.cleanup()

def initialize_auto_updater():
    """Initialize the auto-updater system"""
    print("[INFO] macOS auto-updater initialized")
    return True