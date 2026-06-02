#!/usr/bin/env python3
"""
generate_icon.py – Create the TimeTracker app icon (256×256 PNG).

Called by build.sh when appimage/timetracker.png does not yet exist.
Requires Pillow (PIL) which is already in requirements.txt.
"""
import math
import os
import sys


def generate_icon(output_path: str, size: int = 256) -> None:
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("[ERROR] Pillow (PIL) is not installed. Cannot generate icon.")
        print("        Install it: pip install Pillow")
        sys.exit(1)

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # ── Background: rounded blue square ──────────────────────────────────────
    margin = 8
    corner_radius = max(30, size // 6)
    bg_color = (37, 116, 169, 255)        # #2574A9
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=corner_radius,
        fill=bg_color,
    )

    # ── Clock face: white circle ──────────────────────────────────────────────
    cx, cy = size // 2, size // 2
    clock_r = int(size * 0.33)
    draw.ellipse(
        [cx - clock_r, cy - clock_r, cx + clock_r, cy + clock_r],
        fill=(255, 255, 255, 255),
    )
    # Thin blue border around the clock face
    border_width = max(3, size // 70)
    draw.ellipse(
        [cx - clock_r, cy - clock_r, cx + clock_r, cy + clock_r],
        outline=bg_color,
        width=border_width,
    )

    # ── Clock tick marks ─────────────────────────────────────────────────────
    tick_color = (37, 116, 169, 200)
    for hour in range(12):
        angle = math.radians(hour * 30 - 90)
        inner = clock_r - max(6, size // 38)
        outer = clock_r - max(2, size // 100)
        x1 = cx + int(inner * math.cos(angle))
        y1 = cy + int(inner * math.sin(angle))
        x2 = cx + int(outer * math.cos(angle))
        y2 = cy + int(outer * math.sin(angle))
        draw.line([x1, y1, x2, y2], fill=tick_color, width=max(2, size // 80))

    # ── Clock hands ──────────────────────────────────────────────────────────
    def draw_hand(angle_deg: float, length_frac: float, width_px: int, color: tuple) -> None:
        """Draw a clock hand from centre at angle_deg (0 = 12 o'clock)."""
        angle = math.radians(angle_deg - 90)
        length = int(clock_r * length_frac)
        ex = cx + int(length * math.cos(angle))
        ey = cy + int(length * math.sin(angle))
        draw.line([cx, cy, ex, ey], fill=color, width=width_px)

    # Hour hand – 10 o'clock position (300°)
    draw_hand(300, 0.54, max(6, size // 38), bg_color)
    # Minute hand – 2 o'clock position (60°)
    draw_hand(60, 0.73, max(4, size // 55), bg_color)

    # ── Centre pivot dot ─────────────────────────────────────────────────────
    dot_r = max(5, size // 38)
    draw.ellipse(
        [cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r],
        fill=bg_color,
    )

    img.save(output_path, "PNG")
    print(f"[OK] Icon generated: {output_path}")


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "timetracker.png")
    generate_icon(out)
