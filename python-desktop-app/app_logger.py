"""
Application Logger for TimeTracker Desktop App

Provides comprehensive logging with:
- Rotating file handlers to prevent disk space issues
- PII redaction for security compliance
- Structured logging with correlation IDs
- Automatic stdout/stderr redirection
- Performance metrics
- Component-based categorization

Usage:
    from app_logger import setup_logging, get_logger
    
    # In main():
    setup_logging()
    
    # In any module:
    logger = get_logger(__name__)
    logger.info("Application started")
    logger.error("Error occurred", exc_info=True)
"""

import os
import sys
import time
import logging
import threading
from logging.handlers import RotatingFileHandler
from datetime import datetime
from typing import Optional, Dict, Any
import re

# Import PII redaction from existing secure_logger
try:
    from secure_logger import SANITIZATION_PATTERNS, _should_apply_pattern, SECURE_LOG_LEVEL
    SECURE_LOGGER_AVAILABLE = True
except ImportError:
    SECURE_LOGGER_AVAILABLE = False
    SANITIZATION_PATTERNS = []
    SECURE_LOG_LEVEL = 'standard'


class PIIRedactingFormatter(logging.Formatter):
    """
    Custom formatter that redacts PII from log messages
    """
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.patterns = SANITIZATION_PATTERNS if SECURE_LOGGER_AVAILABLE else []
    
    def format(self, record):
        # Format the record normally first
        message = super().format(record)
        
        # Apply PII redaction
        if self.patterns:
            for pattern_config in self.patterns:
                if _should_apply_pattern(pattern_config, SECURE_LOG_LEVEL):
                    pattern = pattern_config['pattern']
                    replacement = pattern_config['replacement']
                    message = pattern.sub(replacement, message)
        
        return message


class ComponentAdapter(logging.LoggerAdapter):
    """
    Adapter that adds component prefix to log messages
    """
    
    def __init__(self, logger, component):
        super().__init__(logger, {})
        self.component = component
    
    def process(self, msg, kwargs):
        return f"[{self.component}] {msg}", kwargs


