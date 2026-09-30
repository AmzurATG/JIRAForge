"""Render the app icon (same clock design as the tray icon) into hicolor sizes."""

import os
import sys

from PIL import Image, ImageDraw

SIZES = (16, 22, 24, 32, 48, 64, 128, 256)
BLUE = (0, 82, 204, 255)
WHITE = (255, 255, 255, 255)


def render(size):
    scale = 4
    big = size * scale
    image = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    margin = big * 0.06
    draw.ellipse([margin, margin, big - margin, big - margin], fill=BLUE, outline=WHITE,
                 width=max(scale, int(big * 0.05)))
    center = big / 2
    hand = max(scale, int(big * 0.07))
    draw.line([center, center, center, big * 0.24], fill=WHITE, width=hand)
    draw.line([center, center, big * 0.72, center], fill=WHITE, width=hand)
    return image.resize((size, size), Image.LANCZOS)


def main(out_dir):
    for size in SIZES:
        directory = os.path.join(out_dir, f'{size}x{size}', 'apps')
        os.makedirs(directory, exist_ok=True)
        render(size).save(os.path.join(directory, 'com.amzur.timetracker.png'))
    print(f'icons written to {out_dir}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'dist/icons')
