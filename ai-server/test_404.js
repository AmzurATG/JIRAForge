const express = require('express');
const app = express();
const desktopDqNudgesController = require('./src/controllers/desktop-dq-nudges-controller');

// Mock auth middleware
const desktopAuthMiddleware = (req, res, next) => {
  req.atlassianUser = { account_id: 'test_account_id' };
  next();
};

app.use('/api/desktop/description-quality-nudges', desktopAuthMiddleware, desktopDqNudgesController);

app.use('*', (req, res) => {
  res.status(404).json({ success: false, error: 'Catch-all 404' });
});

app.listen(31234, async () => {
  const http = require('http');
  http.get('http://localhost:31234/api/desktop/description-quality-nudges', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log('GET /:', res.statusCode, data);
      
      const options = {
        hostname: 'localhost',
        port: 31234,
        path: '/api/desktop/description-quality-nudges/sync-recent-unassigned',
        method: 'POST'
      };
      const req = http.request(options, (res2) => {
        let data2 = '';
        res2.on('data', chunk => data2 += chunk);
        res2.on('end', () => {
          console.log('POST /sync-recent-unassigned:', res2.statusCode, data2);
          process.exit(0);
        });
      });
      req.end();
    });
  });
});
