/**
 * DailyLineChart Component
 * 
 * Displays a line chart showing daily productivity percentage.
 */

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

function DailyLineChart({ data }) {
  if (!data || data.length === 0) {
    return (
      <div className="card">
        <h3 className="text-lg font-semibold mb-4">Daily Productivity Trend</h3>
        <div className="h-64 flex items-center justify-center text-gray-500 dark:text-gray-400">
          No data available for the selected period
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h3 className="text-lg font-semibold mb-4">Daily Productivity Trend</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" />
          <YAxis label={{ value: 'Productivity %', angle: -90, position: 'insideLeft' }} />
          <Tooltip formatter={(value) => `${value.toFixed(1)}%`} />
          <Legend />
          <Line 
            type="monotone" 
            dataKey="productivityPercentage" 
            stroke="#10b981" 
            strokeWidth={2}
            name="Productivity %"
            dot={{ fill: '#10b981' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default DailyLineChart;
