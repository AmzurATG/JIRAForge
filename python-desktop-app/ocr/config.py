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
