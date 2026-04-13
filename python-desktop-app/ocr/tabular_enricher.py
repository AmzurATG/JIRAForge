"""
Tabular Context Enricher

Reconstructs tabular structure from OCR bounding boxes to provide column-header
context for PII detection. When OCR extracts text from spreadsheets/tables,
column headers (e.g., "Password", "SSN") are disconnected from their values.
This module re-associates them so the privacy filter can detect unlabeled PII.

Example:
    OCR raw text: "Password  SSN\nMySecret123  123-45-6789"
    Enriched text: "Password=MySecret123\nSSN=123-45-6789"
    → Now the privacy filter catches "Password=MySecret123" as a PASSWORD entity.
"""
import logging
from typing import List, Dict, Any, Optional, Tuple

logger = logging.getLogger(__name__)


# Column headers that indicate the data beneath is sensitive
SENSITIVE_HEADERS = [
    'password', 'pwd', 'pass', 'secret', 'passphrase',
    'ssn', 'social security', 'social_security',
    'credit card', 'card number', 'card_number', 'cc number', 'cc_number',
    'account', 'account number', 'account_number', 'routing',
    'cvv', 'cvc', 'security code',
    'pin', 'pin code',
    'dob', 'date of birth', 'date_of_birth', 'birth date', 'birthdate',
    'salary', 'wage', 'compensation', 'pay rate',
    'bank', 'iban', 'swift',
    'passport', 'passport number', 'passport_number',
    'license', 'dl number', 'dl_number', 'driver license', 'drivers license',
    'tax id', 'tax_id', 'ein', 'itin', 'tin',
    'phone', 'mobile', 'cell', 'telephone',
    'email', 'e-mail', 'email address',
    'address', 'street', 'zip code', 'zipcode', 'zip',
    'api key', 'api_key', 'apikey', 'token', 'auth token',
    'private key', 'private_key',
]


