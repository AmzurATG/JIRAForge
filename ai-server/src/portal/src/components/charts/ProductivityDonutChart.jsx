/**
 * ProductivityDonutChart Component
 *
 * Distribution of ACTIVE time across the canonical categories (AC-C2):
 * productive / non-productive / neutral. The neutral segment renders only
 * when neutral data is available (i.e. the 20260610 category-breakdown
 * migration is applied); otherwise the chart falls back to the original
 * two-segment percentage view.
 */

import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';

const COLORS = {
  Productive: '#10b981',
  'Non-Productive': '#ef4444',
  Unknown: '#64748b',
};

function ProductivityDonutChart({ productivePercentage, nonProductivePercentage, productiveHours, nonProductiveHours, neutralHours }) {
  let data;
  if (neutralHours !== undefined) {
    const total = (productiveHours || 0) + (nonProductiveHours || 0) + (neutralHours || 0);
    const pct = (v) => (total > 0 ? ((v || 0) / total) * 100 : 0);
    data = [
      { name: 'Productive', value: pct(productiveHours) },
      { name: 'Non-Productive', value: pct(nonProductiveHours) },
      { name: 'Unknown', value: pct(neutralHours) },
    ];
  } else {
    data = [
      { name: 'Productive', value: productivePercentage || 0 },
      { name: 'Non-Productive', value: nonProductivePercentage || 0 },
    ];
  }

  if (data.every((d) => !d.value)) {
    return (
      <div className="h-64 flex items-center justify-center text-gray-500 dark:text-gray-400">
        No data available for the selected period
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={60}
          outerRadius={100}
          fill="#8884d8"
          dataKey="value"
          label={({ name, value }) => `${name}: ${value.toFixed(1)}%`}
        >
          {data.map((entry) => (
            <Cell key={entry.name} fill={COLORS[entry.name]} />
          ))}
        </Pie>
        <Tooltip formatter={(value) => `${value.toFixed(1)}%`} />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
}

export default ProductivityDonutChart;
