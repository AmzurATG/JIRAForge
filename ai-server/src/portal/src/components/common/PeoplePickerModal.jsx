/**
 * PeoplePickerModal — searchable multi-select of people (employees/admins).
 *
 * Extracted from LobDetailPage so the same picker drives LOB member/head
 * assignment AND location member assignment (Settings → Locations). Caller
 * supplies fetchPeople(search) → [{id, name, email}] and onAdd(selectedIds).
 */

import { useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { useDebounce } from '../../hooks/useDebounce';

function PeoplePickerModal({ title, fetchPeople, onAdd, onClose, setError }) {
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search, 400);
  const [people, setPeople] = useState([]);
  const [selected, setSelected] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      try {
        const list = await fetchPeople(debounced);
        if (active) setPeople(list);
      } catch (err) {
        if (active) setError(err.response?.data?.error || 'Failed to load people');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
    // fetchPeople/setError are intentionally NOT dependencies: callers pass
    // inline closures (new identity on every parent render), which would
    // re-fire this fetch on unrelated parent re-renders. The closures only
    // capture stable values (api modules, ids), so the copy captured at
    // search-change time is always equivalent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const toggle = (id) => setSelected((s) => ({ ...s, [id]: !s[id] }));
  const selectedIds = Object.keys(selected).filter((id) => selected[id]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-lg w-full mx-4">
        <h3 className="text-lg font-semibold mb-3">{title}</h3>
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input-field pl-10"
            autoFocus
          />
        </div>
        <div className="max-h-72 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded">
          {loading ? (
            <p className="p-4 text-sm text-gray-500">Loading…</p>
          ) : people.length === 0 ? (
            <p className="p-4 text-sm text-gray-500">No people found</p>
          ) : (
            people.map((p) => (
              <label key={p.id} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer border-b border-gray-100 dark:border-gray-700/50">
                <input type="checkbox" checked={!!selected[p.id]} onChange={() => toggle(p.id)} className="w-4 h-4" />
                <span className="text-sm">
                  <span className="font-medium">{p.name || p.email}</span>
                  {p.email && <span className="text-gray-500"> · {p.email}</span>}
                </span>
              </label>
            ))
          )}
        </div>
        <div className="flex gap-2 justify-end mt-4">
          {/* Explicit type — buttons default to submit and this shared modal
              must stay safe if a caller ever renders it inside a form. */}
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            type="button"
            disabled={selectedIds.length === 0}
            onClick={() => onAdd(selectedIds)}
            className="btn-primary"
          >
            Add {selectedIds.length || ''}
          </button>
        </div>
      </div>
    </div>
  );
}

export default PeoplePickerModal;