class TabularContextEnricher:
    """
    Reconstruct tabular structure from OCR bounding boxes.

    If a value appears below a header like 'Password', 'SSN', 'Credit Card',
    prefix the value with the header context for better privacy detection.

    This handles the key gap where OCR extracts cell values without their
    column header context, making pattern-based PII detection fail.
    """

    def __init__(self, y_tolerance: int = 20, x_tolerance: int = 40):
        """
        Args:
            y_tolerance: Pixels of Y-axis tolerance for grouping boxes into rows.
            x_tolerance: Pixels of X-axis tolerance for matching columns.
        """
        self.y_tolerance = y_tolerance
        self.x_tolerance = x_tolerance

    def enrich(self, text: str, boxes: Optional[List[Dict[str, Any]]]) -> str:
        """
        Analyze OCR bounding boxes to detect tabular layout and enrich text
        with column-header context for better PII detection.

        Args:
            text: Raw OCR text
            boxes: OCR bounding boxes. Each box should have at minimum:
                   {'text': str, 'x': int, 'y': int} and optionally 'w', 'h'.

        Returns:
            Context-enriched text. If no tabular structure is detected,
            returns the original text unchanged.
        """
        if not boxes or len(boxes) < 2:
            return text

        try:
            # Normalize box format — ensure all have required fields
            normalized = self._normalize_boxes(boxes)
            if not normalized:
                return text

            # Group boxes by rows (similar Y coordinate)
            rows = self._group_by_rows(normalized)
            if len(rows) < 2:
                return text

            # Find the header row (first row containing sensitive keywords)
            header_row_idx, header_row = self._find_header_row(rows)
            if header_row is None:
                return text

            # Map column positions to header text
            column_headers = self._map_columns(header_row)
            if not column_headers:
                return text

            # Build enriched text: for data rows under sensitive headers,
            # prefix values with "HeaderName=" so the privacy filter can detect them
            enriched_parts = []
            sensitive_count = 0

            for row_idx, row in enumerate(rows):
                if row_idx == header_row_idx:
                    # Keep header row as-is
                    row_text = ' '.join(box['text'] for box in row if box.get('text'))
                    enriched_parts.append(row_text)
                    continue

                for box in row:
                    box_text = box.get('text', '').strip()
                    if not box_text:
                        continue

                    col_header = self._find_column_header(box, column_headers)
                    if col_header and self._is_sensitive_header(col_header):
                        # Prefix with header context: "password=MySecret123"
                        enriched_parts.append(f"{col_header}={box_text}")
                        sensitive_count += 1
                    else:
                        enriched_parts.append(box_text)

            if sensitive_count > 0:
                enriched_text = '\n'.join(enriched_parts)
                logger.info(
                    f"[TABULAR] Enriched {sensitive_count} cell(s) with column-header context "
                    f"for better PII detection"
                )
                return enriched_text

            return text

        except Exception as e:
            logger.warning(f"TabularContextEnricher failed, using original text: {e}")
            return text

    def _normalize_boxes(self, boxes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Normalize box format to ensure all have x, y, text."""
        normalized = []
        for box in boxes:
            text = box.get('text', '').strip()
            if not text:
                continue

            # Handle different box formats from various OCR engines
            x = box.get('x', box.get('left', 0))
            y = box.get('y', box.get('top', 0))
            w = box.get('w', box.get('width', len(text) * 8))  # rough estimate
            h = box.get('h', box.get('height', 20))

            # Handle coordinate arrays (e.g., [[x1,y1],[x2,y2],[x3,y3],[x4,y4]])
            if 'coordinates' in box or 'bbox' in box:
                coords = box.get('coordinates', box.get('bbox', []))
                if isinstance(coords, (list, tuple)) and len(coords) >= 2:
                    if isinstance(coords[0], (list, tuple)):
                        x = coords[0][0]
                        y = coords[0][1]
                    else:
                        x = coords[0]
                        y = coords[1]

            normalized.append({
                'text': text,
                'x': int(x) if x else 0,
                'y': int(y) if y else 0,
                'w': int(w) if w else 0,
                'h': int(h) if h else 0,
            })

        return normalized

    def _group_by_rows(self, boxes: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
        """Group bounding boxes into rows by Y coordinate proximity."""
        if not boxes:
            return []

        sorted_boxes = sorted(boxes, key=lambda b: (b['y'], b['x']))
        rows: List[List[Dict[str, Any]]] = []
        current_row = [sorted_boxes[0]]

        for box in sorted_boxes[1:]:
            if abs(box['y'] - current_row[0]['y']) <= self.y_tolerance:
                current_row.append(box)
            else:
                rows.append(sorted(current_row, key=lambda b: b['x']))
                current_row = [box]

        if current_row:
            rows.append(sorted(current_row, key=lambda b: b['x']))

        return rows

    def _find_header_row(
        self, rows: List[List[Dict[str, Any]]]
    ) -> Tuple[Optional[int], Optional[List[Dict[str, Any]]]]:
        """Find the row most likely to be a header containing sensitive column names."""
        for idx, row in enumerate(rows[:5]):  # Check first 5 rows
            row_text = ' '.join(box.get('text', '').lower() for box in row)
            for header_keyword in SENSITIVE_HEADERS:
                if header_keyword in row_text:
                    return idx, row
        return None, None

    def _map_columns(
        self, header_row: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Create column position → header text mapping."""
        return [
            {
                'x': box['x'],
                'w': box.get('w', 100),
                'text': box.get('text', ''),
            }
            for box in header_row
        ]

    def _find_column_header(
        self, cell: Dict[str, Any], column_headers: List[Dict[str, Any]]
    ) -> Optional[str]:
        """Find which column header a data cell belongs to by X position."""
        cell_x = cell['x']
        best_match = None
        best_distance = float('inf')

        for header in column_headers:
            distance = abs(cell_x - header['x'])
            if distance <= self.x_tolerance and distance < best_distance:
                best_distance = distance
                best_match = header['text']

        return best_match

    @staticmethod
    def _is_sensitive_header(header_text: str) -> bool:
        """Check if a header text matches known sensitive column names."""
        lower = header_text.lower().strip()
        return any(keyword in lower for keyword in SENSITIVE_HEADERS)
