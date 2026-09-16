const path = require('node:path');

/**
 * Root directory for static assets (dashboard HTML, legal pages, feedback form,
 * built portal). Local `node src/index.js` uses `src/`. The Docker runtime
 * image sets ASSET_ROOT=/app/assets so bundled server.js does not need `src/`.
 */
function getAssetRoot() {
  if (process.env.ASSET_ROOT) {
    return process.env.ASSET_ROOT;
  }
  return path.join(__dirname, '..');
}

module.exports = { getAssetRoot };
