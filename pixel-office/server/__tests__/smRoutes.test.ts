/**
 * Success Manager bridge: POST /sm/mission/reply.
 *
 * Pins the contract the dashboard relies on — Bearer auth like every other /sm route, and
 * mission.reply's validation errors coming back as HTTP codes. Runs against the real checkout this
 * fork lives in (SM_ROOT = repo root), but only sends requests that are refused before anything is
 * written, so no reply is stored and no Claude run starts.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerSmRoutes } from '../src/sm/smRoutes.js';

const TOKEN = 'test-token';
const SM_ROOT = path.resolve(__dirname, '../../..');
const auth = async (request: FastifyRequest, reply: FastifyReply) => {
  if (request.headers.authorization !== `Bearer ${TOKEN}`) await reply.code(401).send({ error: 'unauthorized' });
};

let app: FastifyInstance;
const post = (payload: Record<string, unknown>, token: string | null = TOKEN) =>
  app.inject({ method: 'POST', url: '/sm/mission/reply', headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TOKEN}` } });

/** First project + mission that already has a report, if the checkout has one. */
async function reported(): Promise<{ project: string; mission: string } | null> {
  for (const p of (await get('/sm/projects')).json() as Array<{ name: string }>) {
    const s = await get(`/sm/state?project=${encodeURIComponent(p.name)}`);
    if (s.statusCode !== 200) continue;
    const r = (s.json() as { reports?: Array<{ id: string }> }).reports?.[0];
    if (r) return { project: p.name, mission: r.id };
  }
  return null;
}

beforeAll(async () => {
  process.env.SM_ROOT = SM_ROOT;
  app = Fastify();
  registerSmRoutes(app, auth);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  delete process.env.SM_ROOT;
});

describe('POST /sm/mission/reply', () => {
  it('is registered behind the same Bearer auth as the other mission routes', async () => {
    expect((await post({ project: 'x', mission: 'm-x', text: 'hi' }, null)).statusCode).toBe(401);
  });

  it('404s for a mission that does not exist', async () => {
    const projects = (await get('/sm/projects')).json() as Array<{ name: string }>;
    if (!projects.length) return;
    const res = await post({ project: projects[0].name, mission: 'm-does-not-exist', text: 'hi' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'No such mission' });
  });

  it('400s on empty or over-long text without storing anything', async () => {
    const target = await reported();
    if (!target) return; // a fresh checkout has no reports yet
    const res = await post({ ...target, text: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Type your reply first.' });
    expect((await post({ ...target, text: 'x'.repeat(4001) })).statusCode).toBe(400);
  });
});
