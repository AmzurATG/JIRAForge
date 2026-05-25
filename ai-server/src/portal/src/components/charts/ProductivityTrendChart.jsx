/**
 * ProductivityTrendChart Component
 * 
 * Displays a stacked bar chart of productive vs non-productive hours by day.
 */

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

function ProductivityTrendChart({ data }) {
  if (!data || data.length === 0) {
    return (
      <div className="card">
        <h3 className="text-lg font-semibold mb-4">Productivity Trend</h3>
        <div className="h-64 flex items-center justify-center text-gray-500 dark:text-gray-400">
          No data available for the selected period
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h3 className="text-lg font-semibold mb-4">Productivity Trend</h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" />
          <YAxis label={{ value: 'Hours', angle: -90, position: 'insideLeft' }} />
          <Tooltip />
          <Legend />
          <Bar dataKey="productiveHours" stackId="a" fill="#10b981" name="Productive" />
          <Bar dataKey="nonProductiveHours" stackId="a" fill="#ef4444" name="Non-Productive" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default ProductivityTrendChart;
