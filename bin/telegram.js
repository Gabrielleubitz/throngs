'use strict';
/**
 * Telegram transport for IVY (the Zoo's "telegram" integration: bot_token + default_chat_id = the owner's chat).
 * Long polling (getUpdates), so no public URL is needed; the update offset is saved so a restart never replays
 * messages. Plain text only (no parse_mode: nothing to escape). The token is never logged or returned.
 */
const fs = require('fs');
const path = require('path');

const bad = (m, status = 400) => Object.assign(new Error(m), { status });

function createTelegram(root, { integrations, fetchFn = globalThis.fetch, pollTimeoutSec = 25 } = {}) {
  const I = integrations || require('./integrations.js').createIntegrations(root);
  const file = path.join(root, 'office', 'telegram.json');
  const cfg = () => { const c = (() => { try { return I.get('telegram') || {}; } catch { return {}; } })(); return { token: c.bot_token || '', chat: String(c.default_chat_id || '').trim() }; };
  const linked = () => { const c = cfg(); return !!(c.token && c.chat); };
  let stopped = true; let loop = null;

  async function api(method, body, { timeoutMs = 15000 } = {}) {
    const c = cfg(); if (!c.token) throw bad('Link Telegram first (Zoo → Telegram the Penguin).', 503);
    const r = await fetchFn(`https://api.telegram.org/bot${c.token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw bad(`Telegram said ${j.error_code || r.status}: ${j.description || 'error'}`, j.error_code === 409 ? 409 : 502);
    return j.result;
  }

  /**
   * Send to the owner (or `chatId`). Long texts are split at 4000 chars. Returns the last message id.
   * markup: Telegram reply_markup — `keyboard()` (the button bar), `inline([[{text,data}]])`, or `{ force_reply: true }`.
   */
  async function send(text, { chatId, replyTo, markup } = {}) {
    const c = cfg(); const to = chatId || c.chat; if (!to) throw bad('Telegram has no default_chat_id (the owner\'s chat).', 503);
    const t = String(text || '').trim(); if (!t) throw bad('Nothing to send.');
    let id = null;
    for (let i = 0; i < t.length; i += 4000) {
      const last = i + 4000 >= t.length;
      const m = await api('sendMessage', { chat_id: to, text: t.slice(i, i + 4000), disable_web_page_preview: true, ...(replyTo && i === 0 ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}), ...(markup && last ? { reply_markup: markup } : {}) });
      id = m.message_id;
    }
    return { messageId: id };
  }
  /** Buttons under one message; `data` comes back as a button press (max 64 bytes). */
  const inline = (rows) => ({ inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: String(b.data).slice(0, 64) }))) });
  /** The persistent button bar under the chat input. */
  const keyboard = (rows) => ({ keyboard: rows.map((r) => r.map((text) => ({ text }))), resize_keyboard: true, is_persistent: true });
  /** The "/" menu Telegram shows while typing. */
  const setCommands = (list) => api('setMyCommands', { commands: list.map(([command, description]) => ({ command, description })) });
  const answerButton = (id, text) => api('answerCallbackQuery', { callback_query_id: id, ...(text ? { text: String(text).slice(0, 190) } : {}) }).catch(() => {});
  const editButtons = (messageId, markup) => api('editMessageReplyMarkup', { chat_id: cfg().chat, message_id: messageId, reply_markup: markup || { inline_keyboard: [] } }).catch(() => {});
  /** An audio file (e.g. a voicemail mp3) with a caption. */
  async function sendAudio(buf, { caption = '', filename = 'voicemail.mp3', chatId } = {}) {
    const c = cfg(); if (!c.token) throw bad('Link Telegram first.', 503);
    const form = new FormData(); form.append('chat_id', String(chatId || c.chat)); if (caption) form.append('caption', String(caption).slice(0, 1000));
    form.append('audio', new Blob([buf], { type: 'audio/mpeg' }), filename);
    const r = await fetchFn(`https://api.telegram.org/bot${c.token}/sendAudio`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => ({})); if (!j.ok) throw bad(`Telegram said ${j.error_code || r.status}: ${j.description || 'error'}`, 502);
    return { messageId: j.result.message_id };
  }
  const typing = (chatId) => api('sendChatAction', { chat_id: chatId || cfg().chat, action: 'typing' }).catch(() => {});

  const readOffset = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).offset || 0; } catch { return 0; } };
  const writeOffset = (o) => { let d = {}; try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new */ } d.offset = o; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(d, null, 1)); } catch { /* best effort */ } };

  /**
   * Long-poll for messages. Only the owner's chat reaches `onMessage({ text, messageId, replyTo, kind })`; anyone else
   * gets one polite line. kind: 'text' | 'voice' | 'other'. Errors back off (a 409 = another poller holds the bot).
   */
  function start(onMessage, { onError } = {}) {
    if (!stopped) return; stopped = false;
    loop = (async () => {
      let wait = 1000;
      while (!stopped) {
        if (!linked()) { await sleep(30000); continue; }
        try {
          const ups = await api('getUpdates', { offset: readOffset(), timeout: pollTimeoutSec, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: (pollTimeoutSec + 10) * 1000 });
          wait = 1000;
          for (const u of ups || []) {
            writeOffset(u.update_id + 1);
            const cb = u.callback_query;
            if (cb) { // a button press under one of her messages
              if (String(cb.message?.chat?.id) !== cfg().chat) { answerButton(cb.id); continue; }
              try { await onMessage({ kind: 'button', data: String(cb.data || ''), messageId: cb.message?.message_id || null, buttonId: cb.id, text: '' }); } catch (e) { onError?.(e); }
              continue;
            }
            const m = u.message; if (!m || !m.chat) continue;
            if (String(m.chat.id) !== cfg().chat) { send('This is a private line.', { chatId: m.chat.id }).catch(() => {}); continue; }
            const kind = m.text ? 'text' : m.voice || m.audio ? 'voice' : 'other';
            try { await onMessage({ text: String(m.text || m.caption || '').trim(), messageId: m.message_id, replyTo: m.reply_to_message?.message_id || null, kind }); } catch (e) { onError?.(e); }
          }
        } catch (e) { onError?.(e); await sleep(wait); wait = Math.min(wait * 2, e.status === 409 ? 120000 : 60000); }
      }
    })();
  }
  const stop = () => { stopped = true; };
  const status = () => ({ linked: linked(), polling: !stopped });
  return { linked, send, sendAudio, typing, inline, keyboard, setCommands, answerButton, editButtons, start, stop, status, api, file };
}
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

module.exports = { createTelegram };
