"""
Reject black, blank, transparent and wrong-size frames before OCR.

The old Linux build checked "any band has a non-zero pixel", which passed
opaque black RGBA frames (alpha = 255) and frames with a single bright
pixel, and OCR then reported "confidence too low" for what was really a
capture failure. Here all statistics are on a small grayscale thumbnail
with alpha ignored, so one pixel cannot pass a black frame and the check
costs about a millisecond at any resolution.
"""

from PIL import Image, ImageStat

from .result import CaptureStatus

THUMB_SIZE = (64, 36)
BLACK_MAX_LUMA = 16          # brightest thumbnail cell below this → black
FLAT_MAX_STDDEV = 3.0        # solid black / gray / white failure frames
DARK_PIXEL_LUMA = 8
MOSTLY_BLACK_FRACTION = 0.97
TRANSPARENT_FRACTION = 0.5
SIZE_TOLERANCE_PX = 2


class FrameValidator:

    def check(self, image, expected_size=None):
        """Return CaptureStatus.OK or the reason the frame is unusable."""
        if image is None:
            return CaptureStatus.ERROR
        width, height = image.size
        if width <= 0 or height <= 0:
            return CaptureStatus.INVALID_SIZE
        if expected_size and (abs(width - expected_size[0]) > SIZE_TOLERANCE_PX
                              or abs(height - expected_size[1]) > SIZE_TOLERANCE_PX):
            return CaptureStatus.INVALID_SIZE

        if 'A' in image.getbands():
            alpha_hist = image.getchannel('A').histogram()
            if alpha_hist[0] / float(width * height) > TRANSPARENT_FRACTION:
                return CaptureStatus.BLACK_FRAME
            image = image.convert('RGB')

        luma = image.convert('L').resize(THUMB_SIZE, Image.BOX)
        stat = ImageStat.Stat(luma)
        _low, high = luma.getextrema()
        if high < BLACK_MAX_LUMA:
            return CaptureStatus.BLACK_FRAME
        if stat.stddev[0] < FLAT_MAX_STDDEV:
            return CaptureStatus.BLACK_FRAME

        hist = luma.histogram()
        dark = sum(hist[:DARK_PIXEL_LUMA])
        if dark / float(THUMB_SIZE[0] * THUMB_SIZE[1]) > MOSTLY_BLACK_FRACTION:
            return CaptureStatus.BLACK_FRAME

        return CaptureStatus.OK
