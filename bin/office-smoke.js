#!/usr/bin/env node
/**
 * Office smoke test (part of OFFICE_QA): the office must actually RUN, not just compile — load the
 * state the dashboard polls for every project, plus the roster, folders and ideas. Exit 1 on any error.
 */
const sm = require('./sm.js');
const api = require('./sm-api.js').createApi(sm);
let failed = 0;
const check = (label, fn) => {
  try { fn(); console.log(`ok   ${label}`); } catch (e) { failed++; console.log(`FAIL ${label}: ${e.stack.split('\n').slice(0, 3).join(' | ')}`); }
};
check('projects', () => api.projects());
check('staff', () => { if (!api.staff.list().staff.length) throw new Error('empty roster'); });
check('folders', () => api.folders());
for (const name of sm.listProjects()) {
  check(`state(${name})`, () => {
    const s = api.state(name);
    for (const k of ['agents', 'tasks', 'missions', 'questions', 'events', 'reports', 'staff', 'ideas']) if (!(k in s)) throw new Error(`state missing "${k}"`);
  });
}
process.exit(failed ? 1 : 0);
