"""
Image Preprocessing for OCR
CLAHE, denoising, sharpening for better text extraction.

Three modes:
  - preprocess_image(): Full pipeline for scanned documents (CLAHE, denoise, sharpen)
  - preprocess_screenshot(): Engine-aware lightweight pipeline for screen captures
  - resize_if_needed(): Simple downscale guard

cv2 is used when available for best quality.  If cv2 cannot be imported (e.g.
when running inside a PyInstaller AppImage where cv2 is excluded to avoid
namespace-package recursion), all operations fall back to PIL + numpy equivalents
that produce equivalent results for screenshot-based OCR.
"""
try:
    import cv2
    _CV2 = True
except Exception:
    _CV2 = False

import numpy as np
from PIL import Image, ImageFilter, ImageOps, ImageEnhance
import logging

logger = logging.getLogger(__name__)

SCREENSHOT_MAX_DIMENSION = 1920


# ---------------------------------------------------------------------------
# PIL-only helpers (used when cv2 is unavailable)
# ---------------------------------------------------------------------------

def _pil_resize(img_np: np.ndarray, new_w: int, new_h: int) -> np.ndarray:
    """Resize a numpy array image using PIL (LANCZOS for downscale)."""
    pil = Image.fromarray(img_np)
    pil = pil.resize((new_w, new_h), Image.LANCZOS)
    return np.array(pil)


def _pil_to_gray(img_np: np.ndarray) -> np.ndarray:
    """Convert RGB numpy array to grayscale via PIL."""
    pil = Image.fromarray(img_np)
    gray = pil.convert('L')
    return np.array(gray)


def _pil_clahe(gray_np: np.ndarray) -> np.ndarray:
    """Approximate CLAHE using PIL histogram equalization (fast, good enough for
    screenshot text — clean digital images have low noise so full CLAHE is
    overkill)."""
    pil = Image.fromarray(gray_np, mode='L')
    equalized = ImageOps.equalize(pil)
    return np.array(equalized)


def _pil_sharpen(gray_np: np.ndarray) -> np.ndarray:
    """Unsharp-mask sharpening via PIL (equivalent to cv2 sharpening kernel)."""
    pil = Image.fromarray(gray_np, mode='L')
    sharpened = pil.filter(ImageFilter.UnsharpMask(radius=1, percent=150, threshold=3))
    return np.array(sharpened)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def preprocess_screenshot(img_input, max_dimension=SCREENSHOT_MAX_DIMENSION, engine_hint='rapidocr'):
    """
    Engine-aware lightweight preprocessing optimized for screen captures.

    Screenshots are clean digital images — they don’t need the heavy denoising
    pipeline used for scanned documents. But different OCR engines have different
    needs:

      RapidOCR / WinRTOCR: Neural engines with their own preprocessing; work
        best with RGB input.
        → Just downscale, keep color.

      EasyOCR: Works best with high-contrast grayscale input. Needs help with
        contrast but NOT denoising (clean digital text has no noise to remove).
        → Downscale → grayscale → CLAHE (fast contrast enhancement, ~15ms).

    In all cases, the expensive operations are skipped:
      - fastNlMeansDenoising (~300-800ms) — unnecessary for clean screenshots
      - Sharpening kernel — can introduce artifacts on already-sharp screen text
      - Upscaling — screenshots are already at native resolution

    Args:
        img_input: PIL Image or numpy array
        max_dimension: Maximum width/height in pixels
        engine_hint: OCR engine name ('rapidocr', 'winrtocr', 'easyocr', etc.)
            Controls which preprocessing steps are applied.

    Returns:
        numpy array: Ready for OCR (format depends on engine)
    """
    try:
        if isinstance(img_input, Image.Image):
            img = np.array(img_input)
        else:
            img = img_input

        height, width = img.shape[:2]

        # Downscale large images (4K → 1920px max)
        if max(height, width) > max_dimension:
            scale = max_dimension / max(height, width)
            new_w = int(width * scale)
            new_h = int(height * scale)
            if _CV2:
                img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
            else:
                img = _pil_resize(img, new_w, new_h)
            logger.debug(f"Screenshot downscaled {width}x{height} → {new_w}x{new_h}")

        # Engine-specific preprocessing
        if engine_hint in ('easyocr',):
            # EasyOCR needs grayscale + contrast enhancement
            if _CV2:
                if len(img.shape) == 3:
                    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
                else:
                    gray = img
                clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
                img = clahe.apply(gray)
            else:
                gray = _pil_to_gray(img) if len(img.shape) == 3 else img
                img = _pil_clahe(gray)

            logger.debug(f"Screenshot preprocessed for {engine_hint}: grayscale + CLAHE")

        # RapidOCR, WinRTOCR (and other neural engines): keep RGB, no extra processing
        return img

    except Exception as e:
        logger.error(f"Screenshot preprocessing failed: {e}")
        if isinstance(img_input, Image.Image):
            return np.array(img_input)
        return img_input


