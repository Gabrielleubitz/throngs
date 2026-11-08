/** Agents viewer — every crew member (staff + reviewers) with live status, plus rename, appearance, fire and the click switch. */
import { useEffect, useState, useSyncExternalStore } from 'react';

import { CharacterMugShot } from '../components/CharacterMugShot.js';
import { Button } from '../components/ui/Button.js';
import { COLOR_IDS, type Look, LOOK_OPTIONS, sanitizeLook } from '../office/sprites/layers.js';
import { isClickLocked, setClickLocked, subscribeClickLock } from './clickLock.js';
import { CREW, type CrewMember, type CrewState } from './crew.js';
import { smClient,type SmState } from './smClient.js';
import type { SuccessManager } from './useSuccessManager.js';

const STATE_COLOR: Record<CrewState, string> = {
  WORKING: 'var(--color-status-active)',
  BLOCKED: 'var(--color-status-permission)',
  IDLE: 'var(--color-text-muted)',
};
const ORDER: Record<CrewState, number> = { BLOCKED: 0, WORKING: 1, IDLE: 2 };
const field = 'w-full bg-bg-dark border-2 border-border text-text text-2xs p-6 font-pixel outline-none focus:border-accent';
const LOOKS = [0, 1, 2, 3, 4, 5];
const LABEL: Record<string, string> = { base: 'Classic', none: 'None', tophat: 'Top hat', labcoat: 'Lab coat', party: 'Party hat' };
const nice = (id: string) => LABEL[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
const SWATCH = LOOK_OPTIONS.colors as Record<string, string>;
const ISSUES: Array<[keyof Look & ('hair' | 'outfit' | 'hat' | 'accessory'), string, keyof Look | null]> = [
  ['hair', 'Hair style', 'hairColor'], ['outfit', 'Clothing', 'outfitColor'], ['hat', 'Hat', 'hatColor'], ['accessory', 'Accessory', null],
];
const TUNES = [['s', 'Color strength'], ['b', 'Brightness'], ['c', 'Contrast']] as const;

/** Appearance, rename and fire for one agent. Saved through /sm/staff/update and /sm/staff/fire. */
function AgentEditor({ sm, c, core, onWatch }: { sm: SuccessManager; c: CrewMember; core: boolean; onWatch?: (crewId: string) => void }) {
  const [name, setName] = useState(c.name);
  const [palette, setPalette] = useState(c.palette);
  const [hue, setHue] = useState(c.hueShift);
  const [tune, setTune] = useState(c.tune);
  const [look, setLook] = useState<Look>(c.look);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Re-sync the form only when a different agent is opened or their SAVED appearance changes. `c` is a new object on
  // every poll (every few seconds), so depending on it wiped unsaved edits — the "look keeps jumping back" bug.
  const saved = JSON.stringify([c.name, c.palette, c.hueShift, c.tune, c.look]);
  useEffect(() => { setName(c.name); setPalette(c.palette); setHue(c.hueShift); setTune(c.tune); setLook(c.look); }, [c.id, saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const locked = useSyncExternalStore(subscribeClickLock, () => isClickLocked(c.agentId));
  const dirty = name !== c.name || palette !== c.palette || hue !== c.hueShift || tune.s !== c.tune.s || tune.b !== c.tune.b || tune.c !== c.tune.c || JSON.stringify(sanitizeLook(look)) !== JSON.stringify(sanitizeLook(c.look));
  const save = async () => {
    setErr(null); setMsg(null);
    try {
      await smClient.staff.update({ id: c.id, name, palette, hueShift: hue, sat: tune.s, bright: tune.b, contrast: tune.c, look: sanitizeLook(look) });
      setMsg('Saved.'); void sm.refresh();
    } catch (e) { setErr((e as Error).message); }
  };
  const fire = async () => {
    if (!window.confirm(`Fire ${c.name}? They leave the company for good and their desk frees up; their past work stays in the reports.`)) return;
    try { await smClient.staff.fire(c.id); void sm.refresh(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="px-8 pb-8 pt-6 border-t-2 border-border flex flex-col gap-6">
      <label className="text-2xs text-text-muted">Name
        <input className={field} value={name} maxLength={16} onChange={(e) => setName(e.target.value.toUpperCase())} />
      </label>
      <div className="flex gap-8 items-start">
        <CharacterMugShot palette={palette} hueShift={hue} tune={tune} look={look} body size={128} />
        <div className="flex flex-col gap-6 flex-1 min-w-0">
          {ISSUES.map(([field, label, colorField]) => {
            const cur = look[field] ?? (field === 'hat' || field === 'accessory' ? 'none' : 'base');
            const setField = (patch: Partial<Look>) => setLook({ ...look, ...patch });
            return (
              <div key={field} className="text-2xs text-text-muted">
                <div className="flex items-center gap-6">{label}
                  <button className="text-2xs bg-transparent border-0 text-text-muted cursor-pointer underline p-0" onClick={() => { const n = { ...look }; delete n[field]; if (colorField) delete n[colorField]; setLook(n); }}>reset</button>
                </div>
                <div className="flex gap-4 flex-wrap mt-2">
                  {(LOOK_OPTIONS[field] as string[]).map((id) => (
                    <button key={id} title={nice(id)} onClick={() => setField({ [field]: id })} className="border-2 cursor-pointer bg-transparent p-2 text-2xs text-text"
                      style={{ borderColor: id === cur ? 'var(--color-accent-bright)' : 'var(--color-border)' }}>
                      {field === 'outfit' ? nice(id) : <CharacterMugShot palette={palette} hueShift={hue} tune={tune} look={{ ...look, [field]: id }} size={28} />}
                    </button>
                  ))}
                </div>
                {colorField && (
                  <div className="flex gap-2 flex-wrap mt-2">
                    <button title="Original colour" onClick={() => { const n = { ...look }; delete n[colorField]; setLook(n); }} className="border-2 cursor-pointer bg-transparent text-2xs text-text p-2"
                      style={{ borderColor: look[colorField] ? 'var(--color-border)' : 'var(--color-accent-bright)' }}>Auto</button>
                    {COLOR_IDS.map((id) => (
                      <button key={id} title={nice(id)} aria-label={`${label} colour ${nice(id)}`} onClick={() => setField({ [colorField]: id })} className="border-2 cursor-pointer p-0"
                        style={{ width: 16, height: 16, background: SWATCH[id], borderColor: look[colorField] === id ? 'var(--color-accent-bright)' : 'var(--color-border)' }} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <Button size="sm" onClick={() => setLook({})}>Reset all looks</Button>
        </div>
      </div>
      <div className="text-2xs text-text-muted">Base look (skin and body)
        <div className="flex gap-4 mt-2">
          {LOOKS.map((p) => (
            <button key={p} onClick={() => setPalette(p)} className="border-2 cursor-pointer bg-transparent p-2" style={{ borderColor: p === palette ? 'var(--color-accent-bright)' : 'var(--color-border)' }}>
              <CharacterMugShot palette={p} hueShift={hue} tune={tune} look={look} size={32} />
            </button>
          ))}
        </div>
      </div>
      <label className="text-2xs text-text-muted">Color turn: {hue}°
        <input type="range" min={0} max={359} value={hue} onChange={(e) => setHue(Number(e.target.value))} className="w-full" />
      </label>
      {TUNES.map(([k, label]) => (
        <label key={k} className="text-2xs text-text-muted">{label}: {tune[k]}
          <input type="range" min={-100} max={100} value={tune[k]} onChange={(e) => setTune({ ...tune, [k]: Number(e.target.value) })} className="w-full" />
        </label>
      ))}
      {err && <div className="text-2xs" style={{ color: 'var(--color-status-permission)' }}>{err}</div>}
      {msg && <div className="text-2xs text-text-muted">{msg}</div>}
      <div className="flex gap-6 flex-wrap">
        <Button size="sm" disabled={!dirty || !name.trim()} onClick={save}>Save</Button>
        <Button size="sm" onClick={() => setClickLocked(c.agentId, !locked)} title="Switches clicks on this agent off or on in the office — nothing is deleted">{locked ? 'Allow clicks again' : 'Stop clicks on them'}</Button>
        {onWatch && <Button size="sm" onClick={() => onWatch(c.id)}>Open</Button>}
        <Button size="sm" disabled={core} onClick={fire} title={core ? 'This agent runs a core part of the office: edit or move them, not fire' : 'Fire this agent (asks to confirm)'}>Fire</Button>
      </div>
    </div>
  );
}

export function SmAgents({ sm, s, onWatch }: { sm: SuccessManager; s: SmState; onWatch?: (crewId: string) => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  useSyncExternalStore(subscribeClickLock, () => CREW.filter((c) => isClickLocked(c.agentId)).map((c) => c.id).join());
  const rows = CREW.map((c) => {
    const a = s.agents.find((x) => x.id === c.id);
    return { c, state: a?.state ?? ('IDLE' as CrewState), task: a?.live?.title ?? a?.task ?? '' };
  }).sort((x, y) => ORDER[x.state] - ORDER[y.state]);
  const working = rows.filter((r) => r.state === 'WORKING').length;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-8">
      <div className="text-2xs text-text-muted mb-6">{rows.length} agents · {working} working</div>
      <div className="flex flex-col gap-6">
        {rows.map(({ c, state, task }) => (
          <div key={c.id} className="w-full bg-bg-dark border-2 border-border text-text" style={{ borderLeftColor: STATE_COLOR[state] }}>
            <button onClick={() => setOpenId(openId === c.id ? null : c.id)} title="Edit this agent"
              className="w-full text-left bg-transparent border-0 p-8 cursor-pointer text-text">
              <span className="flex items-center gap-6">
                <CharacterMugShot palette={c.palette} hueShift={c.hueShift} tune={c.tune} look={c.look} size={28} />
                <span className="text-2xs flex-1 min-w-0 truncate">{c.name}{isClickLocked(c.agentId) ? ' · clicks off' : ''}</span>
                <span className="text-2xs px-4 border-2 whitespace-nowrap" style={{ borderColor: STATE_COLOR[state], color: STATE_COLOR[state] }}>{state}</span>
              </span>
              <span className="block text-2xs text-text-muted mt-2">{c.role} · {c.room}</span>
              {task && <span className="block text-2xs mt-2 leading-tight">{task}</span>}
            </button>
            {openId === c.id && <AgentEditor sm={sm} c={c} core={s.staff.staff.find((x) => x.id === c.id)?.locked === true} onWatch={onWatch} />}
          </div>
        ))}
      </div>
    </div>
  );
}
