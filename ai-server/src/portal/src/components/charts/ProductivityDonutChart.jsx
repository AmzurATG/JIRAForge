/**
 * ProductivityDonutChart Component
 * 
 * Displays a donut chart showing productive vs non-productive percentage.
 */

import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';

function ProductivityDonutChart({ productivePercentage, nonProductivePercentage }) {
  const data = [
    { name: 'Productive', value: productivePercentage || 0 },
    { name: 'Non-Productive', value: nonProductivePercentage || 0 },
  ];

  const COLORS = ['#10b981', '#ef4444'];

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
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
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