def preprocess_image(img_input, target_dpi=300):
    """
    Full preprocessing for scanned documents / photos.

    Steps: grayscale → CLAHE → denoise → sharpen → optional upscale.
    NOT recommended for screen captures — use preprocess_screenshot() instead.

    Args:
        img_input: PIL Image or numpy array
        target_dpi (int): Target DPI for upscaling

    Returns:
        numpy array: Preprocessed image
    """
    try:
        if isinstance(img_input, Image.Image):
            img = np.array(img_input)
        else:
            img = img_input.copy()

        if _CV2:
            gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY) if len(img.shape) == 3 else img
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            enhanced = clahe.apply(gray)
            denoised = cv2.fastNlMeansDenoising(enhanced, None, h=10)
            kernel = np.array([[-1, -1, -1],
                               [-1,  9, -1],
                               [-1, -1, -1]])
            sharpened = cv2.filter2D(denoised, -1, kernel)
        else:
            gray = _pil_to_gray(img) if len(img.shape) == 3 else img
            enhanced = _pil_clahe(gray)
            # PIL denoising: MedianFilter is fast and effective for printed text
            pil_enhanced = Image.fromarray(enhanced, mode='L')
            denoised_pil = pil_enhanced.filter(ImageFilter.MedianFilter(size=3))
            sharpened_np = _pil_sharpen(np.array(denoised_pil))
            sharpened = sharpened_np

        min_dimension = 1000
        height, width = sharpened.shape
        if min(height, width) < min_dimension:
            scale = min_dimension / min(height, width)
            new_width = int(width * scale)
            new_height = int(height * scale)
            if _CV2:
                sharpened = cv2.resize(sharpened, (new_width, new_height),
                                       interpolation=cv2.INTER_CUBIC)
            else:
                sharpened = _pil_resize(sharpened, new_width, new_height)
            logger.info(f"Upscaled image from {width}x{height} to {new_width}x{new_height}")

        return sharpened

    except Exception as e:
        logger.error(f"Image preprocessing failed: {e}")
        try:
            if isinstance(img_input, Image.Image):
                return np.array(img_input.convert('L'))
            return img_input
        except Exception:
            return img_input


def resize_if_needed(img, max_dimension=4096):
    """
    Resize image if too large (reduces memory usage)

    Args:
        img: Numpy array
        max_dimension (int): Maximum width/height

    Returns:
        numpy array: Resized image (if needed)
    """
    try:
        height, width = img.shape[:2]

        if max(height, width) <= max_dimension:
            return img

        scale = max_dimension / max(height, width)
        new_width = int(width * scale)
        new_height = int(height * scale)

        if _CV2:
            resized = cv2.resize(img, (new_width, new_height),
                                 interpolation=cv2.INTER_AREA)
        else:
            resized = _pil_resize(img, new_width, new_height)

        logger.info(f"Resized image from {width}x{height} to {new_width}x{new_height}")
        return resized

    except Exception as e:
        logger.error(f"Image resize failed: {e}")
        return img


logger = logging.getLogger(__name__)

SCREENSHOT_MAX_DIMENSION = 1920


