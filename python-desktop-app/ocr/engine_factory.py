"""
OCR Engine Factory

Creates and manages OCR engine instances.
Implements Factory pattern with automatic discovery and registration.
"""
import logging
from typing import Dict, Type, Optional, List

from .base_engine import BaseOCREngine
from .config import OCRConfig, OCREngineConfig

logger = logging.getLogger(__name__)


class EngineFactory:
    """
    Factory for creating and managing OCR engine instances.
    
    Features:
        - Registry of available engine classes
        - Singleton caching (engines are expensive to initialize)
        - Auto-registration of built-in engines
        - Support for custom engine registration
    
    Usage:
        # Get an engine instance
        engine = EngineFactory.get_or_create('paddle', config=config)
        
        # Register custom engine
        EngineFactory.register('my_engine', MyCustomEngine)
        
        # Check available engines
        available = EngineFactory.get_available_engines()
    """
    
    # Registry of engine classes
    _registry: Dict[str, Type[BaseOCREngine]] = {}
    
    # Cache of instantiated engines (singleton per engine type)
    _instances: Dict[str, BaseOCREngine] = {}
    
    @classmethod
    def register(cls, name: str, engine_class: Type[BaseOCREngine]):
        """
        Register an OCR engine class.
        
        Args:
            name: Engine identifier (e.g., 'paddle', 'tesseract')
            engine_class: Class implementing BaseOCREngine
        """
        cls._registry[name.lower()] = engine_class
        logger.debug(f"Registered OCR engine: {name}")
    
    @classmethod
    def unregister(cls, name: str):
        """
        Unregister an OCR engine.
        
        Args:
            name: Engine identifier to remove
        """
        name = name.lower()
        if name in cls._registry:
            del cls._registry[name]
            logger.debug(f"Unregistered OCR engine: {name}")
        if name in cls._instances:
            del cls._instances[name]
    
    @classmethod
    def create(
        cls,
        name: str,
        config: Optional[OCREngineConfig] = None,
        **kwargs
    ) -> BaseOCREngine:
        """
        Create a new engine instance (doesn't use cache).
        
        Args:
            name: Engine identifier
            config: Engine configuration
            **kwargs: Override configuration with keyword arguments
        
        Returns:
            New engine instance
        
        Raises:
            ValueError: If engine not registered and cannot be dynamically created
        """
        name = name.lower()
        
        # If not registered, try to create a dynamic engine
        if name not in cls._registry:
            dynamic_engine = cls._try_create_dynamic_engine(name, config, **kwargs)
            if dynamic_engine:
                # Register it for future use
                cls.register(name, dynamic_engine.__class__)
                return dynamic_engine
            
            available = list(cls._registry.keys())
            raise ValueError(
                f"Unknown OCR engine: '{name}'. "
                f"Available engines: {available}. "
                f"To use a custom engine, set OCR_{name.upper()}_PACKAGE in .env"
            )
        
        engine_class = cls._registry[name]
        
        # Build initialization parameters
        init_params = {}
        if config:
            init_params['use_gpu'] = config.use_gpu
            init_params['language'] = config.language
            init_params['min_confidence'] = config.min_confidence
            init_params.update(config.extra_params)
        
        # Override with explicit kwargs
        init_params.update(kwargs)
        
        return engine_class(**init_params)
    
    @classmethod
    def get_or_create(
        cls,
        name: str,
        config: Optional[OCREngineConfig] = None,
        **kwargs
    ) -> BaseOCREngine:
        """
        Get cached engine instance or create new one.
        
        Args:
            name: Engine identifier
            config: Engine configuration
            **kwargs: Override configuration
        
        Returns:
            Cached or new engine instance
        """
        name = name.lower()
        
        # Return cached instance if exists
        if name in cls._instances:
            return cls._instances[name]
        
        # Create new instance and cache it
        engine = cls.create(name, config, **kwargs)
        cls._instances[name] = engine
        
        return engine
    
    @classmethod
    def get_available_engines(cls) -> Dict[str, bool]:
        """
        Get dictionary of registered engines and their availability.
        
        Returns:
            Dict mapping engine name to availability status
        """
        available = {}
        
        for name, engine_class in cls._registry.items():
            try:
                # Try to instantiate and check availability
                engine = cls.get_or_create(name)
                available[name] = engine.is_available()
            except Exception as e:
                logger.debug(f"Engine {name} creation failed: {e}")
                available[name] = False
        
        return available
    
    @classmethod
    def get_registered_engines(cls) -> List[str]:
        """
        Get list of registered engine names.
        
        Returns:
            List of engine names
        """
        return list(cls._registry.keys())
    
    @classmethod
    def is_registered(cls, name: str) -> bool:
        """
        Check if engine is registered.
        
        Args:
            name: Engine identifier
        
        Returns:
            True if registered
        """
        return name.lower() in cls._registry
    
    @classmethod
    def clear_cache(cls):
        """Clear all cached engine instances"""
        cls._instances.clear()
        logger.debug("Engine cache cleared")
    
    @classmethod
    def get_package_suggestion(cls, engine_name: str) -> str:
        """
        Get pip install suggestion for an engine.
        
        Args:
            engine_name: Engine identifier
        
        Returns:
            Installation command suggestion
        """
        package_map = {
            'rapidocr': 'pip install rapidocr_onnxruntime',
            'winrtocr': 'pip install winrtocr (Windows only)',
            'easyocr': 'pip install easyocr',
            'suryaocr': 'pip install surya-ocr',
            'google_vision': 'pip install google-cloud-vision',
            'azure_vision': 'pip install azure-cognitiveservices-vision-computervision',
            'aws_textract': 'pip install boto3',
        }
        return package_map.get(engine_name.lower(), f'pip install {engine_name}')
    
    @classmethod
    def _try_create_dynamic_engine(
        cls,
        name: str,
        config: Optional[OCREngineConfig] = None,
        **kwargs
    ) -> Optional[BaseOCREngine]:
        """
        Try to create a dynamic engine for unknown engine types.
        
        Looks for OCR_<ENGINE>_PACKAGE in configuration to determine
        which Python package to use.
        
        Args:
            name: Engine identifier
            config: Engine configuration
            **kwargs: Override parameters
        
        Returns:
            DynamicOCREngine instance or None
        """
        try:
            from .engines.dynamic_engine import create_dynamic_engine
            
            # Get configuration parameters
            if config:
                config_params = {
                    'use_gpu': config.use_gpu,
                    'language': config.language,
                    'min_confidence': config.min_confidence,
                    **config.extra_params
                }
            else:
                config_params = {}
            
            # Override with explicit kwargs
            config_params.update(kwargs)
            
            # Try to create dynamic engine
            engine = create_dynamic_engine(name, config_params)
            
            if engine and engine.is_available():
                logger.info(f"Created dynamic engine: {name}")
                return engine
            elif engine:
                logger.warning(f"Dynamic engine {name} created but package not installed")
                return engine
            else:
                logger.debug(f"Could not create dynamic engine for {name} - no package specified")
                return None
                
        except Exception as e:
            logger.debug(f"Failed to create dynamic engine for {name}: {e}")
            return None


