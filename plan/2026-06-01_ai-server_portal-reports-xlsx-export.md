# XLSX Export For Portal Reports

## Problem
The web portal reports module only supports CSV and PDF exports. Users who need native spreadsheet formatting and formulas-compatible files cannot export reports as XLSX.

## Root Cause / Context
- Backend exposes only `GET /api/portal/reports/export/csv` and `GET /api/portal/reports/export/pdf` in `ai-server/src/index.js`.
- `ai-server/src/controllers/portal-reports-controller.js` has export handlers only for CSV/PDF.
- Frontend API wrapper in `ai-server/src/portal/src/api/reports.js` has no XLSX export method.
- Reports UI in `ai-server/src/portal/src/pages/ReportsPage.jsx` has no XLSX action state/button/handler.

## Proposed Solution
- Add a new authenticated backend endpoint `GET /api/portal/reports/export/xlsx`.
- In the reports controller, generate an XLSX workbook from the same report data used by CSV/PDF, with report-type-specific headers and rows.
- Return workbook bytes with correct XLSX content headers and attachment filename pattern `<reportType>-<YYYY-MM-DD>.xlsx`.
- Add frontend API method `reportsApi.exportXLSX(params)` that requests blob data.
- Add an XLSX export button in reports UI, reusing current filters and disabled/loading behavior consistent with CSV/PDF.

## Acceptance Criteria
1. Admin/superadmin users can download report output as `.xlsx` from the Reports page using current filters and report type.
2. The backend returns `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and an `.xlsx` attachment filename for successful XLSX exports.
3. Viewer role receives the same permission denial behavior for XLSX export as other report export endpoints.
4. Missing or unsupported report type for XLSX export returns the same validation behavior pattern as existing export endpoints.
5. The frontend shows an `Export XLSX` action with loading state and triggers file download when the API call succeeds.

## Out Of Scope
- Changing report aggregation logic or adding new report types.
- Styling/custom formatting beyond basic XLSX tabular data.
- Multi-sheet workbook design or formula generation.
- Reworking CSV/PDF export behavior except shared helpers needed to support XLSX.
