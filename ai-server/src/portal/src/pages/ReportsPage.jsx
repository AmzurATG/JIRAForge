/**
 * Reports Page
 * 
 * Generate and export activity reports as CSV or PDF.
 */

import { useState, useEffect } from 'react';
import { FileText, FileDown, File, FileSpreadsheet, ChevronRight, X } from 'lucide-react';
import { reportsApi } from '../api/reports';
import { employeesApi } from '../api/employees';
import DataTable from '../components/common/DataTable';
import DateRangePicker from '../components/common/DateRangePicker';
import LobFilter from '../components/common/LobFilter';
import LocationFilter from '../components/common/LocationFilter';
import EmployeeSelect from '../components/common/EmployeeSelect';
import CategoryBadge from '../components/common/CategoryBadge';
import ErrorBanner from '../components/common/ErrorBanner';
import { formatDate, formatDuration, formatDateTime } from '../utils/formatters';

const REPORT_TYPES = {
  'activity-logs': {
    label: 'Activity Logs',
    description: 'Detailed log of all employee activities with timestamps and applications',
  },
  'daily-summary': {
    label: 'Daily Summary',
    description: 'Aggregated productive and non-productive hours per day',
  },
  'employee-summary': {
    label: 'Employee Summary',
    description: 'Total hours and productivity percentage per employee',
  },
  'application-usage': {
    label: 'Application Usage',
    description: 'Time spent on each application across all employees',
  },
};

// Combined "5.00h (62.0%)" cell — the manager asked for the percentage shown
// beside the hours within the same column.
const hrPct = (hours, pct) => `${(hours ?? 0).toFixed(2)}h (${(pct ?? 0).toFixed(1)}%)`;

// Export responses use responseType:'blob', so a server error body arrives as a
// Blob (not parsed JSON). Read it back to surface the real message instead of a
// generic "Failed to export".
async function getExportError(err, fallback) {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try { return JSON.parse(await data.text()).error || fallback; } catch { return fallback; }
  }
  return data?.error || fallback;
}

function ReportsPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [previewData, setPreviewData] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  // Legal (expected) hours for the period — same for everyone, shown once above
  // the Employee Summary table rather than as a repeated column.
  const [legalHours, setLegalHours] = useState(null);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [exportingCSV, setExportingCSV] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [exportingPDF, setExportingPDF] = useState(false);
  
  // Report type
  const [reportType, setReportType] = useState('activity-logs');
  
  // Filters
  const [classification, setClassification] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [lobId, setLobId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Refinement filters beyond report type + date range. Surfaced as a count so
  // the user knows filters are applied even while the advanced section is collapsed.
  const activeFilterCount = [classification, selectedEmployee, lobId, locationId].filter(Boolean).length;

  // Employee list for filter
  const [employees, setEmployees] = useState([]);
  
  // Default to today (shown as the "Today" preset in the picker)
  const [dateRange, setDateRange] = useState(() => {
    const today = formatDate(new Date());
    return { from: today, to: today };
  });

  useEffect(() => {
    loadEmployees();
  }, [lobId, locationId]);

  const loadEmployees = async () => {
    try {
      const response = await employeesApi.getSimpleList(undefined, lobId || undefined, locationId || undefined);
      setEmployees(response.data || []);
    } catch (err) {
      console.error('Failed to load employees:', err);
    }
  };

  const handleGeneratePreview = async (newPage = 1) => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await reportsApi.getData({
        type: reportType,
        classification: classification || undefined,
        employee: selectedEmployee || undefined,
        lobId: lobId || undefined,
        locationId: locationId || undefined,
        from: dateRange.from,
        to: dateRange.to,
        page: newPage,
        limit: limit,
      });
      
      setPreviewData(response.data || []);
      setTotalCount(response.totalCount || 0);
      setLegalHours(response.legalHours ?? null);
      setPage(newPage);
    } catch (err) {
      console.error('Failed to generate report preview:', err);
      setError(err.response?.data?.error || 'Failed to generate report preview');
    } finally {
      setLoading(false);
    }
  };

  const handlePageChange = (newPage) => {
    handleGeneratePreview(newPage);
  };

  // Reset the refinement filters (not report type / date range) and invalidate
  // the current preview so the user re-generates against the cleared filters.
  const handleClearFilters = () => {
    setClassification('');
    setSelectedEmployee('');
    setLobId('');
    setLocationId('');
    setPreviewData([]);
    setPage(1);
  };

  const handleExportCSV = async () => {
    setExportingCSV(true);
    setError(null);
    
    try {
      const blob = await reportsApi.exportCSV({
        type: reportType,
        classification: classification || undefined,
        employee: selectedEmployee || undefined,
        lobId: lobId || undefined,
        locationId: locationId || undefined,
        from: dateRange.from,
        to: dateRange.to,
      });
      
      // Create download link
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const timestamp = new Date().toISOString().split('T')[0];
      link.setAttribute('download', `${reportType}-${timestamp}.csv`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      
    } catch (err) {
      console.error('Failed to export CSV:', err);
      setError(await getExportError(err, 'Failed to export CSV'));
    } finally {
      setExportingCSV(false);
    }
  };

  const handleExportExcel = async () => {
    setExportingExcel(true);
    setError(null);

    try {
      const blob = await reportsApi.exportExcel({
        type: reportType,
        classification: classification || undefined,
        employee: selectedEmployee || undefined,
        lobId: lobId || undefined,
        locationId: locationId || undefined,
        from: dateRange.from,
        to: dateRange.to,
      });

      // Create download link
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const timestamp = new Date().toISOString().split('T')[0];
      link.setAttribute('download', `${reportType}-${timestamp}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);

    } catch (err) {
      console.error('Failed to export Excel:', err);
      setError(await getExportError(err, 'Failed to export Excel'));
    } finally {
      setExportingExcel(false);
    }
  };

  const handleExportPDF = async () => {
    setExportingPDF(true);
    setError(null);
    
    try {
      const blob = await reportsApi.exportPDF({
        type: reportType,
        classification: classification || undefined,
        employee: selectedEmployee || undefined,
        lobId: lobId || undefined,
        locationId: locationId || undefined,
        from: dateRange.from,
        to: dateRange.to,
      });
      
      // Create download link
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const timestamp = new Date().toISOString().split('T')[0];
      link.setAttribute('download', `${reportType}-${timestamp}.pdf`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      
    } catch (err) {
      console.error('Failed to export PDF:', err);
      setError(await getExportError(err, 'Failed to export PDF'));
    } finally {
      setExportingPDF(false);
    }
  };

  // Dynamic columns based on report type
  const getColumns = () => {
    switch (reportType) {
      case 'daily-summary':
        // Each category shows hours + its % of total tracked time; the single
        // Productivity % column is replaced. "Neutral" surfaced as "Unknown".
        return [
          { key: 'date', label: 'Date', sortable: true },
          { key: 'productiveHours', label: 'Productive', sortable: true, render: (v, r) => hrPct(v, r.productivePct) },
          { key: 'nonProductiveHours', label: 'Non-Productive', sortable: true, render: (v, r) => hrPct(v, r.nonProductivePct) },
          { key: 'unknownHours', label: 'Unknown', sortable: true, render: (v, r) => hrPct(v, r.unknownPct) },
          { key: 'idleHours', label: 'Idle', sortable: true, render: (v, r) => hrPct(v, r.idlePct) },
          { key: 'totalHours', label: 'Total Hours', sortable: true, render: (v) => v?.toFixed(2) || '0.00' },
        ];
      case 'employee-summary':
        // Per-category hours+% plus Legal/Tracked/Attainment (the monthly view).
        return [
          { key: 'employeeName', label: 'Employee', sortable: true },
          { key: 'employeeEmail', label: 'Email', sortable: true },
          { key: 'productiveHours', label: 'Productive', sortable: true, render: (v, r) => hrPct(v, r.productivePct) },
          { key: 'nonProductiveHours', label: 'Non-Productive', sortable: true, render: (v, r) => hrPct(v, r.nonProductivePct) },
          { key: 'unknownHours', label: 'Unknown', sortable: true, render: (v, r) => hrPct(v, r.unknownPct) },
          { key: 'idleHours', label: 'Idle', sortable: true, render: (v, r) => hrPct(v, r.idlePct) },
          { key: 'trackedHours', label: 'Tracked Hrs', sortable: true, render: (v) => v?.toFixed(2) || '0.00' },
          { key: 'attainmentPct', label: 'Attainment %', sortable: true, render: (v) => `${v?.toFixed(1) || 0}%` },
        ];
      case 'application-usage':
        return [
          { key: 'application', label: 'Application', sortable: true },
          { key: 'totalHours', label: 'Total Hours', sortable: true, render: (v) => v?.toFixed(2) || '0.00' },
          { key: 'sessionCount', label: 'Session Count', sortable: true },
          { key: 'employeeCount', label: 'Employees', sortable: true },
          { key: 'employees', label: 'Employee Names', sortable: false, render: (v) => v || 'N/A' },
        ];
      default: // activity-logs
        return [
          { key: 'userName', label: 'Employee', sortable: true },
          { key: 'startTime', label: 'Start Time', sortable: true, render: (value) => formatDateTime(value) },
          { key: 'endTime', label: 'End Time', sortable: true, render: (value) => formatDateTime(value) },
          { key: 'application', label: 'Application', sortable: true },
          { key: 'durationSeconds', label: 'Duration', sortable: true, render: (value) => formatDuration(value) },
          {
            key: 'classification',
            label: 'Classification',
            sortable: true,
            render: (value, row) => <CategoryBadge value={row.category || value} />,
          },
        ];
    }
  };

  const columns = getColumns();

  return (
    <div className="space-y-3">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="text-gray-500 dark:text-gray-400 text-xs mt-0.5">Generate and export productivity reports</p>
        </div>
        {/* Export controls — one segmented "Export as" group so the three
            formats read as a single related action instead of three clashing
            colored buttons. Each segment keeps a format-colored icon. */}
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline text-xs font-medium text-gray-500 dark:text-gray-400">
            Export as
          </span>
          <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden divide-x divide-gray-200 dark:divide-gray-700">
            <button
              onClick={handleExportCSV}
              disabled={exportingCSV}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Export as CSV"
            >
              <FileDown className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              {exportingCSV ? 'CSV…' : 'CSV'}
            </button>
            <button
              onClick={handleExportExcel}
              disabled={exportingExcel}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Export as Excel"
            >
              <FileSpreadsheet className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              {exportingExcel ? 'Excel…' : 'Excel'}
            </button>
            <button
              onClick={handleExportPDF}
              disabled={exportingPDF}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Export as PDF"
            >
              <File className="w-4 h-4 text-red-600 dark:text-red-400" />
              {exportingPDF ? 'PDF…' : 'PDF'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <ErrorBanner message={error} onClose={() => setError(null)} />
      )}

      {/* Report Configuration */}
      <div className="card-elevated">
        <div className="flex items-center justify-between mb-3">
          <h3 className="section-title">
            <div className="p-1 bg-primary-100 dark:bg-primary-900/30 rounded">
              <FileText className="w-3 h-3 text-primary-600 dark:text-primary-400" />
            </div>
            Report Configuration
          </h3>
          {activeFilterCount > 0 && (
            <button
              onClick={handleClearFilters}
              className="text-xs text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 font-medium flex items-center gap-1"
            >
              <X className="w-3 h-3" /> Clear filters
            </button>
          )}
        </div>

        <div className="space-y-3">
          {/* Primary: what to report on + the period to export */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Report Type Filter */}
            <div>
              <label className="filter-label text-xs">Report Type</label>
              <select
                value={reportType}
                onChange={(e) => {
                  setReportType(e.target.value);
                  setPreviewData([]);
                  setPage(1);
                }}
                className="select-field"
              >
                {Object.entries(REPORT_TYPES).map(([key, { label }]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400 leading-snug">
                {REPORT_TYPES[reportType]?.description}
              </p>
            </div>

            {/* Date Range */}
            <div>
              <label className="filter-label text-xs">Date Range</label>
              <DateRangePicker
                from={dateRange.from}
                to={dateRange.to}
                onChange={(r) => { setDateRange(r); setPreviewData([]); setPage(1); }}
              />
            </div>
          </div>

          {/* Advanced refinement filters — collapsed by default so the common
              flow (pick report + period → generate) stays uncluttered. The
              count badge keeps applied filters visible while collapsed. */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
              More filters
              {activeFilterCount > 0 && (
                <span className="badge-info">{activeFilterCount}</span>
              )}
            </button>

            {showAdvanced && (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                {/* Classification Filter */}
                <div>
                  <label className="filter-label text-xs">Classification</label>
                  <select
                    value={classification}
                    onChange={(e) => { setClassification(e.target.value); setPreviewData([]); setPage(1); }}
                    className="select-field"
                  >
                    <option value="">All Classifications</option>
                    <option value="productive">Productive</option>
                    <option value="non-productive">Non-Productive</option>
                    <option value="neutral">Unknown</option>
                  </select>
                </div>

                {/* Employee Filter — searchable (type to filter as you go) */}
                <div>
                  <label className="filter-label text-xs">Employee</label>
                  <EmployeeSelect
                    employees={employees}
                    value={selectedEmployee}
                    onChange={(v) => { setSelectedEmployee(v); setPreviewData([]); setPage(1); }}
                  />
                </div>

                {/* LOB Filter */}
                <LobFilter value={lobId} onChange={(v) => { setLobId(v); setSelectedEmployee(''); setPreviewData([]); setPage(1); }} />

                {/* Location Filter */}
                <LocationFilter value={locationId} onChange={(v) => { setLocationId(v); setSelectedEmployee(''); setPreviewData([]); setPage(1); }} />
              </div>
            )}
          </div>

          {/* Generate Button — explicit page 1 (passing the raw click event
              would corrupt the page param/state) */}
          <button
            onClick={() => handleGeneratePreview(1)}
            disabled={loading}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Generating Preview...
              </>
            ) : (
              'Generate Preview'
            )}
          </button>
        </div>
      </div>

      {/* Preview */}
      {previewData.length > 0 && (
        <div className="card">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="section-title">Report Preview</h3>
            </div>
            <div className="badge-info">
              {REPORT_TYPES[reportType]?.label}
            </div>
          </div>

          {/* Legal hours is the same for everyone over the period — shown once
              here instead of as a repeated column. */}
          {reportType === 'employee-summary' && legalHours != null && (
            <div className="mb-3 inline-flex items-center gap-2 rounded-lg bg-primary-50 dark:bg-primary-900/20 border border-primary-100 dark:border-primary-800 px-3 py-1.5">
              <span className="text-xs text-gray-500 dark:text-gray-400">Legal hours this period</span>
              <span className="text-sm font-semibold text-primary-700 dark:text-primary-300">{legalHours.toFixed(2)}</span>
            </div>
          )}

          <DataTable
            columns={columns}
            data={previewData}
            loading={loading}
            emptyMessage="No data available for the selected filters"
            pagination={{
              page: page,
              limit: limit,
              totalCount: totalCount,
              onPageChange: handlePageChange,
            }}
          />
        </div>
      )}

      {!loading && previewData.length === 0 && (
        <div className="card text-center py-16">
          <div className="w-20 h-20 mx-auto mb-6 bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-700 dark:to-gray-800 rounded-2xl flex items-center justify-center">
            <FileText className="w-10 h-10 text-gray-400 dark:text-gray-500" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
            No Preview Generated
          </h3>
          <p className="text-gray-500 dark:text-gray-400 max-w-md mx-auto">
            Configure your report filters above and click "Generate Preview" to see the data before exporting.
          </p>
        </div>
      )}
    </div>
  );
}

export default ReportsPage;
