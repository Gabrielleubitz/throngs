/** Path allowance for the PreToolUse guard (see hookGuard in sm.js). */
const fs = require('fs');
const path = require('path');

// Directories under the success-manager root that workers may Edit/Write.
// NOT time-limited: it stays until someone removes this constant (owner request, mission m-mvquot9c).
// lat.md = the shared brain (workers must keep it true), office-layout = the floor plan generator.
const WORKER_EDITABLE_DIRS = ['bin', 'test', 'pixel-office', 'lat.md', 'office-layout'];

// realpath of the nearest existing ancestor + the not-yet-existing remainder (so new files and symlinks resolve).
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch {}
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    rest.push(path.basename(cur));
    cur = up;
  }
}

function isWorkerEditable(root, target) {
  const real = realish(target);
  const realRoot = realish(root);
  return WORKER_EDITABLE_DIRS.some((d) => real.startsWith(path.join(realRoot, d) + path.sep));
}

module.exports = { WORKER_EDITABLE_DIRS, isWorkerEditable, realish };
