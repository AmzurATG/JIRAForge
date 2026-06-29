const express = require('express');
const app = express();
const desktopDqNudgesController = require('./src/controllers/desktop-dq-nudges-controller');
const desktopDqPreferencesController = require('./src/controllers/desktop-dq-preferences-controller');

app.use('/api/desktop/description-quality-nudges', desktopDqNudgesController);
app.use('/api/desktop/preferences/dq-nudges', desktopDqPreferencesController);

console.log("ROUTES:");
app._router.stack.forEach(function(r){
  if (r.name === 'router') {
    console.log("Router mounted at:", r.regexp);
    r.handle.stack.forEach(function(handler){
      if (handler.route) {
        console.log("  ", Object.keys(handler.route.methods), handler.route.path);
      }
    });
  }
});
