/**
 * LobFilter — dropdown of LOBs the caller may see.
 *
 * superadmin → all LOBs (+ "All LOBs"); head → their LOBs (+ "All my LOBs").
 * Emits the selected lobId ('' = all) via onChange. Hidden when the caller has
 * no LOBs to choose from. Backed by GET /api/portal/lobs, which is already
 * scoped server-side.
 */

import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { lobsApi } from '../../api/lobs';
import { useAuth } from '../../contexts/AuthContext';

function LobFilter({ value, onChange }) {
  const { user } = useAuth();
  const [lobs, setLobs] = useState([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await lobsApi.list();
        if (active) setLobs(res.data || []);
      } catch {
        if (active) setLobs([]);
      }
    })();
    return () => { active = false; };
  }, []);

  if (lobs.length === 0) return null;

  const allLabel = user?.role === 'superadmin' ? 'All LOBs' : 'All my LOBs';

  return (
    <div>
      <label className="filter-label text-xs flex items-center gap-1">
        <Building2 className="w-3 h-3" /> Line of Business
      </label>
      <select value={value || ''} onChange={(e) => onChange(e.target.value)} className="select-field">
        <option value="">{allLabel}</option>
        {lobs.map((lob) => (
          <option key={lob.id} value={lob.id}>{lob.name}</option>
        ))}
      </select>
    </div>
  );
}

export default LobFilter;
