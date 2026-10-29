/* ============================================================
   A Hero's Destiny — servidor online (feito para o Render) · v6
   - Serve o jogo em "/" e o WebSocket em "/ws"
   - Contas com senha (scrypt). Cada jogador tem o SEU save, guardado separado.
   - "Mundos": o servidor público e as salas SandBox (criar servidor personalizado).
     Cada mundo tem as próprias contas, saves, chat, alianças, boosts e salas de mapa.
     Só entra numa sala SandBox quem tem o nome e a senha dela; o criador é o ADM da sala.
   - Painel do Dev (senha só no servidor, padrão 996908, ou DEV_PASS): vê e controla
     os jogadores de todos os mundos.
   - Salas por mapa: o primeiro jogador da sala é o "host" e simula os monstros.
   - Arena PVP: o servidor confere quem derrubou quem e avisa a sala.
   Armazenamento: arquivos em DATA_DIR (padrão ./data). Sem dependências: o WebSocket está em ws.js.
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const WS = require('./ws');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROTO = 2;                  // versão do protocolo (o jogo manda a mesma)
const MAX_SAVE = 4 * 1024 * 1024; // tamanho máximo de um save
const MAX_MSG = 256 * 1024;       // outras mensagens
const MAX_CFG = 1536 * 1024;      // configuração de uma sala SandBox
const MAX_ALLY = 8;               // membros por aliança
const CHAT_KEEP = 80;             // mensagens guardadas no histórico
const PERSONAL = new Set(['desafio']); // mapas que são instância individual
const SB_MAX = 300;               // salas SandBox no servidor
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// a senha do painel do Dev nunca vai no jogo: o jogo manda sha256('ahd-dev|senha') e o servidor compara
const DEV_KEY = sha256('ahd-dev|' + (process.env.DEV_PASS || '996908'));

/* ============================================================
   ARMAZENAMENTO
   ============================================================ */
const chains = new Map();
function serial(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}
const hexOf = (s) => Buffer.from(String(s), 'utf8').toString('hex');
function fileStore(dir) {
  const dAcc = path.join(dir, 'contas'), dSave = path.join(dir, 'saves');
  const fname = (l) => hexOf(l) + '.json';
  let tmpN = 0;
  async function readJSON(f) { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch (e) { return null; } }
  async function writeAtomic(f, txt) { const tmp = f + '.' + process.pid + '.' + (++tmpN) + '.tmp'; await fsp.writeFile(tmp, txt); await fsp.rename(tmp, f); }
  const del = (f) => fsp.unlink(f).catch(() => {});
  return {
    kind: 'arquivos', dir,
    async init() { await fsp.mkdir(dAcc, { recursive: true }); await fsp.mkdir(dSave, { recursive: true }); },
    getAccount: (l) => readJSON(path.join(dAcc, fname(l))),
    putAccount: (a) => writeAtomic(path.join(dAcc, fname(a.lname)), JSON.stringify(a)),
    delAccount: (l) => del(path.join(dAcc, fname(l))),
    getSave: (l) => readJSON(path.join(dSave, fname(l))),
    putSave: (l, rec) => writeAtomic(path.join(dSave, fname(l)), JSON.stringify(rec)),
    delSave: (l) => del(path.join(dSave, fname(l))),
    getKV: (k) => readJSON(path.join(dir, k + '.json')),
    putKV: (k, v) => writeAtomic(path.join(dir, k + '.json'), JSON.stringify(v)),
    async wipe() { await fsp.rm(dir, { recursive: true, force: true }); },
  };
}

/* ============================================================
   SENHAS
   ============================================================ */
