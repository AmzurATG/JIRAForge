"""
OCR Configuration Management
Centralized configuration that can be loaded from environment variables or files.

Supports DYNAMIC engine discovery - any OCR engine can be configured via
environment variables without modifying this file.

Pattern: OCR_<ENGINE>_<SETTING>=value
Example: OCR_GOOGLE_VISION_API_KEY=secret123
"""
import os
import json
import logging
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any

logger = logging.getLogger(__name__)


@dataclass
class OCREngineConfig:
    """Configuration for a single OCR engine"""
    name: str                           # Engine identifier
    enabled: bool = True                # Is this engine enabled?
    priority: int = 0                   # Lower = higher priority
    min_confidence: float = 0.5         # Minimum confidence threshold
    use_gpu: bool = False               # Use GPU acceleration
    language: str = 'en'                # OCR language
    extra_params: Dict[str, Any] = field(default_factory=dict)  # Engine-specific params
    
    def __post_init__(self):
        """Ensure extra_params is a dict"""
        if self.extra_params is None:
            self.extra_params = {}


@dataclass
class OCRConfig:
    """
    Main OCR configuration with DYNAMIC engine discovery.
    
    Automatically discovers ANY OCR engine from environment variables.
    Pattern: OCR_<ENGINE>_<SETTING>=value
    """
    primary_engine: str = 'rapidocr'      # Primary OCR engine
    fallback_engines: List[str] = field(default_factory=lambda: ['winrtocr'])
    use_preprocessing: bool = True
    preprocessing_target_dpi: int = 300
    max_image_dimension: int = 4096
    engines: Dict[str, OCREngineConfig] = field(default_factory=dict)
    
    @classmethod
    def from_env(cls) -> 'OCRConfig':
        """
        Load configuration from environment variables - FULLY DYNAMIC.
        
        Automatically discovers ANY OCR engine from environment variables.
        Pattern: OCR_<ENGINE>_<SETTING>=value
        
        Examples:
            OCR_PRIMARY_ENGINE=rapidocr
            OCR_RAPIDOCR_MIN_CONFIDENCE=0.6
            OCR_GOOGLE_VISION_API_KEY=abc123  ← Automatically detected!
            OCR_MY_CUSTOM_ENGINE_USE_GPU=true  ← Any engine works!
        """
        config = cls()
        
        # Primary engine
        config.primary_engine = os.getenv('OCR_PRIMARY_ENGINE', 'rapidocr').lower()
        
        # Fallback engines (comma-separated)
        fallback = os.getenv('OCR_FALLBACK_ENGINES', 'winrtocr')
        config.fallback_engines = [e.strip().lower() for e in fallback.split(',') if e.strip()]
        
        # Preprocessing
        config.use_preprocessing = os.getenv('OCR_USE_PREPROCESSING', 'true').lower() == 'true'
        config.max_image_dimension = int(os.getenv('OCR_MAX_IMAGE_DIMENSION', '4096'))
        
        # DYNAMIC ENGINE DISCOVERY: Find all engines mentioned in environment
        discovered_engines = set()
        discovered_engines.add(config.primary_engine)
        discovered_engines.update(config.fallback_engines)
        
        # Scan environment for OCR_<ENGINE>_* patterns
        for key in os.environ:
            if key.startswith('OCR_') and '_' in key[4:]:
                parts = key.split('_')
                # Skip global settings (OCR_PRIMARY_ENGINE, OCR_FALLBACK_ENGINES, etc.)
                if len(parts) >= 3 and parts[1].lower() not in [
                    'primary', 'fallback', 'use', 'max', 'preprocessing'
                ]:
                    engine_name = parts[1].lower()
                    discovered_engines.add(engine_name)
        
        # Create configuration for each discovered engine dynamically
        config.engines = {}
        for engine_name in discovered_engines:
            config.engines[engine_name] = cls._create_engine_config_from_env(engine_name)
        
        logger.debug(f"Discovered OCR engines from environment: {list(discovered_engines)}")
        return config
    
    @staticmethod
    def _create_engine_config_from_env(engine_name: str) -> OCREngineConfig:
        """
        Dynamically create engine config from environment variables for ANY engine.
        
        Reads configuration for any engine using pattern: OCR_<ENGINE>_<SETTING>
        
        Standard settings supported:
            - ENABLED: true/false (default: true)
            - MIN_CONFIDENCE: 0.0-1.0 (default: 0.5)
            - USE_GPU: true/false (default: false)
            - LANGUAGE: language code (default: 'en')
            - Any custom settings go into extra_params
        
        Example for custom engine:
            OCR_MYENGINE_MIN_CONFIDENCE=0.7
            OCR_MYENGINE_API_KEY=secret123
            OCR_MYENGINE_ENDPOINT=https://api.example.com
        """
        prefix = f'OCR_{engine_name.upper()}_'
        
        default_min_confidence = '0.5'

        # Standard configuration
        engine_config = OCREngineConfig(
            name=engine_name,
            enabled=os.getenv(f'{prefix}ENABLED', 'true').lower() == 'true',
            min_confidence=float(os.getenv(f'{prefix}MIN_CONFIDENCE', default_min_confidence)),
            use_gpu=os.getenv(f'{prefix}USE_GPU', 'false').lower() == 'true',
            language=os.getenv(f'{prefix}LANGUAGE', 'en')
        )
        
        # Capture any extra custom parameters for this engine
        standard_keys = ['ENABLED', 'MIN_CONFIDENCE', 'USE_GPU', 'LANGUAGE']
        for key, value in os.environ.items():
            if key.startswith(prefix):
                param_name = key[len(prefix):].lower()
                if param_name not in [k.lower() for k in standard_keys]:
                    engine_config.extra_params[param_name] = value
        
        return engine_config
    
    @classmethod
    def from_file(cls, filepath: str) -> 'OCRConfig':
        """Load configuration from JSON file"""
        with open(filepath, 'r') as f:
            data = json.load(f)
        return cls.from_dict(data)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'OCRConfig':
        """
        Load configuration from dictionary (e.g., from AI server).
        
        Args:
            data: Configuration dictionary with keys matching OCRConfig fields
        
        Example:
            data = {
                'primary_engine': 'rapidocr',
                'fallback_engines': ['winrtocr'],
                'engines': {
                    'rapidocr': {'min_confidence': 0.6, 'use_gpu': False, ...}
                }
            }
        """
        config = cls()
        config.primary_engine = data.get('primary_engine', 'rapidocr')
        config.fallback_engines = data.get('fallback_engines', ['winrtocr'])
        config.use_preprocessing = data.get('use_preprocessing', True)
        config.max_image_dimension = data.get('max_image_dimension', 4096)
        
        # Load engine configurations from file
        for name, engine_data in data.get('engines', {}).items():
            extra = {k: v for k, v in engine_data.items() 
                    if k not in ['name', 'enabled', 'priority', 'min_confidence', 'use_gpu', 'language']}
            default_min_confidence = 0.5
            config.engines[name] = OCREngineConfig(
                name=name,
                enabled=engine_data.get('enabled', True),
                priority=engine_data.get('priority', 0),
                min_confidence=engine_data.get('min_confidence', default_min_confidence),
                use_gpu=engine_data.get('use_gpu', False),
                language=engine_data.get('language', 'en'),
                extra_params=extra
            )
        
        return config
    
    def get_engine_config(self, engine_name: str) -> OCREngineConfig:
        """
        Get configuration for a specific engine.
        Creates default config if engine not found (supports unknown engines).
        """
        if engine_name not in self.engines:
            # Dynamic default creation for unknown engines
            logger.debug(f"Creating default config for unknown engine: {engine_name}")
            return OCREngineConfig(name=engine_name)
        return self.engines[engine_name]
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert config to dictionary for serialization"""
        return {
            'primary_engine': self.primary_engine,
            'fallback_engines': self.fallback_engines,
            'use_preprocessing': self.use_preprocessing,
            'max_image_dimension': self.max_image_dimension,
            'engines': {
                name: {
                    'name': cfg.name,
                    'enabled': cfg.enabled,
                    'priority': cfg.priority,
                    'min_confidence': cfg.min_confidence,
                    'use_gpu': cfg.use_gpu,
                    'language': cfg.language,
                    **cfg.extra_params
                }
                for name, cfg in self.engines.items()
            }
        }


# =============================================================================
# PLATFORM-SPECIFIC ENGINE COMPATIBILITY
# =============================================================================

def get_platform_compatible_engines() -> List[str]:
    """
    Return list of OCR engines compatible with the current platform.
    
    Returns:
        list: Engine names that work on this platform
    """
    import sys
    
    # Common engines that work on all platforms
    common_engines = ['rapidocr', 'easyocr', 'tesseract']
    
    # Platform-specific engines
    if sys.platform == 'win32':
        # Windows: all common engines + native WinRT
        return common_engines + ['winrtocr']
    elif sys.platform.startswith('linux'):
        # Linux: all common engines (no WinRT)
        return common_engines
    elif sys.platform == 'darwin':
        # macOS: all common engines (no WinRT)
        return common_engines
    else:
        # Unknown platform: use common engines only
        logger.warning(f"Unknown platform: {sys.platform}, using common OCR engines")
        return common_engines


def filter_engines_by_platform(engine_list: List[str]) -> List[str]:
    """
    Filter a list of engine names to only include platform-compatible ones.
    
    Args:
        engine_list: List of engine names from config
        
    Returns:
        list: Filtered list containing only compatible engines
    """
    compatible = get_platform_compatible_engines()
    filtered = [e for e in engine_list if e in compatible]
    
    # Log filtered engines for diagnostics
    removed = [e for e in engine_list if e not in filtered]
    if removed:
        import sys
        logger.info(
            f"Filtered incompatible engines for {sys.platform}: {removed}. "
            f"Using compatible engines: {filtered}"
        )
    
    return filtered


def apply_platform_filters(config: OCRConfig) -> OCRConfig:
    """
    Apply platform compatibility filters to an OCR configuration.
    
    - Filters out incompatible engines from primary and fallback lists
    - If primary engine is incompatible, switches to first compatible fallback
    - Logs all changes for transparency
    
    Args:
        config: Original OCR configuration
        
    Returns:
        OCRConfig: Filtered configuration with only compatible engines
    """
    import sys
    
    compatible = get_platform_compatible_engines()
    original_primary = config.primary_engine
    original_fallbacks = config.fallback_engines.copy()
    
    # Check if primary engine is compatible
    if config.primary_engine not in compatible:
        logger.warning(
            f"Primary OCR engine '{config.primary_engine}' is not compatible "
            f"with {sys.platform}. Switching to fallback."
        )
        
        # Find first compatible fallback
        for fallback in config.fallback_engines:
            if fallback in compatible:
                logger.info(f"Using '{fallback}' as primary OCR engine on {sys.platform}")
                config.primary_engine = fallback
                break
        else:
            # No compatible fallback found - use rapidocr as default
            logger.warning(
                "No compatible fallback found. Using 'rapidocr' as default primary engine."
            )
            config.primary_engine = 'rapidocr'
    
    # Filter fallback engines
    config.fallback_engines = filter_engines_by_platform(config.fallback_engines)

    # If all configured fallbacks were filtered out (e.g. only 'winrtocr' was
    # listed and we are on Linux/macOS), inject platform-safe defaults so that
    # OCR can still fall back to something when the primary engine is
    # unavailable.  We use easyocr first (pure-Python, cross-platform), then
    # tesseract as a last resort.  Both are in common_engines for all platforms.
    if not config.fallback_engines and original_fallbacks:
        platform_safe_fallbacks = [
            e for e in ['easyocr', 'tesseract']
            if e != config.primary_engine
        ]
        config.fallback_engines = platform_safe_fallbacks
        logger.info(
            f"All configured fallback engines ({original_fallbacks}) are "
            f"incompatible with {sys.platform}. "
            f"Using platform-safe defaults: {config.fallback_engines}"
        )

    # Log summary if anything changed
    if (original_primary != config.primary_engine or
            original_fallbacks != config.fallback_engines):
        logger.info(
            f"OCR engine configuration adjusted for {sys.platform}: "
            f"primary={config.primary_engine}, fallbacks={config.fallback_engines}"
        )

    return config
