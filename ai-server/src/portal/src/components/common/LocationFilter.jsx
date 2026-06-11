/**
 * LocationFilter — dropdown of employee locations (WS-B).
 *
 * Mirrors LobFilter: hidden when no locations exist, emits the selected
 * locationId ('' = all) via onChange. Works for every role — unlike the LOB
 * filter it is a pure data filter, applied server-side regardless of
 * PORTAL_LOB_ENFORCEMENT.
 */

import { useEffect, useState } from 'react';
import { MapPin } from 'lucide-react';
import { locationsApi } from '../../api/locations';

function LocationFilter({ value, onChange }) {
  const [locations, setLocations] = useState([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await locationsApi.list();
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
        <MapPin className="w-3 h-3" /> Location
      </label>
      <select value={value || ''} onChange={(e) => onChange(e.target.value)} className="select-field">
        <option value="">All Locations</option>
        {locations.map((loc) => (
          <option key={loc.id} value={loc.id}>{loc.name}</option>
        ))}
      </select>
    </div>
  );
}

export default LocationFilter;
