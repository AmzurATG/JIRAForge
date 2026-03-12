"""Image preprocessing for OCR optimization on Linux"""

from PIL import Image, ImageEnhance, ImageFilter
from typing import Tuple

from .config import OCRConfig


def preprocess_screenshot(image: Image.Image, engine_hint: str = 'paddle') -> Image.Image:
    """
    Preprocess screenshot for better OCR accuracy.
    
    Args:
        image: PIL Image to preprocess
        engine_hint: Target OCR engine ('paddle', 'tesseract')
        
    Returns:
        Preprocessed PIL Image
    """
    # Ensure RGB mode
    if image.mode == 'RGBA':
        # Create white background for transparency
        background = Image.new('RGB', image.size, (255, 255, 255))
        background.paste(image, mask=image.split()[3])
        image = background
    elif image.mode != 'RGB':
        image = image.convert('RGB')
    
    # Resize if too large - keeps memory and processing time in check
    max_size = OCRConfig.MAX_IMAGE_SIZE
    if image.size[0] > max_size[0] or image.size[1] > max_size[1]:
        image.thumbnail(max_size, Image.LANCZOS)
    
    # Engine-specific preprocessing
    if engine_hint == 'tesseract':
        image = _preprocess_for_tesseract(image)
    # PaddleOCR generally works well without heavy preprocessing
    
    return image


def _preprocess_for_tesseract(image: Image.Image) -> Image.Image:
    """
    Tesseract-specific preprocessing.
    Tesseract benefits from high contrast and clean images.
    """
    # Convert to grayscale for better text detection
    gray = image.convert('L')
    
    # Enhance contrast
    enhancer = ImageEnhance.Contrast(gray)
    gray = enhancer.enhance(1.5)
    
    # Slight sharpening
    gray = gray.filter(ImageFilter.SHARPEN)
    
    # Convert back to RGB (some Tesseract configs expect it)
    return gray.convert('RGB')


def extract_text_regions(image: Image.Image) -> Image.Image:
    """
    Extract regions likely to contain text.
    Useful for reducing OCR processing time on large screenshots.
    
    Note: Currently returns full image. Can be enhanced with
    text region detection in the future.
    """
    return image


def calculate_image_hash(image: Image.Image) -> str:
    """
    Calculate perceptual hash of image.
    Used to detect duplicate/unchanged screenshots.
    
    Uses average hash algorithm - fast and effective for
    detecting near-identical images.
    """
    import hashlib
    
    # Resize to small fixed size for hashing
    small = image.resize((16, 16), Image.LANCZOS).convert('L')
    pixels = list(small.getdata())
    
    # Simple average hash
    avg = sum(pixels) / len(pixels)
    bits = ''.join('1' if p > avg else '0' for p in pixels)
    
    return hashlib.md5(bits.encode()).hexdigest()


def resize_for_upload(image: Image.Image, max_dimension: int = 1920) -> Image.Image:
    """
    Resize image for upload (if needed).
    Maintains aspect ratio.
    """
    if max(image.size) <= max_dimension:
        return image
    
    ratio = max_dimension / max(image.size)
    new_size = (int(image.size[0] * ratio), int(image.size[1] * ratio))
    return image.resize(new_size, Image.LANCZOS)
