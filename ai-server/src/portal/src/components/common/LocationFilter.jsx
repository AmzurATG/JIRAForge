/**
 * LocationFilter — dropdown of employee locations (WS-B).
 *
 * Mirrors LobFilter: hidden when no locations exist, emits the selected
 * locationId ('' = all) via onChange. Works for every role — unlike the LOB
 * filter it is a pure data filter, applied server-side regardless of
 * PORTAL_LOB_ENFORCEMENT.
 */

import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { locationsApi } from '../../api/locations';

function LocationFilter({ value, onChange }) {
  const [locations, setLocations] = useState([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        // Include inactive: employees can stay assigned to a retired location,
        // so it must remain filterable (labeled) — plan §11.2.
        const res = await locationsApi.list({ includeInactive: true });
        if (active) setLocations(res.data || []);
      } catch {
        if (active) setLocations([]);
      }
    })();
    return () => { active = false; };
  }, []);

  if (locations.length === 0) return null;

  return (
    <div>
      <label className="filter-label text-xs flex items-center gap-1">
        <Building2 className="w-3 h-3" /> Branch
      </label>
      <select value={value || ''} onChange={(e) => onChange(e.target.value)} className="select-field">
        <option value="">All Branches</option>
        {locations.map((loc) => (
          <option key={loc.id} value={loc.id}>
            {loc.isActive ? loc.name : `${loc.name} (inactive)`}
          </option>
        ))}
      </select>
    </div>
  );
}

export default LocationFilter;
