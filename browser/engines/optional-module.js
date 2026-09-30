'use strict';
/** Helpers for optional (ESM-only) engine packages that may not be installed. */
const fs = require('fs');
const path = require('path');

function moduleInstalled(name) {
  try {
    return module.paths.some((p) => fs.existsSync(path.join(p, name, 'package.json')));
  } catch (_) {
    return false;
  }
}

/** Dynamic import that works from CommonJS for ESM-only packages; null if missing. */
async function importOptional(name) {
  if (!moduleInstalled(name)) return null;
  try {
    return await import(name);
  } catch (_) {
    return null;
  }
}

module.exports = { moduleInstalled, importOptional };
