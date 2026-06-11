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
  Neutral: '#64748b',
};

function ProductivityDonutChart({ productivePercentage, nonProductivePercentage, productiveHours, nonProductiveHours, neutralHours }) {
  let data;
  if (neutralHours !== undefined) {
    const total = (productiveHours || 0) + (nonProductiveHours || 0) + (neutralHours || 0);
    const pct = (v) => (total > 0 ? ((v || 0) / total) * 100 : 0);
    data = [
      { name: 'Productive', value: pct(productiveHours) },
      { name: 'Non-Productive', value: pct(nonProductiveHours) },
      { name: 'Neutral', value: pct(neutralHours) },
    ];
  } else {
    data = [
      { name: 'Productive', value: productivePercentage || 0 },
      { name: 'Non-Productive', value: nonProductivePercentage || 0 },
    ];
  }

  return (
    <div className="card">
      <h3 className="text-lg font-semibold mb-4">Productivity Split</h3>
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
    </div>
  );
}

export default ProductivityDonutChart;
