"""
Privacy Detectors Module

Provides detection strategies for different types of sensitive data.
"""
import warnings

# Check for optional dependencies
# Note: We catch (ImportError, OSError) because on Windows, DLL loading failures
# raise OSError (e.g., WinError 127) when PyTorch/spaCy dependencies are broken
PRESIDIO_AVAILABLE = False
SECRETS_AVAILABLE = False
_PRESIDIO_ERROR = None
_SECRETS_ERROR = None

try:
    from presidio_analyzer import AnalyzerEngine
    PRESIDIO_AVAILABLE = True
except (ImportError, OSError) as e:
    _PRESIDIO_ERROR = str(e)
    warnings.warn(
        "CRITICAL: Presidio is NOT installed or failed to load. "
        "PII detection is DEGRADED — credit card Luhn validation, phone number "
        "format detection, and NER-based name/address detection are DISABLED. "
        f"Error: {e}. "
        "Install with: pip install presidio-analyzer && python -m spacy download en_core_web_sm",
        RuntimeWarning,
        stacklevel=2
    )

try:
    from detect_secrets.core.scan import scan_line
    SECRETS_AVAILABLE = True
except (ImportError, OSError) as e:
    _SECRETS_ERROR = str(e)
    pass


# Base classes (always available)
from .base import BaseDetector, Detection

# Custom patterns (always available - no external deps)
from .custom_patterns import CustomPatternDetector

# Entropy detector (always available - no external deps)
from .entropy_detector import EntropyDetector

# Optional detectors - imported on demand
# from .presidio_detector import PresidioDetector  # Requires presidio-analyzer
# from .secrets_detector import SecretsDetector    # Requires detect-secrets

__all__ = [
    # Availability flags
    'PRESIDIO_AVAILABLE',
    'SECRETS_AVAILABLE',
    
    # Base classes
    'BaseDetector',
    'Detection',
    
    # Detectors
    'CustomPatternDetector',
    'EntropyDetector',
]

# Add optional detectors to exports if available
if PRESIDIO_AVAILABLE:
    try:
        from .presidio_detector import PresidioDetector
        __all__.append('PresidioDetector')
    except (ImportError, OSError) as e:
        PRESIDIO_AVAILABLE = False
        _PRESIDIO_ERROR = str(e)

if SECRETS_AVAILABLE:
    try:
        from .secrets_detector import SecretsDetector
        __all__.append('SecretsDetector')
    except (ImportError, OSError) as e:
        SECRETS_AVAILABLE = False
        _SECRETS_ERROR = str(e)