class AppLogger:
    """
    Main application logger with rotating file handler and PII redaction
    """
    
    def __init__(self, app_name="TimeTracker"):
        self.app_name = app_name
        self.log_dir = None
        self.log_file = None
        self.start_time = time.time()
        self._setup_complete = False
        
    def setup_logging(self, log_level=logging.INFO):
        """
        Setup logging infrastructure
        
        Args:
            log_level: Logging level (default: INFO)
        """
        if self._setup_complete:
            return
        
        # Determine log directory
        self.log_dir = self._get_log_directory()
        
        # Ensure log directory exists
        os.makedirs(self.log_dir, exist_ok=True)
        
        # Setup log file path
        self.log_file = os.path.join(self.log_dir, 'timetracker.log')
        
        # Create rotating file handler
        # 10MB per file, keep 5 backups = 50MB total
        file_handler = RotatingFileHandler(
            self.log_file,
            maxBytes=10 * 1024 * 1024,  # 10MB
            backupCount=5,
            encoding='utf-8'
        )
        
        # Create formatter with PII redaction
        formatter = PIIRedactingFormatter(
            '%(asctime)s - %(levelname)s - %(name)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        file_handler.setFormatter(formatter)
        
        # Configure root logger
        root_logger = logging.getLogger()
        root_logger.setLevel(log_level)
        root_logger.addHandler(file_handler)
        
        # Redirect stdout and stderr to logger
        sys.stdout = StreamToLogger(logging.getLogger('STDOUT'), logging.INFO)
        sys.stderr = StreamToLogger(logging.getLogger('STDERR'), logging.ERROR)
        
        self._setup_complete = True
        
        # Log setup completion
        logger = logging.getLogger(__name__)
        logger.info("=" * 70)
        logger.info(f"{self.app_name} Logging System Initialized")
        logger.info(f"Log file: {self.log_file}")
        logger.info(f"Log level: {logging.getLevelName(log_level)}")
        logger.info(f"PII redaction: {'ENABLED' if SECURE_LOGGER_AVAILABLE else 'DISABLED'}")
        logger.info(f"Max log size: 10MB x 5 files = 50MB total")
        logger.info("=" * 70)
    
    def _get_log_directory(self):
        """
        Get the log directory path
        
        Returns:
            str: Path to log directory
        """
        # Get app data directory
        if sys.platform == 'win32':
            app_data = os.environ.get('LOCALAPPDATA', os.path.expanduser('~'))
        else:
            app_data = os.path.expanduser('~/.local/share')
        
        app_dir = os.path.join(app_data, self.app_name)
        log_dir = os.path.join(app_dir, 'logs')
        
        return log_dir
    
    def get_log_file_path(self):
        """Get the current log file path"""
        return self.log_file
    
    def get_log_stats(self):
        """
        Get log file statistics
        
        Returns:
            dict: Log statistics
        """
        if not self.log_file or not os.path.exists(self.log_file):
            return {
                'exists': False,
                'size_mb': 0,
                'line_count': 0,
            }
        
        size_bytes = os.path.getsize(self.log_file)
        size_mb = size_bytes / (1024 * 1024)
        
        # Count lines
        try:
            with open(self.log_file, 'r', encoding='utf-8') as f:
                line_count = sum(1 for _ in f)
        except:
            line_count = 0
        
        return {
            'exists': True,
            'path': self.log_file,
            'size_bytes': size_bytes,
            'size_mb': round(size_mb, 2),
            'line_count': line_count,
        }


class StreamToLogger:
    """
    Redirect stdout/stderr to logger
    """
    
    def __init__(self, logger, level):
        self.logger = logger
        self.level = level
        self.linebuf = ''
    
    def write(self, buf):
        """Write buffer to logger"""
        for line in buf.rstrip().splitlines():
            # Skip empty lines
            if line.strip():
                self.logger.log(self.level, line.rstrip())
    
    def flush(self):
        """Flush buffer (no-op for logger)"""
        pass


# Global logger instance
_app_logger = None
_setup_lock = threading.Lock()


def setup_logging(log_level=logging.INFO):
    """
    Setup application logging (call once at startup)
    
    Args:
        log_level: Logging level (default: INFO)
    """
    global _app_logger
    
    with _setup_lock:
        if _app_logger is None:
            _app_logger = AppLogger()
            _app_logger.setup_logging(log_level)
    
    return _app_logger


def get_logger(name, component=None):
    """
    Get a logger instance
    
    Args:
        name: Logger name (usually __name__)
        component: Optional component name for categorization
                  (e.g., 'AUTH', 'TRACKING', 'OCR', 'NETWORK')
    
    Returns:
        logging.Logger or ComponentAdapter
    """
    logger = logging.getLogger(name)
    
    if component:
        return ComponentAdapter(logger, component)
    
    return logger


def get_log_file_path():
    """Get the current log file path"""
    if _app_logger:
        return _app_logger.get_log_file_path()
    return None


def get_log_stats():
    """Get log file statistics"""
    if _app_logger:
        return _app_logger.get_log_stats()
    return {'exists': False}


# Convenience functions for specific logging scenarios

def log_auth_event(event_type, details=None, level=logging.INFO):
    """
    Log authentication-related events
    
    Args:
        event_type: Type of auth event (e.g., 'login', 'logout', 'token_refresh')
        details: Additional details dict
        level: Log level
    """
    logger = get_logger(__name__, 'AUTH')
    message = f"{event_type}"
    if details:
        message += f" - {details}"
    logger.log(level, message)


def log_tracking_event(event_type, details=None, level=logging.INFO):
    """
    Log tracking-related events
    
    Args:
        event_type: Type of tracking event (e.g., 'capture_start', 'upload_success')
        details: Additional details dict
        level: Log level
    """
    logger = get_logger(__name__, 'TRACKING')
    message = f"{event_type}"
    if details:
        message += f" - {details}"
    logger.log(level, message)


def log_network_event(event_type, details=None, level=logging.INFO):
    """
    Log network-related events
    
    Args:
        event_type: Type of network event (e.g., 'connection_failed', 'retry')
        details: Additional details dict
        level: Log level
    """
    logger = get_logger(__name__, 'NETWORK')
    message = f"{event_type}"
    if details:
        message += f" - {details}"
    logger.log(level, message)


def log_ocr_event(event_type, details=None, level=logging.INFO):
    """
    Log OCR-related events
    
    Args:
        event_type: Type of OCR event (e.g., 'extraction_start', 'engine_failed')
        details: Additional details dict
        level: Log level
    """
    logger = get_logger(__name__, 'OCR')
    message = f"{event_type}"
    if details:
        message += f" - {details}"
    logger.log(level, message)


def log_system_event(event_type, details=None, level=logging.INFO):
    """
    Log system-related events
    
    Args:
        event_type: Type of system event (e.g., 'sleep', 'wake', 'shutdown')
        details: Additional details dict
        level: Log level
    """
    logger = get_logger(__name__, 'SYSTEM')
    message = f"{event_type}"
    if details:
        message += f" - {details}"
    logger.log(level, message)


def log_performance(operation, duration_seconds, details=None):
    """
    Log performance metrics
    
    Args:
        operation: Operation name
        duration_seconds: Duration in seconds
        details: Additional details
    """
    logger = get_logger(__name__, 'PERFORMANCE')
    message = f"{operation} completed in {duration_seconds:.2f}s"
    if details:
        message += f" - {details}"
    logger.info(message)


# Export main functions
__all__ = [
    'setup_logging',
    'get_logger',
    'get_log_file_path',
    'get_log_stats',
    'log_auth_event',
    'log_tracking_event',
    'log_network_event',
    'log_ocr_event',
    'log_system_event',
    'log_performance',
]
