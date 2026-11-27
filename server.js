'use strict';
// ГрибСвязь: сервер без зависимостей (только Node 18+).
// Код входа приходит НЕ в приложение: в Telegram-бота (бесплатно) или SMS через SMS.ru.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const SMSRU = process.env.SMSRU_API_ID || '';
const TG = process.env.TG_BOT_TOKEN || '';
const FIXED = process.env.DEV_FIXED_CODE || ''; // только для проверки на своём компьютере
const SECRET = process.env.SECRET || crypto.randomBytes(16).toString('hex');
const TG_API = process.env.TG_API || 'https://api.telegram.org', SMS_URL = process.env.SMSRU_URL || 'https://sms.ru/sms/send';
const CODE_LEN = 6, TRACKS = ['dawn', 'rain', 'night', 'neon', 'dust'];
// оформление профиля: баннер, рамка аватара, цвет имени, эффект
const LOOK = { b: ['aurora', 'sunset', 'space', 'forest', 'candy', 'gold'], f: ['fire', 'gold', 'rainbow', 'neon'], n: ['fire', 'gold', 'ocean', 'candy'], x: ['spores', 'hearts', 'snow', 'shrooms'] };

let db = { users: {}, sessions: {}, msgs: [], tg: {}, contacts: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch (e) {}
let dirty = false, saving = false;
let gistOK = false; // пока данные не загружены из Gist, в него ничего не пишем
const GH_API = process.env.GH_API || 'https://api.github.com', GH_TOKEN = process.env.GH_TOKEN || '', GIST_ID = process.env.GIST_ID || '';
const ghH = { Authorization: 'Bearer ' + GH_TOKEN, 'User-Agent': 'gribsvyaz', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
const save = () => { dirty = true; };
const useGist = () => !!(process.env.GH_TOKEN && process.env.GIST_ID);
const ready = () => !useGist() || gistOK; // без базы любой вход выглядел бы как «неизвестный» и людей выкидывало бы
// Данные хранятся в файле и, если заданы GH_TOKEN и GIST_ID, в приватном Gist (на бесплатном Render диск стирается).
async function gistLoad() {
  if (!GH_TOKEN || !GIST_ID) return;
  try {
    const j = await (await fetch(GH_API + '/gists/' + GIST_ID, { headers: ghH, signal: AbortSignal.timeout(15000) })).json(), f = j.files && j.files['data.json'];
    if (!f) throw new Error(j.message ? 'GitHub: ' + j.message : 'нет data.json, есть файлы: ' + Object.keys(j.files || {}).join(', '));
    const t = f.truncated ? await (await fetch(f.raw_url, { headers: ghH })).text() : f.content;
    db = Object.assign(db, JSON.parse(t || '{}')); gistOK = true; console.log('Данные загружены из Gist');
  } catch (e) { console.error('Gist: не удалось загрузить данные: ' + e.message); }
}
// GitHub ограничивает частые записи, поэтому в Gist пишем не чаще раза в GIST_GAP мс.
const GIST_GAP = +(process.env.GIST_GAP || 15000);
let nextWrite = 0;
async function flush(force) {
  if (!dirty || saving) return;
  if (GH_TOKEN && GIST_ID && (!gistOK || (!force && Date.now() < nextWrite))) return; dirty = false;
  const txt = JSON.stringify(db);
  try { fs.writeFileSync(DATA + '.tmp', txt); fs.renameSync(DATA + '.tmp', DATA); } catch (e) {}
  if (GH_TOKEN && GIST_ID && gistOK) {
    saving = true; nextWrite = Date.now() + GIST_GAP;
    try { const r = await fetch(GH_API + '/gists/' + GIST_ID, { method: 'PATCH', headers: ghH, body: JSON.stringify({ files: { 'data.json': { content: txt } } }) }); if (!r.ok) throw new Error('HTTP ' + r.status); }
    catch (e) { dirty = true; nextWrite = Date.now() + Math.max(GIST_GAP, 60000); console.error('Gist: не удалось сохранить: ' + e.message); }
    saving = false;
  }
}
setInterval(() => flush(), 3000);
['SIGTERM', 'SIGINT'].forEach(s => process.on(s, async () => { while (saving) await new Promise(r => setTimeout(r, 100)); await flush(true); process.exit(0); }));

const codes = {}, pend = {}, rl = {}, conns = new Map();
const now = () => Date.now();
const uid = () => crypto.randomBytes(8).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
function norm(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return '7' + d;
  if (d.length === 11 && /^[78]/.test(d)) return '7' + d.slice(1);
  return '';
}
function hit(key, max, ms) {
  const t = now(), a = (rl[key] || []).filter(x => t - x < ms);
  if (a.length >= max) { rl[key] = a; return false; }
  a.push(t); rl[key] = a; return true;
}
setInterval(() => { const t = now(); for (const k in rl) { rl[k] = rl[k].filter(x => t - x < 36e5); if (!rl[k].length) delete rl[k]; } for (const k in codes) if (codes[k].exp < t) delete codes[k]; for (const k in pend) if (pend[k] < t) delete pend[k]; }, 6e4);

// ---------- доставка кода ----------
async function tgApi(method, params) {
  const r = await fetch(TG_API + '/bot' + TG + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params || {}) });
  return r.json();
}
const tgSend = (chat, text, markup) => tgApi('sendMessage', { chat_id: chat, text, reply_markup: markup }).catch(() => {});
let botName = '';
const mode = () => SMSRU ? 'sms' : (TG ? 'tg' : 'console');
function makeCode(phone) {
  const code = FIXED || String(crypto.randomInt(0, 10 ** CODE_LEN)).padStart(CODE_LEN, '0');
  codes[phone] = { h: hmac(phone + ':' + code), exp: now() + 5 * 60e3, tries: 0 };
  return code;
}
async function smsSend(phone, code) {
  const u = SMS_URL + '?api_id=' + encodeURIComponent(SMSRU) + '&to=' + phone + '&msg=' + encodeURIComponent('ГрибСвязь: код входа ' + code) + '&json=1';
  const j = await (await fetch(u)).json();
  if (j.status !== 'OK' || (j.sms && j.sms[phone] && j.sms[phone].status !== 'OK')) throw new Error('sms ' + JSON.stringify(j).slice(0, 200));
}
const tgCode = (chat, code) => tgSend(chat, 'Ваш код для входа в ГрибСвязь: ' + code + '\nНикому его не сообщайте.');
async function deliver(phone) {
  const m = mode();
  if (m === 'sms') { const c = makeCode(phone); await smsSend(phone, c); return { via: 'sms' }; }
  if (m === 'tg') {
    if (db.tg[phone]) { const c = makeCode(phone); await tgCode(db.tg[phone], c); return { via: 'telegram' }; }
    pend[phone] = now() + 15 * 60e3;
    return { via: 'telegram-link', link: 'https://t.me/' + botName + '?start=login' };
  }
  const c = makeCode(phone); console.log('[КОД ДЛЯ ТЕСТА] +' + phone + ': ' + c); return { via: 'console' };
}
const askKb = { keyboard: [[{ text: '📱 Поделиться номером', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
function onTg(m) {
  if (!m || !m.chat || m.chat.type !== 'private' || !m.from) return;
  if (m.contact) {
    if (m.contact.user_id !== m.from.id) return tgSend(m.chat.id, 'Отправьте свой номер кнопкой ниже.', askKb);
    const phone = norm(m.contact.phone_number);
    if (!phone) return tgSend(m.chat.id, 'Пока поддерживаются только номера +7.');
    db.tg[phone] = m.chat.id; save();
    if (pend[phone] && pend[phone] > now()) { delete pend[phone]; tgSend(m.chat.id, 'Номер подтверждён ✅', { remove_keyboard: true }); return tgCode(m.chat.id, makeCode(phone)); }
    return tgSend(m.chat.id, 'Номер подтверждён ✅ Вернитесь в ГрибСвязь и запросите код.', { remove_keyboard: true });
  }
  const cmd = (m.text || '').trim();
  if (cmd === '/off' || cmd === '/on') {
    db.mute = db.mute || {}; db.mute[m.chat.id] = cmd === '/off'; save();
    return tgSend(m.chat.id, cmd === '/off' ? 'Уведомления выключены. Включить: /on' : 'Уведомления включены. Выключить: /off');
  }
  if ((m.text || '').startsWith('/start')) tgSend(m.chat.id, 'Это бот входа в ГрибСвязь 🍄\nНажмите кнопку, подтвердите номер, и код придёт сюда.', askKb);
}
async function tgLoop() {
  try { await tgApi('deleteWebhook'); const me = await tgApi('getMe'); botName = me.result.username; console.log('Telegram-бот: @' + botName); }
  catch (e) { console.error('Не удалось запустить бота. Проверьте TG_BOT_TOKEN.'); return; }
  let offset = 0;
  for (;;) {
    try {
      const r = await tgApi('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
      if (r.ok) for (const u of r.result) { offset = u.update_id + 1; try { onTg(u.message); } catch (e) {} }
      else await new Promise(r => setTimeout(r, 4000));
    } catch (e) { await new Promise(r => setTimeout(r, 4000)); }
  }
}

// ---------- люди и события ----------
const online = id => conns.has(id) && conns.get(id).size > 0;
const pub = u => ({ id: u.id, name: u.name, username: u.username || '', bio: u.bio || '', photo: u.photo || '', banner: u.banner || '', look: u.look || {}, mood: u.mood || '', track: u.track || null, online: online(u.id), seen: u.seen || 0 });
const own = u => Object.assign(pub(u), { phone: u.phone });
function push(id, ev) { const s = conns.get(id); if (s) for (const r of s) r.write('data: ' + JSON.stringify(ev) + '\n\n'); }
function friendsOf(id) { const out = new Set(db.contacts[id] || []); for (const k in db.contacts) if (db.contacts[k].includes(id)) out.add(k); return [...out]; }
function addContact(a, b) { for (const [x, y] of [[a, b], [b, a]]) { const l = db.contacts[x] = db.contacts[x] || []; if (!l.includes(y)) l.push(y); } save(); }
function presence(u) { const ev = { type: 'presence', id: u.id, online: online(u.id), seen: u.seen || 0 }; friendsOf(u.id).forEach(f => push(f, ev)); }

// Получатель не в сети: коротко пишем ему в Telegram (без текста сообщения), не чаще раза в 5 минут от одного человека.
function tgNotify(to, from) {
  const chat = TG && !online(to.id) && db.tg[to.phone];
  if (!chat || (db.mute && db.mute[chat]) || !hit('tgn:' + to.id + ':' + from.id, 1, 3e5)) return;
  tgSend(chat, '🍄 Новое сообщение в ГрибСвязь от ' + (from.name || 'друга') + '\nОтключить уведомления: /off');
}

const LINES = ['012', '345', '678', '036', '147', '258', '048', '246'];
const winner = b => { for (const l of LINES) { const [x, y, z] = l.split('').map(i => b[i]); if (x !== '.' && x === y && y === z) return x; } return ''; };

// ---------- фото, голосовые, кружки ----------
// Лежат на диске сервера, а не в Gist: на бесплатном Render они пропадают при перезапуске.
const MDIR = process.env.MEDIA_DIR || path.join(__dirname, 'media'), MCAP = 150e6;
try { fs.mkdirSync(MDIR, { recursive: true }); } catch (e) {}
const KINDS = { photo: ['📷 Фото', /^image\/jpeg$/], voice: ['🎤 Голосовое', /^audio\/(webm|ogg|mp4)$/], circle: ['⭕ Кружок', /^video\/(webm|mp4)$/] };
const mfile = id => path.join(MDIR, id);
function trimMedia() {
  const l = fs.readdirSync(MDIR).map(n => ({ n, s: fs.statSync(mfile(n)) })).sort((a, b) => b.s.mtimeMs - a.s.mtimeMs);
  let sum = 0; for (const f of l) { sum += f.s.size; if (sum > MCAP) fs.unlinkSync(mfile(f.n)); }
}

// ---------- HTTP ----------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS' };
function out(res, code, obj) { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS)); res.end(JSON.stringify(obj)); }
const fail = (res, code, error) => out(res, code, { error });
function readBody(req, max = 80000) {
  return new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > max) { no(new Error('big')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } }); req.on('error', no); });
}
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function authed(req, url) {
  const h = req.headers.authorization || '', t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
  const id = t && db.sessions[sha(t)];
  return id && db.users[id] || null;
}
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const ROUTES = {
  async 'POST /api/code'(req, res, url, me, b) {
    const phone = norm(b.phone);
    if (!phone) return fail(res, 400, 'bad_phone');
    if (!hit('ip:' + ipOf(req), 30, 36e5) || !hit('ph:' + phone, 6, 36e5)) return fail(res, 429, 'too_many');
    if (!hit('cd:' + phone, 1, 30e3)) return fail(res, 429, 'too_fast');
    try { const r = await deliver(phone); out(res, 200, Object.assign({ ok: true, len: CODE_LEN }, r)); }
    catch (e) { console.error('deliver', e.message); fail(res, 502, 'send_failed'); }
  },
  async 'POST /api/verify'(req, res, url, me, b) {
    const phone = norm(b.phone), c = codes[phone];
    if (!phone || !c || c.exp < now()) return fail(res, 400, 'no_code');
    if (++c.tries > 5) { delete codes[phone]; return fail(res, 429, 'too_many'); }
    const a = Buffer.from(c.h), z = Buffer.from(hmac(phone + ':' + String(b.code || '')));
    if (a.length !== z.length || !crypto.timingSafeEqual(a, z)) return fail(res, 400, 'wrong_code');
    delete codes[phone];
    let u = Object.values(db.users).find(x => x.phone === phone);
    if (!u) { const id = uid(); u = db.users[id] = { id, phone, name: '', created: now() }; }
    const token = crypto.randomBytes(24).toString('base64url');
    db.sessions[sha(token)] = u.id; save(); flush(true);
    out(res, 200, { token, user: own(u) });
  },
  'GET /api/sync'(req, res, url, me) {
    const ids = new Set(db.contacts[me.id] || []);
    const msgs = db.msgs.filter(m => m.from === me.id || m.to === me.id).slice(-2000);
    msgs.forEach(m => ids.add(m.from === me.id ? m.to : m.from));
    out(res, 200, { me: own(me), users: [...ids].filter(i => db.users[i]).map(i => pub(db.users[i])), messages: msgs });
  },
  async 'PUT /api/me'(req, res, url, me, b) {
    if ('banner' in b) {
      const p = String(b.banner || '');
      if (p && !(p.length <= 48000 && /^data:image\/jpeg;base64,[A-Za-z0-9+\/]+=*$/.test(p))) return fail(res, 400, 'bad_photo');
    }
    if ('name' in b) { const n = clean(b.name, 40); if (n.length < 2) return fail(res, 400, 'bad_name'); me.name = n; }
    if ('username' in b) {
      const un = clean(b.username, 20).replace(/^@/, '');
      if (un && !/^[A-Za-z0-9_]{3,20}$/.test(un)) return fail(res, 400, 'bad_username');
      if (un && Object.values(db.users).some(x => x.id !== me.id && (x.username || '').toLowerCase() === un.toLowerCase())) return fail(res, 409, 'username_taken');
      me.username = un;
    }
    if ('bio' in b) me.bio = clean(b.bio, 120);
    if ('photo' in b) {
      const p = String(b.photo || '');
      if (p && !(p.length <= 16000 && /^data:image\/jpeg;base64,[A-Za-z0-9+\/]+=*$/.test(p))) return fail(res, 400, 'bad_photo');
      me.photo = p;
    }
    if ('banner' in b) me.banner = String(b.banner || '');
    if ('look' in b) { const l = {}; for (const k in LOOK) if (b.look && LOOK[k].includes(b.look[k])) l[k] = b.look[k]; me.look = l; }
    if ('mood' in b) me.mood = clean(b.mood, 60);
    if ('track' in b) me.track = b.track && TRACKS.includes(b.track.key) ? { key: b.track.key } : null;
    save(); friendsOf(me.id).forEach(f => push(f, { type: 'profile', user: pub(me) }));
    out(res, 200, { user: own(me) });
  },
  'GET /api/find'(req, res, url, me) {
    if (!hit('find:' + me.id, 30, 6e4)) return fail(res, 429, 'too_fast');
    const q = clean(url.searchParams.get('q'), 40);
    let u = null;
    if (q.startsWith('@') || /[A-Za-z_]/.test(q)) u = Object.values(db.users).find(x => (x.username || '').toLowerCase() === q.replace(/^@/, '').toLowerCase());
    else { const p = norm(q); u = p && Object.values(db.users).find(x => x.phone === p); }
    if (!u || !u.name || u.id === me.id) return fail(res, 404, 'not_found');
    out(res, 200, { user: pub(u) });
  },
  async 'POST /api/contacts'(req, res, url, me, b) {
    const u = db.users[b.id]; if (!u || u.id === me.id) return fail(res, 404, 'not_found');
    addContact(me.id, u.id); out(res, 200, { ok: true });
  },
  async 'POST /api/send'(req, res, url, me, b) {
    const to = db.users[b.to], text = b.game === 'xo' ? '🎮 Крестики-нолики' : clean(b.text, 4000);
    if (!to || to.id === me.id || !text) return fail(res, 400, 'bad_request');
    const cid = clean(b.cid, 40), dup = cid && db.msgs.find(m => m.from === me.id && m.to === to.id && m.cid === cid);
    if (dup) return out(res, 200, { msg: dup });
    if (!hit('snd:' + me.id, 60, 6e4)) return fail(res, 429, 'too_fast');
    const rep = b.reply && db.msgs.find(m => m.id === b.reply && (m.from === me.id || m.to === me.id));
    const m = { id: uid(), cid, from: me.id, to: to.id, text, ts: now(), reply: rep ? rep.id : null, status: 'sent' };
    // подпись «Переслано от» берём из исходного сообщения, чтобы её нельзя было подделать
    const src = b.fwd && db.msgs.find(x => x.id === b.fwd && (x.from === me.id || x.to === me.id));
    if (src && src.media) return fail(res, 400, 'bad_request');
    if (src) m.fwd = src.fwd || (db.users[src.from] || {}).name || 'Без имени';
    if (b.game === 'xo') m.game = { board: '.........' };
    else if (b.secret || (src && src.secret)) m.secret = true;
    db.msgs.push(m); addContact(me.id, to.id); save();
    push(to.id, { type: 'message', msg: m }); push(me.id, { type: 'message', msg: m });
    tgNotify(to, me);
    out(res, 200, { msg: m });
  },
  async 'POST /api/edit'(req, res, url, me, b) {
    const m = db.msgs.find(x => x.id === b.id && x.from === me.id), text = clean(b.text, 4000);
    if (!m) return fail(res, 404, 'not_found');
    if (!text || m.fwd || m.game || m.media) return fail(res, 400, 'bad_request');
    if (!hit('edt:' + me.id, 60, 6e4)) return fail(res, 429, 'too_fast');
    if (text !== m.text) {
      m.text = text; m.edited = now(); save();
      const ev = { type: 'edit', id: m.id, text, edited: m.edited }; push(m.from, ev); push(m.to, ev);
    }
    out(res, 200, { msg: m });
  },
  async 'POST /api/read'(req, res, url, me, b) {
    const ids = [];
    db.msgs.forEach(m => { if (m.from === b.with && m.to === me.id && m.status !== 'read') { m.status = 'read'; ids.push(m.id); } });
    if (ids.length) { save(); push(b.with, { type: 'read', by: me.id, ids }); }
    out(res, 200, { ok: true });
  },
  async 'POST /api/react'(req, res, url, me, b) {
    const m = db.msgs.find(x => x.id === b.id && (x.from === me.id || x.to === me.id)); if (!m) return fail(res, 404, 'not_found');
    m.react = b.emoji ? clean(b.emoji, 8) : null; save();
    const ev = { type: 'react', id: m.id, emoji: m.react }; push(m.from, ev); push(m.to, ev); out(res, 200, { ok: true });
  },
  async 'POST /api/delete'(req, res, url, me, b) {
    const i = db.msgs.findIndex(x => x.id === b.id && x.from === me.id); if (i < 0) return fail(res, 404, 'not_found');
    const m = db.msgs.splice(i, 1)[0]; save(); if (m.media) fs.unlink(mfile(m.media.id), () => {});
    const ev = { type: 'delete', id: m.id }; push(m.from, ev); push(m.to, ev); out(res, 200, { ok: true });
  },
  async 'POST /api/logout'(req, res, url) {
    const h = req.headers.authorization || '', t = h.startsWith('Bearer ') ? h.slice(7) : '';
    delete db.sessions[sha(t)]; save(); out(res, 200, { ok: true });
  },
  async 'POST /api/move'(req, res, url, me, b) {
    const m = db.msgs.find(x => x.id === b.id && x.game && (x.from === me.id || x.to === me.id));
    if (!m) return fail(res, 404, 'not_found');
    // крестики у того, кто позвал; первым ходит соперник
    const bd = m.game.board, n = bd.split('').filter(c => c !== '.').length, turn = n % 2 ? m.from : m.to, i = b.cell;
    if (winner(bd) || turn !== me.id || !Number.isInteger(i) || i < 0 || i > 8 || bd[i] !== '.') return fail(res, 400, 'bad_move');
    m.game.board = bd.slice(0, i) + (me.id === m.from ? 'x' : 'o') + bd.slice(i + 1); save();
    const ev = { type: 'game', id: m.id, game: m.game }; push(m.from, ev); push(m.to, ev);
    out(res, 200, { game: m.game });
  },
  async 'POST /api/media'(req, res, url, me, b) {
    const to = db.users[b.to], k = Object.prototype.hasOwnProperty.call(KINDS, b.kind) && KINDS[b.kind];
    const p = /^data:([a-z]+\/[a-z0-9]+)(?:;codecs=[^;]*)?;base64,([A-Za-z0-9+\/]+=*)$/.exec(String(b.data || ''));
    if (!to || to.id === me.id || !k || !p || !k[1].test(p[1])) return fail(res, 400, 'bad_media');
    if (!hit('med:' + me.id, 15, 6e4)) return fail(res, 429, 'too_fast');
    const mid = uid() + uid();
    fs.writeFileSync(mfile(mid), Buffer.from(p[2], 'base64')); trimMedia();
    const m = { id: uid(), cid: '', from: me.id, to: to.id, text: k[0], ts: now(), reply: null, status: 'sent', media: { id: mid, kind: b.kind, type: p[1], dur: Math.min(60, Math.max(0, Math.round(+b.dur) || 0)) } };
    db.msgs.push(m); addContact(me.id, to.id); save();
    push(to.id, { type: 'message', msg: m }); push(me.id, { type: 'message', msg: m }); tgNotify(to, me);
    out(res, 200, { msg: m });
  },
  'GET /api/media'(req, res, url, me) {
    const mid = url.searchParams.get('id');
    const m = db.msgs.find(x => x.media && x.media.id === mid && (x.from === me.id || x.to === me.id));
    if (!m || !fs.existsSync(mfile(m.media.id))) return fail(res, 404, 'gone');
    res.writeHead(200, Object.assign({ 'Content-Type': m.media.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' }, CORS));
    fs.createReadStream(mfile(m.media.id)).pipe(res);
  },
  // звонки: сервер только передаёт служебные сообщения, звук и видео идут между телефонами
  async 'POST /api/call'(req, res, url, me, b) {
    const to = db.users[b.to], cid = clean(b.cid, 40);
    if (!to || to.id === me.id || !cid || !['offer', 'answer', 'ice', 'end'].includes(b.kind) || !(db.contacts[me.id] || []).includes(to.id)) return fail(res, 400, 'bad_request');
    if (!hit('call:' + me.id, 300, 6e4) || (b.kind === 'offer' && !hit('ring:' + me.id, 6, 6e4))) return fail(res, 429, 'too_fast');
    const got = online(to.id);
    push(to.id, { type: 'call', from: me.id, cid, kind: b.kind, data: b.data || null });
    if (b.kind === 'answer' || b.kind === 'end') push(me.id, { type: 'call', from: to.id, cid, kind: 'taken' });
    if (!got && b.kind === 'offer') tgNotify(to, me);
    out(res, 200, { ok: true, online: got });
  },
  async 'POST /api/nudge'(req, res, url, me, b) {
    const to = db.users[b.to];
    if (!to || to.id === me.id || !(db.contacts[me.id] || []).includes(to.id)) return fail(res, 404, 'not_found');
    if (!hit('ndg:' + me.id + ':' + to.id, 1, 1e4)) return fail(res, 429, 'too_fast');
    const got = online(to.id); push(to.id, { type: 'nudge', from: me.id }); out(res, 200, { ok: true, online: got });
  },
  async 'POST /api/typing'(req, res, url, me, b) {
    if (db.users[b.to] && hit('typ:' + me.id, 20, 1e4)) push(b.to, { type: 'typing', from: me.id });
    out(res, 200, { ok: true });
  },
  'GET /api/events'(req, res, url, me) {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }, CORS));
    res.write('retry: 3000\n\n');
    if (!conns.has(me.id)) conns.set(me.id, new Set());
    const set = conns.get(me.id), first = set.size === 0; set.add(res);
    if (first) presence(me);
    const hb = setInterval(() => res.write(':\n\n'), 20000);
    req.on('close', () => { clearInterval(hb); set.delete(res); if (!set.size) { conns.delete(me.id); me.seen = now(); save(); presence(me); } });
  }
};
const OPEN = new Set(['POST /api/code', 'POST /api/verify']);
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (url.pathname === '/health') return out(res, ready() ? 200 : 503, { ok: ready(), mode: mode(), storage: useGist() ? 'gist' : 'file' });
  if (url.pathname === '/icon.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' }); return res.end(fs.readFileSync(path.join(__dirname, 'icon.png'))); }
  if (url.pathname === '/manifest.json') { res.writeHead(200, { 'Content-Type': 'application/manifest+json' }); return res.end(JSON.stringify({ name: 'ГрибСвязь', short_name: 'ГрибСвязь', start_url: '/', display: 'standalone', background_color: '#0B1311', theme_color: '#0B1311', icons: [192, 512].map(n => ({ src: '/icon.png', sizes: n + 'x' + n, type: 'image/png' })) })); }
  if (url.pathname === '/sw.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(path.join(__dirname, 'sw.js'))); }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('<head>', '<head><script>window.__API__=""</script>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Gribsvyaz': '1' }); return res.end(html);
    } catch (e) { res.writeHead(404); return res.end('index.html не найден'); }
  }
  const key = req.method + ' ' + url.pathname, h = ROUTES[key];
  if (!h) return fail(res, 404, 'not_found');
  if (!ready()) return fail(res, 503, 'starting'); // 503, а не 401: приложение не должно разлогиниваться
  try {
    const me = authed(req, url);
    if (!OPEN.has(key) && !me) return fail(res, 401, 'unauthorized');
    const b = req.method === 'GET' ? {} : await readBody(req, key === 'POST /api/media' ? 3e6 : 80000);
    await h(req, res, url, me, b);
  } catch (e) { console.error(key, e.message); if (!res.headersSent) fail(res, 400, 'bad_request'); }
}).listen(PORT, async () => { console.log('ГрибСвязь на порту ' + PORT + ', код входа: ' + mode()); for (;;) { await gistLoad(); if (ready()) break; await new Promise(r => setTimeout(r, 5000)); }
  if (!useGist()) console.warn('ВНИМАНИЕ: GH_TOKEN и GIST_ID не заданы. На бесплатном Render все аккаунты сотрутся при перезапуске.');
  if (TG) tgLoop();
  // бесплатный Render усыпляет сервис без запросов: раз в 10 минут обращаемся к себе по внешнему адресу
  const self = process.env.RENDER_EXTERNAL_URL;
  if (self) setInterval(() => fetch(self + '/health', { signal: AbortSignal.timeout(15000) }).catch(() => {}), 6e5); });
