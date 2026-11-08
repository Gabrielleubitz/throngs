'use strict';
/** First-run onboarding state (office/onboarding/state.json) and the intro video the onboarding screen plays. */
const fs = require('fs');
const path = require('path');

function createOnboarding(root) {
  const dir = path.join(root, 'office', 'onboarding');
  const stateFile = path.join(dir, 'state.json');
  const videoFile = path.join(dir, 'throngs-demo.mp4');
  const load = () => { try { const j = JSON.parse(fs.readFileSync(stateFile, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
  const status = () => { const s = load(); return { done: !!s.done, doneAt: s.doneAt || null, hasVideo: fs.existsSync(videoFile) }; };
  function complete() { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify({ done: true, doneAt: new Date().toISOString() })); return status(); }
  function reset() { try { fs.unlinkSync(stateFile); } catch { /* none */ } return status(); }
  function video() {
    let st; try { st = fs.statSync(videoFile); } catch { throw Object.assign(new Error('intro video missing'), { status: 404 }); }
    return { file: videoFile, type: 'video/mp4', size: st.size };
  }
  return { status, complete, reset, video };
}

module.exports = { createOnboarding };
