/**
 * DailyLineChart Component
 *
 * Daily activity breakdown for the employee detail page: stacked bars of
 * hours per canonical category (productive / non-productive / neutral /
 * idle) with the productivity % overlaid as a line on a second axis — shows
 * volume AND quality at a glance, and renders sensibly for single-day
 * ranges (a bar instead of a lone dot).
 *
 * Colors match CategoryBadge / the KPI cards. Rendered inside the page's
 * card, so no extra card wrapper here.
 */

import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

const HOUR_SERIES = [
  { key: 'productiveHours', name: 'Productive', color: '#10b981' },
  { key: 'nonProductiveHours', name: 'Non-Productive', color: '#ef4444' },
  { key: 'neutralHours', name: 'Unknown', color: '#64748b' },
  { key: 'idleHours', name: 'Idle', color: '#9ca3af' },
];

function DailyLineChart({ data }) {
  if (!data || data.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-gray-500 dark:text-gray-400">
        No data available for the selected period
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="date" />
        <YAxis yAxisId="hours" label={{ value: 'Hours', angle: -90, position: 'insideLeft' }} />
        <YAxis yAxisId="pct" orientation="right" domain={[0, 100]} label={{ value: 'Productivity %', angle: 90, position: 'insideRight' }} />
        <Tooltip
          formatter={(value, name) =>
            name === 'Productivity %'
              ? `${Number(value).toFixed(1)}%`
              : `${Number(value).toFixed(2)} h`
          }
        />
        <Legend />
        {HOUR_SERIES.map((s) => (
          <Bar key={s.key} yAxisId="hours" dataKey={s.key} stackId="time" name={s.name} fill={s.color} maxBarSize={48} />
        ))}
        <Line
          yAxisId="pct"
          type="monotone"
          dataKey="productivityPercentage"
          name="Productivity %"
          stroke="#6366f1"
          strokeWidth={2}
          dot={{ fill: '#6366f1' }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export default DailyLineChart;
