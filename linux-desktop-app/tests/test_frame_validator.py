"""
Tests for FrameValidator.

Spec: plan/2026-09-29_linux-desktop-app_phase1-foundation.md (AC 10)
"""

import pytest
from PIL import Image, ImageDraw

from timetracker_linux.capture.result import CaptureStatus
from timetracker_linux.capture.validator import FrameValidator

W, H = 1280, 720


def _dark_ide():
    """Dark theme editor: #1e1e1e background with light text lines."""
    img = Image.new('RGB', (W, H), (30, 30, 30))
    draw = ImageDraw.Draw(img)
    for row in range(40):
        y = 10 + row * 17
        indent = 20 + (row % 5) * 16
        draw.text((indent, y), 'def handle_request(self, payload): return self.process(payload)',
                  fill=(212, 212, 212))
    return img


def _document():
    img = Image.new('RGB', (W, H), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    for row in range(35):
        draw.text((40, 12 + row * 19), 'Sprint review notes for JIRA-1234: acceptance criteria met',
                  fill=(20, 20, 20))
    return img


@pytest.fixture
def validator():
    return FrameValidator()


class TestRejects:

    def test_all_black_rgb(self, validator):
        assert validator.check(Image.new('RGB', (W, H), (0, 0, 0))) == CaptureStatus.BLACK_FRAME

    def test_all_black_rgba_opaque(self, validator):
        img = Image.new('RGBA', (W, H), (0, 0, 0, 255))
        assert validator.check(img) == CaptureStatus.BLACK_FRAME

    def test_black_with_one_white_pixel(self, validator):
        img = Image.new('RGB', (W, H), (0, 0, 0))
        img.putpixel((640, 360), (255, 255, 255))
        assert validator.check(img) == CaptureStatus.BLACK_FRAME

    def test_flat_gray(self, validator):
        assert validator.check(Image.new('RGB', (W, H), (128, 128, 128))) == CaptureStatus.BLACK_FRAME

    def test_flat_white(self, validator):
        assert validator.check(Image.new('RGB', (W, H), (255, 255, 255))) == CaptureStatus.BLACK_FRAME

    def test_mostly_transparent(self, validator):
        img = _document().convert('RGBA')
        clear = Image.new('RGBA', (W, int(H * 0.6)), (0, 0, 0, 0))
        img.paste(clear, (0, 0))
        assert validator.check(img) == CaptureStatus.BLACK_FRAME

    def test_size_mismatch(self, validator):
        assert validator.check(_document(), expected_size=(1920, 1080)) == CaptureStatus.INVALID_SIZE

    def test_empty_image(self, validator):
        assert validator.check(Image.new('RGB', (0, 0))) == CaptureStatus.INVALID_SIZE

    def test_none(self, validator):
        assert validator.check(None) == CaptureStatus.ERROR


class TestAccepts:

    def test_dark_ide(self, validator):
        assert validator.check(_dark_ide()) == CaptureStatus.OK

    def test_document(self, validator):
        assert validator.check(_document()) == CaptureStatus.OK

    def test_dark_ide_rgba(self, validator):
        assert validator.check(_dark_ide().convert('RGBA')) == CaptureStatus.OK

    def test_size_within_tolerance(self, validator):
        assert validator.check(_document(), expected_size=(W + 2, H - 1)) == CaptureStatus.OK

    def test_grayscale_mode(self, validator):
        assert validator.check(_document().convert('L')) == CaptureStatus.OK