def _auto_register():
    """
    Automatically discover and register all OCR engines.
    
    Scans the engines/ directory for *_engine.py files and auto-registers
    any classes that inherit from BaseOCREngine.
    
    This means you can add new engines by simply:
        1. Create engines/myengine_engine.py
        2. Define MyEngineEngine(BaseOCREngine)
        3. Done! Auto-discovered and registered as 'myengine'
    
    Missing dependencies don't cause errors - engine just won't be available.
    """
    import os
    import importlib
    from pathlib import Path
    import inspect
    
    try:
        engines_dir = Path(__file__).parent / 'engines'
        
        if not engines_dir.exists():
            logger.warning(f"Engines directory not found: {engines_dir}")
            return
        
        # Scan all *_engine.py files
        engine_files = sorted(engines_dir.glob('*_engine.py'))
        
        for file in engine_files:
            if file.name == '__init__.py':
                continue
            
            module_name = file.stem  # e.g., 'paddle_engine'
            engine_name = module_name.replace('_engine', '')  # 'paddle'
            
            try:
                # Dynamically import the module
                module = importlib.import_module(f'.engines.{module_name}', package='ocr')
                
                # Find engine classes (any class ending with 'Engine' except BaseOCREngine)
                for attr_name in dir(module):
                    if not attr_name.endswith('Engine'):
                        continue
                    if attr_name in ('BaseOCREngine', 'ABCMeta'):
                        continue
                    
                    attr = getattr(module, attr_name)
                    
                    # Check if it's a class and not imported from elsewhere
                    if inspect.isclass(attr) and attr.__module__ == module.__name__:
                        # Register the engine
                        EngineFactory.register(engine_name, attr)
                        logger.debug(f"✓ Auto-registered engine: {engine_name} ({attr_name})")
                        break
                else:
                    logger.debug(f"✗ No engine class found in {module_name}")
                    
            except ImportError as e:
                logger.debug(f"✗ Could not import {module_name}: {e}")
            except Exception as e:
                logger.warning(f"✗ Failed to register {engine_name}: {e}")
        
        logger.info(f"Auto-registration complete. Available engines: {list(EngineFactory._registry.keys())}")
        
    except Exception as e:
        logger.error(f"Auto-registration failed: {e}")


# Auto-register engines when module is imported
_auto_register()
