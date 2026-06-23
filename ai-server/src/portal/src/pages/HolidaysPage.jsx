/**
 * Holidays Page (superadmin)
 *
 * Manage the company-wide holiday list that drives "legal hours" on the
 * monthly report. Modeled on the business holiday calendar: year navigator +
 * cards with a month chip, day number, name and weekday.
 *
 * Plan: plan/2026-06-23_web-productivity-portal_holidays-legal-hours-and-category-percentages.md
 */

import { useState, useEffect } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Edit2, Trash2, Shield } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { holidaysApi } from '../api/holidays';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorBanner from '../components/common/ErrorBanner';
import SuccessBanner from '../components/common/SuccessBanner';
import ConfirmDialog from '../components/common/ConfirmDialog';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// Per-month chip palette (subtle, varied — echoes the reference calendar).
const CHIP_COLORS = [
  'bg-sky-600', 'bg-teal-600', 'bg-slate-500', 'bg-emerald-600', 'bg-amber-600', 'bg-orange-600',
  'bg-cyan-600', 'bg-indigo-600', 'bg-teal-500', 'bg-rose-500', 'bg-violet-600', 'bg-blue-600',
];

function parseYmd(s) {
  const [y, m, d] = (s || '').split('-').map(Number);
  return { y, m, d };
}
function weekdayName(s) {
  const { y, m, d } = parseYmd(s);
  if (!y) return '';
  return new Date(y, m - 1, d).toLocaleDateString('default', { weekday: 'long' });
}
const monthAbbr = (s) => MONTHS[(parseYmd(s).m || 1) - 1];
const dayNum = (s) => String(parseYmd(s).d || '').padStart(2, '0');
const chipColor = (s) => CHIP_COLORS[(parseYmd(s).m || 1) - 1];

function HolidaysPage() {
  const { user } = useAuth();
  const isSuperadmin = user?.role === 'superadmin';

  const [year, setYear] = useState(() => new Date().getFullYear());
  const [holidays, setHolidays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState('create');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ date: '', name: '', isActive: true });
  const [deleting, setDeleting] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await holidaysApi.list({ year, includeInactive: true });
      setHolidays(res.data || []);
    } catch (err) {
      console.error('Failed to load holidays:', err);
      setError(err.response?.data?.error || 'Failed to load holidays');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  const openCreate = () => {
    setModalMode('create');
    setEditing(null);
    setForm({ date: `${year}-01-01`, name: '', isActive: true });
    setShowModal(true);
  };

  const openEdit = (h) => {
    setModalMode('edit');
    setEditing(h);
    setForm({ date: h.date, name: h.name, isActive: h.isActive });
    setShowModal(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!form.date || !form.name.trim()) {
      setError('Date and name are required');
      return;
    }
    try {
      if (modalMode === 'create') {
        await holidaysApi.create(form.date, form.name.trim());
        setSuccess('Holiday added');
      } else {
        await holidaysApi.update(editing.id, { date: form.date, name: form.name.trim(), isActive: form.isActive });
        setSuccess('Holiday updated');
      }
      setShowModal(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || `Failed to ${modalMode === 'create' ? 'add' : 'update'} holiday`);
    }
  };

  const confirmDelete = async () => {
    setError(null);
    try {
      await holidaysApi.remove(deleting.id);
      setDeleting(null);
      setSuccess('Holiday deleted');
      load();
    } catch (err) {
      setDeleting(null);
      setError(err.response?.data?.error || 'Failed to delete holiday');
    }
  };

  if (!isSuperadmin) {
    return (
      <div className="card text-center py-12">
        <Shield className="w-12 h-12 mx-auto mb-4 text-red-500" />
        <h2 className="text-xl font-semibold mb-2">Access Denied</h2>
        <p className="text-gray-600 dark:text-gray-400">Only superadmin users can manage the holiday list.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header + year navigator */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="page-title flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-primary-600 dark:text-primary-400" /> Holidays
            </h1>
            <p className="text-gray-500 dark:text-gray-400 text-xs mt-0.5">
              Company holidays — used to compute legal hours on the monthly report.
            </p>
          </div>
          <div className="flex items-center gap-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-1 py-0.5">
            <button onClick={() => setYear((y) => y - 1)} className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700" title="Previous year">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-sm font-semibold tabular-nums px-1">{year}</span>
            <button onClick={() => setYear((y) => y + 1)} className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700" title="Next year">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
        <button onClick={openCreate} className="btn-primary flex items-center gap-1.5">
          <Plus className="w-3.5 h-3.5" /> Add Holiday
        </button>
      </div>

      {error && <ErrorBanner message={error} onClose={() => setError(null)} />}
      {success && <SuccessBanner message={success} onClose={() => setSuccess(null)} />}

      {loading ? (
        <div className="flex justify-center items-center h-64"><LoadingSpinner /></div>
      ) : holidays.length === 0 ? (
        <div className="card text-center py-16">
          <CalendarDays className="w-10 h-10 mx-auto mb-4 text-gray-400" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">No holidays for {year}</h3>
          <p className="text-gray-500 dark:text-gray-400">Click “Add Holiday” to create the first one.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {holidays.map((h) => (
            <div
              key={h.id}
              className={`group card flex items-center gap-4 ${h.isActive ? '' : 'opacity-60'}`}
            >
              {/* Month chip */}
              <div className={`flex-shrink-0 w-16 rounded-lg overflow-hidden text-center shadow-sm ${chipColor(h.date)}`}>
                <div className="text-[10px] font-semibold tracking-wider text-white/90 py-0.5">{monthAbbr(h.date)}</div>
                <div className="bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 text-xl font-bold py-1">{dayNum(h.date)}</div>
              </div>
              {/* Name + weekday */}
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-gray-900 dark:text-gray-100 truncate">
                  {h.name}
                  {!h.isActive && <span className="ml-2 text-[10px] uppercase text-gray-400">inactive</span>}
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-400">{weekdayName(h.date)}</p>
              </div>
              {/* Actions */}
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => openEdit(h)} className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700" title="Edit">
                  <Edit2 className="w-4 h-4 text-gray-500" />
                </button>
                <button onClick={() => setDeleting(h)} className="p-1.5 rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30" title="Delete">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">{modalMode === 'create' ? 'Add Holiday' : 'Edit Holiday'}</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="filter-label">Date</label>
                <input
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                  className="input-field"
                  required
                />
              </div>
              <div>
                <label className="filter-label">Holiday Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Republic Day"
                  maxLength={160}
                  className="input-field"
                  required
                />
              </div>
              {modalMode === 'edit' && (
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  />
                  Active (inactive holidays are not counted in legal hours)
                </label>
              )}
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">{modalMode === 'create' ? 'Add' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={!!deleting}
        title="Delete Holiday"
        message={`Delete “${deleting?.name}” (${deleting?.date})? This removes it from legal-hours calculations.`}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
        confirmLabel="Delete"
      />
    </div>
  );
}

export default HolidaysPage;