function scrypt(key, salt) { return new Promise((res, rej) => crypto.scrypt(key, salt, 32, { N: 16384, r: 8, p: 1 }, (e, b) => (e ? rej(e) : res(b.toString('hex'))))); }
async function hashKey(key) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: await scrypt(key, salt) }; }
async function checkHash(rec, key) {
  const h = await scrypt(key, rec.salt);
  const a = Buffer.from(h, 'hex'), b = Buffer.from(String(rec.hash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
// muitas senhas erradas seguidas do mesmo IP: espera um minuto
const fails = new Map();
function tooManyFails(ip) { const f = fails.get(ip); return !!(f && f.n >= 8 && Date.now() - f.t < 60000); }
function noteFail(ip) { const f = fails.get(ip) || { n: 0, t: 0 }; if (Date.now() - f.t > 60000) f.n = 0; f.n++; f.t = Date.now(); fails.set(ip, f); }

function cleanName(n, max) {
  n = String(n || '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f<>"'`\\]/g, '').replace(/\s+/g, ' ').trim();
  return n.length >= 2 && n.length <= (max || 20) ? n : null;
}
const cleanTxt = (t, max) => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const DIFS = new Set(['facil', 'medio', 'dificil', 'hardcore']);

/* ============================================================
   MUNDOS (público e salas SandBox)
   ============================================================ */
let seq = 0;
const clients = new Map();  // pid -> cliente (todos os mundos)
const realms = new Map();   // id -> mundo ('pub' ou 'sb:<nome>')
function newRealm(id, store, meta) {
  return { id, sb: id !== 'pub', meta: meta || null, cfg: null, cfgTxt: '', store,
    byName: new Map(), rooms: new Map(), alliances: new Map(), allyOf: new Map(), invites: new Map(), boosts: new Map(),
    chatHist: [], chatSeq: 0, chatDirty: false, allyDirty: false, whoDirty: false, bans: {}, bansDirty: false, mutes: new Map(), idleSince: Date.now(), pvp: new Map() };
}
async function loadRealmData(R) {
  await R.store.init();
  const al = (await R.store.getKV('aliancas').catch(() => null)) || [];
  for (const a of al) { if (!a || !a.id || !Array.isArray(a.members) || !a.members.length) continue; R.alliances.set(a.id, a); for (const m of a.members) R.allyOf.set(m.l, a.id); }
  R.chatHist = ((await R.store.getKV('chat').catch(() => null)) || []).slice(-CHAT_KEEP);
  R.chatSeq = R.chatHist.reduce((m, x) => Math.max(m, x.id || 0), 0);
  R.bans = (await R.store.getKV('bans').catch(() => null)) || {};
}
const PUB = newRealm('pub', fileStore(DATA_DIR));
realms.set('pub', PUB);
const sbStore = (lname) => fileStore(path.join(DATA_DIR, 'sb', hexOf(lname)));
// abre uma sala SandBox (do disco, se já existir)
async function openSandbox(lname) {
  const id = 'sb:' + lname;
  if (realms.has(id)) return realms.get(id);
  const st = sbStore(lname);
  const meta = await st.getKV('meta').catch(() => null);
  if (!meta) return null;
  const R = newRealm(id, st, meta);
  await loadRealmData(R);
  const cfg = await st.getKV('config').catch(() => null);
  if (cfg) { R.cfg = cfg; R.cfgTxt = JSON.stringify(cfg); }
  realms.set(id, R);
  return R;
}
async function sandboxList() {
  const out = [];
  let names = [];
  try { names = await fsp.readdir(path.join(DATA_DIR, 'sb')); } catch (e) { return out; }
  for (const h of names) {
    const meta = await fileStore(path.join(DATA_DIR, 'sb', h)).getKV('meta').catch(() => null);
    if (!meta) continue;
    const R = realms.get('sb:' + meta.lname);
    out.push({ name: meta.name, owner: meta.ownerName || null, created: meta.created, on: R ? R.byName.size : 0 });
  }
  return out;
}

/* ============================================================
   ENVIO
   ============================================================ */
function sendRaw(c, txt) {
  if (!c || !c.ws || c.ws.readyState !== 1) return;
  if (c.ws.bufferedAmount > 4 * 1024 * 1024) return; // conexão entupida: descarta (o jogo se corrige sozinho)
  c.ws.send(txt);
}
const send = (c, o) => sendRaw(c, JSON.stringify(o));
function realmBroadcast(R, o, onlineOnly) { const txt = typeof o === 'string' ? o : JSON.stringify(o); for (const c of R.byName.values()) if (c.authed && (!onlineOnly || c.online)) sendRaw(c, txt); }
function pub(c) { const R = c.realm; return { p: c.pid, n: c.name, lv: c.prof.lv, ti: c.prof.ti, cl: c.prof.cl, mx: c.prof.mx, d: c.prof.dif, pw: c.prof.pw, a: c.aid ? allyTag(R, c.aid) : null }; }
function allyTag(R, id) { const a = R.alliances.get(id); return a ? a.name : null; }

/* ---------------- chat ---------------- */
function pushChat(R, m) { R.chatHist.push(m); if (R.chatHist.length > CHAT_KEEP) R.chatHist = R.chatHist.slice(-CHAT_KEEP); R.chatDirty = true; }
function sysChat(R, txt, extra) { const m = Object.assign({ t: 'chat', id: ++R.chatSeq, ts: Date.now(), sys: 1, txt }, extra || {}); pushChat(R, m); realmBroadcast(R, m); }

/* ---------------- quem está online ---------------- */
function whoList(R) {
  const out = [];
  for (const c of R.byName.values()) if (c.authed) out.push({ p: c.pid, n: c.name, lv: c.prof.lv, ti: c.prof.ti, cl: c.prof.cl, d: c.prof.dif, m: c.map || '', o: c.online ? 1 : 0, a: c.aid ? allyTag(R, c.aid) : null, ai: c.aid || null, w: c.away ? 1 : 0, adm: c.sbAdm ? 1 : 0 });
  return out;
}

/* ---------------- boosts globais (de cada mundo) ---------------- */
function boostList(R) {
  const now = Date.now();
  for (const [k, b] of R.boosts) if (b.until <= now) R.boosts.delete(k);
  return [...R.boosts.values()].map((b) => ({ id: b.id, left: b.until - now, by: b.by }));
}
function broadcastBoosts(R) { realmBroadcast(R, { t: 'boosts', l: boostList(R) }, true); }
function addBoost(R, id, dur, by) {
  const now = Date.now(), b = R.boosts.get(id);
  R.boosts.set(id, { id, until: (b && b.until > now ? b.until : now) + dur * 1000, by });
  broadcastBoosts(R);
}

/* ---------------- salas de mapa ---------------- */
function roomOf(c) { return c.room && c.realm ? c.realm.rooms.get(c.room) : null; }
function pickHost(r) { const act = r.members.find((p) => { const x = clients.get(p); return x && !x.away; }); return act || r.members[0] || null; }
function setHost(r, pid) {
  if (r.host === pid) return;
  r.host = pid;
  const txt = JSON.stringify({ t: 'host', p: pid, k: r.key });
  for (const p of r.members) sendRaw(clients.get(p), txt);
}
function leaveRoom(c) {
  const r = roomOf(c); c.room = null;
  if (!r) return;
  r.members = r.members.filter((p) => p !== c.pid);
  if (!r.members.length) { c.realm.rooms.delete(r.key); return; }
  const txt = JSON.stringify({ t: 'pl', p: c.pid });
  for (const p of r.members) sendRaw(clients.get(p), txt);
  if (r.host === c.pid) setHost(r, pickHost(r));
}
function joinRoom(c, map) {
  leaveRoom(c);
  if (!c.authed || !c.online || !map) return;
  const R = c.realm;
  const key = PERSONAL.has(map.split('.')[0]) ? map + '#' + c.pid : map;
  let r = R.rooms.get(key);
  if (!r) { r = { key, map, members: [], host: null }; R.rooms.set(key, r); }
  r.members.push(c.pid); c.room = key;
  if (!r.host || !clients.get(r.host)) r.host = c.pid;
  else { const h = clients.get(r.host); if (h.away && !c.away) setHost(r, c.pid); }
  send(c, { t: 'room', m: map, k: key, host: r.host, l: r.members.filter((p) => p !== c.pid).map((p) => pub(clients.get(p))) });
  const txt = JSON.stringify({ t: 'pj', p: pub(c) });
  for (const p of r.members) if (p !== c.pid) sendRaw(clients.get(p), txt);
}

/* ---------------- alianças ---------------- */
function allyState(R, id) {
  const a = R.alliances.get(id); if (!a) return null;
  return { id: a.id, name: a.name, owner: a.owner, m: a.members.map((x) => { const y = R.byName.get(x.l); return { l: x.l, n: x.n, on: !!(y && y.authed), o: y && y.online ? 1 : 0 }; }) };
}
function pushAlly(R, id) {
  const a = R.alliances.get(id); if (!a) return;
  const st = allyState(R, id);
  for (const x of a.members) { const c = R.byName.get(x.l); if (c && c.authed) send(c, { t: 'ally', a: st }); }
}
function invitesOf(R, lname) {
  const s = R.invites.get(lname); if (!s) return [];
  const out = []; for (const id of s) { const a = R.alliances.get(id); if (a) out.push({ id, name: a.name }); else s.delete(id); }
  return out;
}
function dropFromAlly(R, lname) {
  const id = R.allyOf.get(lname); if (!id) return;
  const a = R.alliances.get(id); R.allyOf.delete(lname);
  if (!a) return;
  a.members = a.members.filter((x) => x.l !== lname);
  if (!a.members.length) R.alliances.delete(a.id); else { if (a.owner === lname) a.owner = a.members[0].l; pushAlly(R, a.id); }
  R.allyDirty = true;
}

/* ============================================================
   PAINEL DO DEV e ADM DA SALA
   ============================================================ */
const devs = new Set(); // clientes com o painel do Dev aberto
function watchersOf(R) { let n = 0; for (const d of devs) if (d.ws.readyState === 1) n++; if (R.sb) for (const c of R.byName.values()) if (c.sbAdm && c.admWatch) n++; return n; }
// os jogadores só mandam o relatório de status quando alguém está olhando
function refreshWatch(R) {
  const on = watchersOf(R) > 0 ? 1 : 0;
  if (R.watch === on) return;
  R.watch = on;
  realmBroadcast(R, { t: 'devwatch', on });
}
function refreshAllWatch() { for (const R of realms.values()) refreshWatch(R); }
function devRow(c) {
  return { p: c.pid, n: c.name, r: c.realm ? c.realm.id : '?', d: c.prof.dif, lv: c.prof.lv, cl: c.prof.cl, m: c.map || '', o: c.online ? 1 : 0, w: c.away ? 1 : 0, st: c.stat || null, adm: c.sbAdm ? 1 : 0, mu: c.realm && c.realm.mutes.get(c.lname) > Date.now() ? 1 : 0, ip: c.ipShort };
}
function devList(R) { const out = []; for (const c of clients.values()) if (c.authed && (!R || c.realm === R)) out.push(devRow(c)); return out; }
// comandos que o servidor resolve; os outros vão para o jogo do alvo
const SERVER_CMDS = new Set(['kick', 'ban', 'unban', 'mute', 'unmute', 'announce', 'gboost', 'closeRoom', 'delRoom']);
async function runCmd(c, scopeR, msg) {
  const cmd = msg.c || {}, k = String(cmd.k || '');
  if (!/^[a-zA-Z]{2,16}$/.test(k)) return;
  const by = c.dev ? 'Dev' : 'ADM da sala';
  const targets = [];
  if (msg.p === '*') { for (const x of clients.values()) if (x.authed && x !== c && (!scopeR || x.realm === scopeR) && (!msg.r || (x.realm && x.realm.id === msg.r))) targets.push(x); }
  else { const x = clients.get(String(msg.p)); if (x && x.authed && (!scopeR || x.realm === scopeR)) targets.push(x); }
  if (k === 'announce') {
    const txt = cleanTxt(cmd.txt, 300); if (!txt) return;
    const rs = scopeR ? [scopeR] : msg.r ? [realms.get(msg.r)].filter(Boolean) : [...realms.values()];
    for (const R of rs) { sysChat(R, '📢 ' + by + ': ' + txt, { dev: 1 }); realmBroadcast(R, { t: 'devcmd', c: { k: 'msg', txt, big: 1 }, by }); }
    return send(c, { t: 'note', msg: 'Anúncio enviado.' });
  }
  if (k === 'gboost') {
    const id = cleanTxt(cmd.id, 16), dur = Math.max(10, Math.min(86400, +cmd.dur || 600));
    if (!/^[a-z0-9]+$/i.test(id)) return;
    const rs = scopeR ? [scopeR] : msg.r ? [realms.get(msg.r)].filter(Boolean) : [...realms.values()];
    for (const R of rs) { addBoost(R, id, dur, by); sysChat(R, '✨ ' + by + ' ativou ' + (cleanTxt(cmd.nome, 30) || id) + ' para todos por ' + Math.round(dur / 60) + ' min!'); }
    return;
  }
  if (k === 'closeRoom' || k === 'delRoom') {
    if (!c.dev) return;
    const R = realms.get(String(msg.r || '')); if (!R || !R.sb) return send(c, { t: 'note', msg: 'Sala não encontrada.' });
    for (const x of [...R.byName.values()]) kick(x, k === 'delRoom' ? 'A sala foi apagada pelo Dev.' : 'A sala foi fechada pelo Dev.');
    if (k === 'delRoom') { realms.delete(R.id); await R.store.wipe().catch(() => {}); log('sala apagada:', R.id); }
    return send(c, { t: 'note', msg: k === 'delRoom' ? 'Sala apagada.' : 'Todos saíram da sala.' });
  }
  if (!targets.length) return send(c, { t: 'note', msg: 'Jogador não encontrado.' });
  for (const x of targets) {
    const R = x.realm;
    if (k === 'kick') { kick(x, 'Você foi expulso pelo ' + by + '.'); continue; }
    if (k === 'ban') { R.bans[x.lname] = { by, t: Date.now(), until: cmd.min ? Date.now() + Math.min(5e8, +cmd.min * 60000) : 0 }; R.bansDirty = true; kick(x, 'Você foi banido pelo ' + by + '.'); continue; }
    if (k === 'unban') { delete R.bans[x.lname]; R.bansDirty = true; continue; }
    if (k === 'mute') { R.mutes.set(x.lname, Date.now() + Math.max(1, Math.min(10080, +cmd.min || 10)) * 60000); send(x, { t: 'note', msg: '🔇 Você foi silenciado no chat pelo ' + by + '.' }); continue; }
    if (k === 'unmute') { R.mutes.delete(x.lname); send(x, { t: 'note', msg: '🔊 Você pode falar no chat de novo.' }); continue; }
    send(x, { t: 'devcmd', c: cmd, by });
  }
  if (!SERVER_CMDS.has(k)) send(c, { t: 'note', msg: 'Comando enviado para ' + (targets.length === 1 ? targets[0].name : targets.length + ' jogadores') + '.' });
}
async function banByName(c, R, name, min) {
  const l = String(name || '').toLowerCase(); if (!l) return;
  R.bans[l] = { by: 'Dev', t: Date.now(), until: min ? Date.now() + min * 60000 : 0 }; R.bansDirty = true;
  const x = R.byName.get(l); if (x) kick(x, 'Você foi banido.');
  send(c, { t: 'note', msg: name + ' banido.' });
}

/* ============================================================
   MENSAGENS
   ============================================================ */
async function handle(c, msg) {
  const t = msg && msg.t;
  if (typeof t !== 'string') return;
  switch (t) {
    case 'ping': return send(c, { t: 'pong', n: msg.n });
    case 'hello':
      if (+msg.v !== PROTO) send(c, { t: 'err', code: 'proto', msg: 'O jogo e o servidor estão em versões diferentes. Atualize a página (ou pegue o AHD.html novo).' });
      return;
    case 'sb': return sandboxMsg(c, msg);
    case 'auth': return auth(c, msg);
    case 'logout': return logout(c, 'saiu');
    case 'dev': return devMsg(c, msg);
  }
  if (!c.authed) return;
  const R = c.realm;
  switch (t) {
    case 'save': return saveMsg(c, msg);
    case 'load': return serial('save:' + R.id + ':' + c.lname, async () => { const sv = await R.store.getSave(c.lname); send(c, { t: 'loaded', save: sv ? { data: sv.data, play: sv.play, t: sv.t } : null }); });
    case 'delacc': return delAccount(c);
    case 'prof': {
      const p = c.prof;
      const lv = msg.lv; p.lv = (typeof lv === 'number' && isFinite(lv)) || (Array.isArray(lv) && lv.length === 2 && lv.every((x) => typeof x === 'number' && isFinite(x))) ? lv : p.lv;
      p.ti = msg.ti ? cleanTxt(msg.ti, 24) : null;
      p.cl = msg.cl ? cleanTxt(msg.cl, 32) : null;
      p.mx = Math.max(0, Math.floor(+msg.mx || 0));
      p.dif = DIFS.has(msg.dif) ? msg.dif : p.dif;
      p.pw = isFinite(+msg.pw) ? Math.max(0, Math.min(1e7, +msg.pw)) : p.pw;
      R.whoDirty = true;
      const r = roomOf(c);
      if (r) { const txt = JSON.stringify({ t: 'prof', p: pub(c) }); for (const pid of r.members) if (pid !== c.pid) sendRaw(clients.get(pid), txt); }
      return;
    }
    case 'st': { // relatório de status (só quando o Dev ou o ADM da sala está olhando)
      if (!msg.d || typeof msg.d !== 'object') return;
      const d = msg.d, o = {};
      for (const k of ['hp', 'z', 'x', 'y', 'kills', 'play', 'deaths', 'spins', 'aw', 'mxl', 'asc']) if (isFinite(+d[k])) o[k] = +d[k];
      for (const k of ['yen', 'str', 'lvl', 'hit', 'mapn', 'cls', 'ver']) if (d[k] != null) o[k] = cleanTxt(d[k], 40);
      c.stat = o; c.statT = Date.now();
      return;
    }
    case 'mode': {
      const on = !!msg.on;
      if (on === c.online) return;
      c.online = on; R.whoDirty = true;
      if (!on) leaveRoom(c);
      else { send(c, { t: 'boosts', l: boostList(R) }); if (c.map) joinRoom(c, c.map); }
      if (c.aid) pushAlly(R, c.aid);
      return;
    }
    case 'room': {
      const map = cleanTxt(msg.m, 32);
      if (!/^[a-z0-9_.-]{1,32}$/i.test(map)) return;
      c.map = map; R.whoDirty = true;
      if (c.online) joinRoom(c, map);
      return;
    }
    case 'away': {
      c.away = !!msg.v; R.whoDirty = true;
      const r = roomOf(c); if (!r) return;
      if (c.away && r.host === c.pid) setHost(r, pickHost(r));
      else if (!c.away) { const h = clients.get(r.host); if (!h || h.away) setHost(r, c.pid); }
      return;
    }
    case 'r': {
      const r = roomOf(c); if (!r || r.members.length < 2 || msg.m == null) return;
      const txt = JSON.stringify({ t: 'r', f: c.pid, m: msg.m });
      for (const p of r.members) if (p !== c.pid) sendRaw(clients.get(p), txt);
      return;
    }
    case 'to': {
      const x = clients.get(String(msg.p)); if (!x || !x.room || x.room !== c.room || x.realm !== R || msg.m == null) return;
      sendRaw(x, JSON.stringify({ t: 'r', f: c.pid, m: msg.m }));
      return;
    }
    case 'pvpd': { // arena PVP: quem caiu avisa quem derrubou (os dois precisam estar na mesma arena)
      const a = clients.get(String(msg.a)); const r = roomOf(c);
      if (!a || a === c || !r || a.room !== c.room || a.realm !== R || !/^pvp/.test(r.map)) return;
      const now = Date.now();
      if (c.pvpT && now - c.pvpT < 1500) return; c.pvpT = now;
      a.pvpStreak = (a.pvpStreak || 0) + 1; c.pvpStreak = 0;
      const sa = R.pvp.get(a.lname) || { k: 0, d: 0, n: a.name }; sa.k++; R.pvp.set(a.lname, sa);
      const sv = R.pvp.get(c.lname) || { k: 0, d: 0, n: c.name }; sv.d++; R.pvp.set(c.lname, sv);
      const txt = JSON.stringify({ t: 'pvpk', a: a.name, ap: a.pid, v: c.name, vp: c.pid, s: a.pvpStreak });
      for (const p of r.members) sendRaw(clients.get(p), txt);
      if (a.pvpStreak === 5 || a.pvpStreak === 10 || a.pvpStreak === 25) sysChat(R, '⚔️ ' + a.name + ' derrubou ' + a.pvpStreak + ' seguidos na Arena PVP!');
      return;
    }
    case 'pvptop': { const l = [...R.pvp.values()].sort((a, b) => b.k - a.k || a.d - b.d).slice(0, 10); return send(c, { t: 'pvptop', l }); }
    case 'chat': {
      const now = Date.now();
      const mu = R.mutes.get(c.lname); if (mu && mu > now) return send(c, { t: 'note', msg: '🔇 Você está silenciado por mais ' + Math.ceil((mu - now) / 60000) + ' min.' });
      c.chatT = c.chatT.filter((x) => now - x < 6000);
      if (c.chatT.length >= 5) return send(c, { t: 'note', msg: 'Calma! Espere um pouco para mandar outra mensagem.' });
      const txt = cleanTxt(msg.txt, 200); if (!txt) return;
      c.chatT.push(now);
      const m = { t: 'chat', id: ++R.chatSeq, ts: now, p: c.pid, n: c.name, lv: c.prof.lv, ti: c.prof.ti, cl: c.prof.cl, d: c.prof.dif, a: c.aid ? allyTag(R, c.aid) : null, adm: c.sbAdm ? 1 : 0, txt };
      pushChat(R, m); realmBroadcast(R, m);
      return;
    }
    case 'boost': {
      if (!c.online) return;
      const id = cleanTxt(msg.id, 16), dur = Math.max(10, Math.min(7200, +msg.dur || 0));
      if (!/^[a-z0-9]+$/i.test(id) || !dur) return;
      addBoost(R, id, dur, c.name);
      sysChat(R, '✨ ' + c.name + ' ativou ' + (cleanTxt(msg.nome, 30) || id) + ' para todos os jogadores online!');
      return;
    }
    case 'share': {
      if (!c.online || !c.aid) return;
      const a = R.alliances.get(c.aid); if (!a) return;
      const l = Array.isArray(msg.l) ? msg.l.slice(0, 64) : []; if (!l.length) return;
      const ex = new Set((Array.isArray(msg.ex) ? msg.ex : []).slice(0, 32).map(String));
      const txt = JSON.stringify({ t: 'share', from: c.name, l });
      for (const mb of a.members) { if (mb.l === c.lname) continue; const x = R.byName.get(mb.l); if (x && x.authed && x.online && !ex.has(x.pid)) sendRaw(x, txt); }
      return;
    }
    case 'ally': return allyMsg(c, msg);
    case 'adm': return admMsg(c, msg);
  }
}

/* ---------------- contas ---------------- */
async function auth(c, msg) {
  if (c.authed) return;
  const R = c.realm || PUB;
  if (R.sb && !c.sbOk) return send(c, { t: 'auth_err', msg: 'Entre na sala com a senha primeiro.' });
  if (tooManyFails(c.ip)) return send(c, { t: 'auth_err', msg: 'Muitas tentativas erradas. Espere um minuto.' });
  const name = cleanName(msg.name), key = String(msg.key || '');
  if (!name || !/^[0-9a-f]{64}$/.test(key)) return send(c, { t: 'auth_err', msg: 'Usuário (2 a 20 letras) ou senha inválidos.' });
  const lname = name.toLowerCase();
  const ban = R.bans[lname];
  if (ban && (!ban.until || ban.until > Date.now())) return send(c, { t: 'auth_err', msg: 'Esta conta está banida' + (ban.until ? ' até ' + new Date(ban.until).toLocaleString('pt-BR') : '') + '.' });
  await serial('acc:' + R.id + ':' + lname, async () => {
    let acc = await R.store.getAccount(lname), created = false;
    if (msg.op === 'register') {
      if (acc) return send(c, { t: 'auth_err', msg: 'Esse nome já tem dono neste servidor. Escolha outro ou entre com a senha dele.' });
      acc = Object.assign({ name, lname, created: Date.now(), last: Date.now() }, await hashKey(key)); await R.store.putAccount(acc); created = true;
    } else if (!acc) {
      // conta que só existia no navegador: o servidor cria e o jogo manda o save de lá
      if (!msg.loc) return send(c, { t: 'auth_err', msg: 'Conta não encontrada neste servidor. Use "Criar conta".' });
      acc = Object.assign({ name, lname, created: Date.now(), last: Date.now() }, await hashKey(key)); await R.store.putAccount(acc); created = true;
    } else if (!(await checkHash(acc, key))) {
      noteFail(c.ip);
      return send(c, { t: 'auth_err', msg: 'Senha incorreta.' });
    }
    if (c.ws.readyState !== 1) return;
    const old = R.byName.get(lname);
    if (old && old !== c) kick(old, 'Sua conta entrou em outro aparelho. Este aqui ficou desconectado do servidor.');
    acc.last = Date.now(); R.store.putAccount(acc).catch((e) => log('conta:', e.message));
    // SandBox: a primeira conta criada por quem criou a sala vira a dona (ADM da sala)
    if (R.sb && c.sbCreator && created && !R.meta.owner) { R.meta.owner = lname; R.meta.ownerName = name; await R.store.putKV('meta', R.meta).catch(() => {}); }
    c.sbAdm = !!(R.sb && R.meta && R.meta.owner === lname);
    c.authed = true; c.name = acc.name; c.lname = lname; c.online = false; c.realm = R; R.byName.set(lname, c); R.idleSince = 0;
    c.aid = R.allyOf.get(lname) || null;
    const sv = created ? null : await R.store.getSave(lname);
    c.lastPlay = sv ? +sv.play || 0 : 0;
    send(c, { t: 'auth_ok', name: acc.name, p: c.pid, created, save: sv ? { data: sv.data, play: sv.play, t: sv.t } : null, realm: R.id, adm: c.sbAdm ? 1 : 0 });
    if (R.sb && R.cfgTxt) sendRaw(c, '{"t":"sbcfg","cfg":' + R.cfgTxt + '}');
    send(c, { t: 'hist', l: R.chatHist });
    send(c, { t: 'ally', a: allyState(R, c.aid) });
    const inv = invitesOf(R, lname); if (inv.length) send(c, { t: 'ainv', l: inv });
    if (R.watch) send(c, { t: 'devwatch', on: 1 });
    R.whoDirty = true;
    if (c.aid) pushAlly(R, c.aid);
    sysChat(R, '👋 ' + acc.name + ' entrou no jogo.');
    log('entrou:', R.id, acc.name, created ? '(conta nova)' : '');
  });
}
// Hardcore: o herói morreu — a conta e o save somem do servidor
async function delAccount(c) {
  const R = c.realm, lname = c.lname, name = c.name;
  await serial('acc:' + R.id + ':' + lname, async () => {
    await serial('save:' + R.id + ':' + lname, async () => { await R.store.delSave(lname); });
    await R.store.delAccount(lname);
  });
  dropFromAlly(R, lname);
  logout(c, null);
  sysChat(R, '💀 ' + name + ' caiu no Hardcore. A lenda acabou.');
  log('conta apagada (hardcore):', R.id, name);
}

function saveMsg(c, msg) {
  if (c.kicked) return;
  const now = Date.now();
  if (now - c.saveT < 3000 && !msg.force) return send(c, { t: 'saved', skip: 1 });
  const data = msg.data;
  if (typeof data !== 'string' || data.length < 10 || data.length > MAX_SAVE) return send(c, { t: 'note', msg: 'Save inválido ou grande demais para o servidor.' });
  const play = Math.max(0, +msg.play || 0);
  c.saveT = now;
  const R = c.realm, lname = c.lname;
  return serial('save:' + R.id + ':' + lname, async () => {
    // um aparelho com save mais velho não sobrescreve um save mais jogado (a não ser que o jogador mande)
    if (!msg.force && play + 120 < c.lastPlay) return send(c, { t: 'save_old', play: c.lastPlay });
    await R.store.putSave(lname, { data, play, t: now });
    c.lastPlay = play;
    send(c, { t: 'saved', at: now });
  }).catch((e) => { log('save:', e.message); send(c, { t: 'note', msg: 'O servidor não conseguiu salvar agora. Seu save continua no navegador.' }); });
}

function allyMsg(c, msg) {
  const R = c.realm, op = msg.op;
  if (op === 'create') {
    if (c.aid) return send(c, { t: 'note', msg: 'Você já está numa aliança.' });
    const name = cleanName(msg.name);
    if (!name) return send(c, { t: 'note', msg: 'O nome da aliança precisa de 2 a 20 letras.' });
    for (const a of R.alliances.values()) if (a.name.toLowerCase() === name.toLowerCase()) return send(c, { t: 'note', msg: 'Já existe uma aliança com esse nome.' });
    const id = crypto.randomBytes(6).toString('hex');
    R.alliances.set(id, { id, name, owner: c.lname, members: [{ l: c.lname, n: c.name }], created: Date.now() });
    R.allyOf.set(c.lname, id); c.aid = id; R.allyDirty = true;
    pushAlly(R, id); R.whoDirty = true;
    sysChat(R, '🤝 ' + c.name + ' fundou a aliança ' + name + '.');
    return;
  }
  if (op === 'invite') {
    const a = R.alliances.get(c.aid); if (!a) return send(c, { t: 'note', msg: 'Crie uma aliança primeiro.' });
    if (a.members.length >= MAX_ALLY) return send(c, { t: 'note', msg: 'A aliança já está cheia (' + MAX_ALLY + ').' });
    const x = clients.get(String(msg.p)); if (!x || !x.authed || x === c || x.realm !== R) return;
    if (x.aid) return send(c, { t: 'note', msg: x.name + ' já está em outra aliança.' });
    let s = R.invites.get(x.lname); if (!s) { s = new Set(); R.invites.set(x.lname, s); }
    s.add(a.id);
    send(x, { t: 'ainv', l: invitesOf(R, x.lname), from: c.name });
    send(c, { t: 'note', msg: 'Convite enviado para ' + x.name + '.' });
    return;
  }
  if (op === 'accept' || op === 'decline') {
    const id = String(msg.id || ''), s = R.invites.get(c.lname);
    if (!s || !s.has(id)) return;
    s.delete(id);
    if (op === 'decline') { send(c, { t: 'ainv', l: invitesOf(R, c.lname) }); return; }
    if (c.aid) return send(c, { t: 'note', msg: 'Saia da sua aliança antes de entrar em outra.' });
    const a = R.alliances.get(id); if (!a) return send(c, { t: 'note', msg: 'Essa aliança não existe mais.' });
    if (a.members.length >= MAX_ALLY) return send(c, { t: 'note', msg: 'A aliança já está cheia.' });
    a.members.push({ l: c.lname, n: c.name }); R.allyOf.set(c.lname, id); c.aid = id; R.allyDirty = true;
    R.invites.delete(c.lname);
    send(c, { t: 'ainv', l: [] });
    pushAlly(R, id); R.whoDirty = true;
    sysChat(R, '🤝 ' + c.name + ' entrou na aliança ' + a.name + '.');
    return;
  }
  if (op === 'leave' || op === 'kick') {
    const a = R.alliances.get(c.aid); if (!a) return;
    let who = c.lname;
    if (op === 'kick') { if (a.owner !== c.lname) return; who = String(msg.l || '').toLowerCase(); if (who === c.lname) return; }
    const mb = a.members.find((x) => x.l === who); if (!mb) return;
    a.members = a.members.filter((x) => x.l !== who); R.allyOf.delete(who);
    const xc = R.byName.get(who); if (xc) { xc.aid = null; send(xc, { t: 'ally', a: null }); }
    if (!a.members.length) { R.alliances.delete(a.id); sysChat(R, '🤝 A aliança ' + a.name + ' acabou.'); }
    else { if (a.owner === who) a.owner = a.members[0].l; pushAlly(R, a.id); sysChat(R, '🤝 ' + mb.n + (op === 'kick' ? ' foi removido da' : ' saiu da') + ' aliança ' + a.name + '.'); }
    R.allyDirty = true; R.whoDirty = true;
  }
}

/* ---------------- SandBox: criar e entrar numa sala ---------------- */
// o jogo manda sha256('ahd-sb|sala|senha'); aqui ela passa pelo scrypt com sal
async function sandboxMsg(c, msg) {
  if (c.authed) return send(c, { t: 'sb_err', msg: 'Saia da conta antes de trocar de servidor.' });
  if (msg.op === 'leave') { c.realm = PUB; c.sbOk = false; c.sbCreator = false; return send(c, { t: 'sb_left' }); }
  if (msg.op === 'list') return send(c, { t: 'sb_list', n: (await sandboxList()).length });
  if (tooManyFails(c.ip)) return send(c, { t: 'sb_err', msg: 'Muitas tentativas erradas. Espere um minuto.' });
  const name = cleanName(msg.room, 24), key = String(msg.key || '');
  if (!name || !/^[0-9a-f]{64}$/.test(key)) return send(c, { t: 'sb_err', msg: 'Nome da sala (2 a 24 letras) ou senha inválidos.' });
  const lname = name.toLowerCase();
  await serial('sb:' + lname, async () => {
    if (msg.op === 'create') {
      if (await openSandbox(lname)) return send(c, { t: 'sb_err', msg: 'Já existe uma sala com esse nome. Escolha outro ou entre com a senha dela.' });
      if ((await sandboxList()).length >= SB_MAX) return send(c, { t: 'sb_err', msg: 'O servidor já tem salas demais.' });
      const st = sbStore(lname); await st.init();
      const meta = Object.assign({ name, lname, created: Date.now(), owner: null, ownerName: null }, await hashKey(key));
      await st.putKV('meta', meta);
      const R = newRealm('sb:' + lname, st, meta); realms.set(R.id, R);
      c.realm = R; c.sbOk = true; c.sbCreator = true;
      log('sala SandBox criada:', name);
      return send(c, { t: 'sb_ok', room: name, created: true, hasCfg: false });
    }
    const R = await openSandbox(lname);
    if (!R) { noteFail(c.ip); return send(c, { t: 'sb_err', msg: 'Sala não encontrada. Confira o nome.' }); }
    if (!(await checkHash(R.meta, key))) { noteFail(c.ip); return send(c, { t: 'sb_err', msg: 'Senha da sala incorreta.' }); }
    c.realm = R; c.sbOk = true; c.sbCreator = !R.meta.owner;
    return send(c, { t: 'sb_ok', room: R.meta.name, created: false, hasCfg: !!R.cfg, owner: R.meta.ownerName });
  });
}
// ADM da sala: configuração do mundo e comandos sobre os jogadores da sala
async function admMsg(c, msg) {
  const R = c.realm;
  if (!R.sb || !c.sbAdm) return send(c, { t: 'note', msg: 'Só o criador da sala usa o painel do ADM.' });
  if (msg.op === 'cfg') {
    const txt = typeof msg.cfg === 'string' ? msg.cfg : JSON.stringify(msg.cfg || null);
    if (!txt || txt.length > MAX_CFG) return send(c, { t: 'note', msg: 'A configuração passou do tamanho máximo (1,5 MB).' });
    let cfg; try { cfg = JSON.parse(txt); } catch (e) { return send(c, { t: 'note', msg: 'Configuração inválida.' }); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return;
    R.cfg = cfg; R.cfgTxt = JSON.stringify(cfg);
    await R.store.putKV('config', cfg).catch((e) => log('config:', e.message));
    realmBroadcast(R, '{"t":"sbcfg","cfg":' + R.cfgTxt + '}');
    return send(c, { t: 'note', msg: '✅ Mundo atualizado para todos da sala.' });
  }
  if (msg.op === 'watch') { c.admWatch = !!msg.on; refreshWatch(R); if (c.admWatch) send(c, { t: 'adm_list', l: devList(R) }); return; }
  if (msg.op === 'list') return send(c, { t: 'adm_list', l: devList(R) });
  if (msg.op === 'cmd') return runCmd(c, R, msg);
  if (msg.op === 'pass') { // trocar a senha da sala
    const key = String(msg.key || ''); if (!/^[0-9a-f]{64}$/.test(key)) return;
    Object.assign(R.meta, await hashKey(key)); await R.store.putKV('meta', R.meta).catch(() => {});
    return send(c, { t: 'note', msg: 'Senha da sala trocada.' });
  }
}
/* ---------------- painel do Dev ---------------- */
async function devMsg(c, msg) {
  if (msg.op === 'auth') {
    if (tooManyFails(c.ip)) return send(c, { t: 'dev_err', msg: 'Muitas tentativas. Espere um minuto.' });
    if (!safeEq(String(msg.key || ''), DEV_KEY)) { noteFail(c.ip); return send(c, { t: 'dev_err', msg: 'Senha do Dev incorreta.' }); }
    c.dev = true; devs.add(c); refreshAllWatch();
    log('painel do Dev aberto por', c.name || c.ip);
    send(c, { t: 'dev_ok' });
    return send(c, { t: 'dev_list', l: devList(null), rooms: await sandboxList() });
  }
  if (!c.dev) return;
  if (msg.op === 'close') { c.dev = false; devs.delete(c); refreshAllWatch(); return; }
  if (msg.op === 'list') return send(c, { t: 'dev_list', l: devList(null), rooms: await sandboxList() });
  if (msg.op === 'cmd') return runCmd(c, null, msg);
  if (msg.op === 'ban') { const R = realms.get(String(msg.r || 'pub')) || PUB; return banByName(c, R, cleanName(msg.name), +msg.min || 0); }
  if (msg.op === 'unbanName') { const R = realms.get(String(msg.r || 'pub')) || PUB; delete R.bans[String(msg.name || '').toLowerCase()]; R.bansDirty = true; return send(c, { t: 'note', msg: 'Desbanido.' }); }
  if (msg.op === 'bans') { const R = realms.get(String(msg.r || 'pub')) || PUB; return send(c, { t: 'dev_bans', r: R.id, l: Object.keys(R.bans) }); }
  if (msg.op === 'sbcfg') { // o Dev também pode trocar o mundo de uma sala
    const R = realms.get(String(msg.r || '')); if (!R || !R.sb) return;
    return admMsg(Object.assign(Object.create(c), { realm: R, sbAdm: true }), { op: 'cfg', cfg: msg.cfg });
  }
}

function kick(c, why) {
  send(c, { t: 'kick', msg: why });
  c.kicked = true;
  logout(c, null);
}
function logout(c, why) {
  if (!c.authed) return;
  const R = c.realm;
  leaveRoom(c);
  if (R.byName.get(c.lname) === c) R.byName.delete(c.lname);
  const name = c.name, aid = c.aid;
  c.authed = false; c.online = false; c.aid = null; c.sbAdm = false; c.admWatch = false;
  R.whoDirty = true;
  if (!R.byName.size) R.idleSince = Date.now();
  if (aid) pushAlly(R, aid);
  if (why) sysChat(R, '🚪 ' + name + ' ' + why + '.');
  refreshWatch(R);
}

/* ============================================================
   HTTP + WEBSOCKET
   ============================================================ */
let page = null, pageGz = null, pageBuild = '';
// O jogo fica solto ao lado do server.js (pelo celular não dá para criar pastas no GitHub);
// entre todos os .html, vale o de carimbo (ahd-build) mais novo.
function headOf(f) {
  const fd = fs.openSync(f, 'r');
  try { const b = Buffer.alloc(4096); return b.toString('utf8', 0, fs.readSync(fd, b, 0, 4096, 0)); } finally { fs.closeSync(fd); }
}
function findPage() {
  const pref = ['AHD.html', 'index.html', 'public/index.html', 'public/AHD.html'];
  const list = [];
  for (const d of [__dirname, PUBLIC_DIR]) {
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) { continue; }
    for (const n of names) {
      if (!/\.html?$/i.test(n)) continue;
      const f = path.join(d, n);
      try {
        const st = fs.statSync(f);
        if (!st.isFile()) continue;
        const m = /name="ahd-build" content="(\d+)"/.exec(headOf(f));
        const rel = path.relative(__dirname, f).split(path.sep).join('/');
        list.push({ f, rel, b: m ? m[1] : '', p: pref.indexOf(rel) < 0 ? 99 : pref.indexOf(rel), s: st.size });
      } catch (e) { /* ignora */ }
    }
  }
  list.sort((x, y) => (x.b === y.b ? 0 : x.b < y.b ? 1 : -1) || x.p - y.p || y.s - x.s);
  return list[0] || null;
}
function loadPage() {
  const g = findPage();
  try {
    if (!g) throw new Error('sem jogo');
    page = fs.readFileSync(g.f);
    pageGz = zlib.gzipSync(page, { level: 9 });
    pageBuild = g.b;
    log('jogo carregado (' + g.rel + (g.b ? ', versão ' + g.b : '') + '):', Math.round(page.length / 1024) + ' KB (' + Math.round(pageGz.length / 1024) + ' KB comprimido)');
  } catch (e) { page = null; log('aviso: AHD.html não encontrado ao lado do server.js — o servidor funciona, mas não serve o jogo'); }
}
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/status') {
    let authed = 0, online = 0; for (const c of clients.values()) { if (c.authed) authed++; if (c.online) online++; }
    let salas = 0; for (const R of realms.values()) salas += R.rooms.size;
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, versao: 6, jogo: page ? (pageBuild || true) : false, jogadores: authed, modoOnline: online, salasDeMapa: salas, mundosAbertos: realms.size, armazenamento: PUB.store.kind, uptime: Math.round(process.uptime()) }));
    return;
  }
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (url === '/' || url === '/index.html' || url === '/AHD.html') {
    if (!page) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Coloque o jogo (AHD.html) no repositório, junto com o server.js'); return; }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const etag = '"' + (pageBuild || page.length) + (gz ? 'g' : '') + '"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', etag, ...(gz ? { 'content-encoding': 'gzip' } : {}), vary: 'accept-encoding' });
    res.end(gz ? pageGz : page);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('não encontrado');
});

WS.attach(server, { path: '/ws', maxPayload: MAX_SAVE + 64 * 1024 }, (ws, req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const c = { ws, pid: (++seq).toString(36), ip, ipShort: sha256(ip).slice(0, 6), authed: false, online: false, away: false, kicked: false, name: '', lname: '', room: null, map: '', aid: null,
    realm: PUB, sbOk: false, sbCreator: false, sbAdm: false, admWatch: false, dev: false, stat: null,
    prof: { lv: 1, ti: null, cl: null, mx: 0, dif: 'facil', pw: 0 }, chatT: [], saveT: 0, lastPlay: 0, q: Promise.resolve(), alive: true, rate: 0, rateT: Date.now() };
  clients.set(c.pid, c);
  send(c, { t: 'welcome', p: c.pid, v: PROTO, store: PUB.store.kind });
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (buf) => {
    // limite de mensagens por segundo (o jogo manda ~30/s em pacotes)
    const now = Date.now();
    if (now - c.rateT > 1000) { c.rateT = now; c.rate = 0; }
    if (++c.rate > 150) return;
    // só o save (e a configuração da sala) pode ser grande
    if (buf.length > MAX_MSG && !(buf.length < MAX_SAVE + 64 * 1024 && (buf.includes('"t":"save"') || buf.includes('"op":"cfg"') || buf.includes('"op":"sbcfg"')))) return;
    let msg; try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
    c.q = c.q.then(() => handle(c, msg)).catch((e) => log('erro:', e && e.stack || e));
  });
  ws.on('close', () => {
    clients.delete(c.pid);
    if (c.dev) { devs.delete(c); refreshAllWatch(); }
    if (c.authed) logout(c, 'saiu do jogo');
    else leaveRoom(c);
  });
});

// mantém as conexões vivas e derruba as mortas
setInterval(() => { for (const c of clients.values()) { if (!c.alive) { try { c.ws.terminate(); } catch (e) { /* já foi */ } continue; } c.alive = false; try { c.ws.ping(); } catch (e) { /* ok */ } } }, 25000);
// lista de quem está online (no máximo a cada 1,5 s por mundo)
setInterval(() => { for (const R of realms.values()) if (R.whoDirty) { R.whoDirty = false; realmBroadcast(R, { t: 'who', l: whoList(R) }); } }, 1500);
// painel do Dev e do ADM da sala: lista com status a cada 2 s
setInterval(() => {
  if (devs.size) { const txt = JSON.stringify({ t: 'dev_list', l: devList(null) }); for (const d of devs) sendRaw(d, txt); }
  for (const R of realms.values()) if (R.sb) for (const c of R.byName.values()) if (c.sbAdm && c.admWatch) send(c, { t: 'adm_list', l: devList(R) });
}, 2000);
// boosts vencidos, gravação de alianças/chat/banimentos e mundos parados
setInterval(() => {
  for (const R of realms.values()) {
    const n = R.boosts.size; boostList(R); if (R.boosts.size !== n) broadcastBoosts(R);
    if (R.allyDirty) { R.allyDirty = false; R.store.putKV('aliancas', [...R.alliances.values()]).catch((e) => log('alianças:', e.message)); }
    if (R.chatDirty) { R.chatDirty = false; R.store.putKV('chat', R.chatHist.slice(-CHAT_KEEP)).catch(() => {}); }
    if (R.bansDirty) { R.bansDirty = false; R.store.putKV('bans', R.bans).catch(() => {}); }
    // sala SandBox sem ninguém há 10 minutos: sai da memória (continua no disco)
    if (R.sb && !R.byName.size && R.idleSince && Date.now() - R.idleSince > 600000) { let busy = false; for (const c of clients.values()) if (c.realm === R) { busy = true; break; } if (!busy) realms.delete(R.id); }
  }
}, 5000);
// limpa a lista de tentativas erradas
setInterval(() => { const now = Date.now(); for (const [ip, f] of fails) if (now - f.t > 120000) fails.delete(ip); }, 120000);

async function main() {
  await loadRealmData(PUB);
  loadPage();
  server.listen(PORT, () => log('A Hero\'s Destiny online (v6) na porta ' + PORT + ' · armazenamento: ' + PUB.store.kind + ' (' + DATA_DIR + ')'));
}
function shutdown() {
  log('desligando...');
  const done = () => process.exit(0);
  const jobs = [];
  for (const R of realms.values()) jobs.push(R.store.putKV('aliancas', [...R.alliances.values()]).catch(() => {}), R.store.putKV('chat', R.chatHist).catch(() => {}), R.store.putKV('bans', R.bans).catch(() => {}));
  Promise.all(jobs).then(done, done);
  setTimeout(done, 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (e) => log('erro inesperado:', e && e.stack || e));
process.on('unhandledRejection', (e) => log('promessa rejeitada:', e && e.stack || e));
main().catch((e) => { console.error('Falha ao iniciar:', e); process.exit(1); });