def preprocess_screenshot(img_input, max_dimension=SCREENSHOT_MAX_DIMENSION, engine_hint='rapidocr'):
    """
    Engine-aware lightweight preprocessing optimized for screen captures.

    Screenshots are clean digital images — they don't need the heavy denoising
    pipeline used for scanned documents. But different OCR engines have different
    needs:

      RapidOCR / WinRTOCR: Neural engines with their own preprocessing; work
        best with RGB input.
        → Just downscale, keep color.

      EasyOCR: Works best with high-contrast grayscale input. Needs help with
        contrast but NOT denoising (clean digital text has no noise to remove).
        → Downscale → grayscale → CLAHE (fast contrast enhancement, ~15ms).

    In all cases, the expensive operations are skipped:
      - fastNlMeansDenoising (~300-800ms) — unnecessary for clean screenshots
      - Sharpening kernel — can introduce artifacts on already-sharp screen text
      - Upscaling — screenshots are already at native resolution

    Args:
        img_input: PIL Image or numpy array
        max_dimension: Maximum width/height in pixels
        engine_hint: OCR engine name ('rapidocr', 'winrtocr', 'easyocr', etc.)
            Controls which preprocessing steps are applied.

    Returns:
        numpy array: Ready for OCR (format depends on engine)
    """
    try:
        if isinstance(img_input, Image.Image):
            img = np.array(img_input)
        else:
            img = img_input

        height, width = img.shape[:2]

        # Downscale large images (4K → 1920px max)
        if max(height, width) > max_dimension:
            scale = max_dimension / max(height, width)
            new_w = int(width * scale)
            new_h = int(height * scale)
            img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
            logger.debug(f"Screenshot downscaled {width}x{height} → {new_w}x{new_h}")

        # Engine-specific preprocessing
        if engine_hint in ('easyocr',):
            # EasyOCR needs grayscale + contrast enhancement
            if len(img.shape) == 3:
                gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
            else:
                gray = img

            # CLAHE: fast adaptive contrast (~10-15ms). Improves EasyOCR
            # accuracy on screenshots with varying background colors (dark themes,
            # colored terminals, etc.)
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            img = clahe.apply(gray)

            logger.debug(f"Screenshot preprocessed for {engine_hint}: grayscale + CLAHE")

        # RapidOCR, WinRTOCR (and other neural engines): keep RGB, no extra processing
        return img

    except Exception as e:
        logger.error(f"Screenshot preprocessing failed: {e}")
        if isinstance(img_input, Image.Image):
            return np.array(img_input)
        return img_input


def preprocess_image(img_input, target_dpi=300):
    """
    Full preprocessing for scanned documents / photos.

    Steps: grayscale → CLAHE → denoise → sharpen → optional upscale.
    NOT recommended for screen captures — use preprocess_screenshot() instead.

    Args:
        img_input: PIL Image or numpy array
        target_dpi (int): Target DPI for upscaling
        
    Returns:
        numpy array: Preprocessed image
    """
    try:
        if isinstance(img_input, Image.Image):
            img = np.array(img_input)
        else:
            img = img_input.copy()
        
        if len(img.shape) == 3:
            gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
        else:
            gray = img
        
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)
        
        denoised = cv2.fastNlMeansDenoising(enhanced, None, h=10)
        
        kernel = np.array([[-1, -1, -1],
                          [-1,  9, -1],
                          [-1, -1, -1]])
        sharpened = cv2.filter2D(denoised, -1, kernel)
        
        min_dimension = 1000
        height, width = sharpened.shape
        if min(height, width) < min_dimension:
            scale = min_dimension / min(height, width)
            new_width = int(width * scale)
            new_height = int(height * scale)
            sharpened = cv2.resize(sharpened, (new_width, new_height), 
                                 interpolation=cv2.INTER_CUBIC)
            logger.info(f"Upscaled image from {width}x{height} to {new_width}x{new_height}")
        
        return sharpened
        
    except Exception as e:
        logger.error(f"Image preprocessing failed: {e}")
        if isinstance(img_input, Image.Image):
            return cv2.cvtColor(np.array(img_input), cv2.COLOR_RGB2GRAY)
        return img_input


def resize_if_needed(img, max_dimension=4096):
    """
    Resize image if too large (reduces memory usage)
    
    Args:
        img: Numpy array
        max_dimension (int): Maximum width/height
        
    Returns:
        numpy array: Resized image (if needed)
    """
    try:
        height, width = img.shape[:2]
        
        if max(height, width) <= max_dimension:
            return img
        
        scale = max_dimension / max(height, width)
        new_width = int(width * scale)
        new_height = int(height * scale)
        
        resized = cv2.resize(img, (new_width, new_height), 
                           interpolation=cv2.INTER_AREA)
        logger.info(f"Resized image from {width}x{height} to {new_width}x{new_height}")
        return resized
        
    except Exception as e:
        logger.error(f"Image resize failed: {e}")
        return img
