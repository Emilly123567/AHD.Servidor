/* ============================================================
   A Hero's Destiny — servidor online (feito para o Render)
   - Serve o jogo em "/" e o WebSocket em "/ws"
   - Contas com senha (scrypt). Cada jogador tem o SEU save, guardado separado;
     o servidor só entrega o save para o dono e nunca carrega dois saves juntos.
   - Chat global (com título e nível), alianças, boosts globais
   - Salas por mapa: o primeiro jogador da sala é o "host" e simula os monstros;
     os outros recebem tudo e mandam os próprios golpes. Se o host sair, outro assume.
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
const PROTO = 1;                 // versão do protocolo (o jogo manda a mesma)
const MAX_SAVE = 4 * 1024 * 1024; // tamanho máximo de um save
const MAX_ALLY = 8;              // membros por aliança
const CHAT_KEEP = 80;            // mensagens guardadas no histórico
const PERSONAL = new Set(['desafio']); // mapas que são instância individual (cada um na sua)
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ============================================================
   ARMAZENAMENTO
   ============================================================ */
// fila por chave: duas escritas da mesma conta nunca acontecem ao mesmo tempo
const chains = new Map();
function serial(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}

function fileStore(dir) {
  const dAcc = path.join(dir, 'contas'), dSave = path.join(dir, 'saves');
  const fname = (l) => Buffer.from(l, 'utf8').toString('hex') + '.json';
  let tmpN = 0;
  async function readJSON(f) { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch (e) { return null; } }
  async function writeAtomic(f, txt) { const tmp = f + '.' + process.pid + '.' + (++tmpN) + '.tmp'; await fsp.writeFile(tmp, txt); await fsp.rename(tmp, f); }
  return {
    kind: 'arquivos',
    async init() { await fsp.mkdir(dAcc, { recursive: true }); await fsp.mkdir(dSave, { recursive: true }); },
    getAccount: (l) => readJSON(path.join(dAcc, fname(l))),
    putAccount: (a) => writeAtomic(path.join(dAcc, fname(a.lname)), JSON.stringify(a)),
    getSave: (l) => readJSON(path.join(dSave, fname(l))),
    putSave: (l, rec) => writeAtomic(path.join(dSave, fname(l)), JSON.stringify(rec)),
    getKV: (k) => readJSON(path.join(dir, k + '.json')),
    putKV: (k, v) => writeAtomic(path.join(dir, k + '.json'), JSON.stringify(v)),
  };
}

const store = fileStore(DATA_DIR);

/* ============================================================
   SENHAS
   ============================================================ */
// o jogo nunca manda a senha pura: manda sha256('ahd2|nome|senha'); aqui ela ainda passa pelo scrypt com sal
function scrypt(key, salt) { return new Promise((res, rej) => crypto.scrypt(key, salt, 32, { N: 16384, r: 8, p: 1 }, (e, b) => (e ? rej(e) : res(b.toString('hex'))))); }
async function newAccount(name, key) {
  const salt = crypto.randomBytes(16).toString('hex');
  const acc = { name, lname: name.toLowerCase(), salt, hash: await scrypt(key, salt), created: Date.now(), last: Date.now() };
  await store.putAccount(acc);
  return acc;
}
async function checkKey(acc, key) {
  const h = await scrypt(key, acc.salt);
  const a = Buffer.from(h, 'hex'), b = Buffer.from(String(acc.hash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// muitas senhas erradas seguidas do mesmo IP: espera um minuto
const fails = new Map();
function tooManyFails(ip) { const f = fails.get(ip); return !!(f && f.n >= 8 && Date.now() - f.t < 60000); }
function noteFail(ip) { const f = fails.get(ip) || { n: 0, t: 0 }; if (Date.now() - f.t > 60000) f.n = 0; f.n++; f.t = Date.now(); fails.set(ip, f); }

function cleanName(n) {
  n = String(n || '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f<>"'`\\]/g, '').replace(/\s+/g, ' ').trim();
  return n.length >= 2 && n.length <= 20 ? n : null;
}
const cleanTxt = (t, max) => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/* ============================================================
   ESTADO EM MEMÓRIA
   ============================================================ */
let seq = 0, chatSeq = 0;
const clients = new Map();  // pid -> cliente
const byName = new Map();   // nome em minúsculas -> cliente logado
const rooms = new Map();    // chave da sala -> { key, map, members: [pid], host }
const alliances = new Map(); // id -> { id, name, owner, members: [{ l, n }] }
const allyOf = new Map();   // nome em minúsculas -> id da aliança
const invites = new Map();  // nome em minúsculas -> Set(id)
const boosts = new Map();   // id -> { id, until, by }
let chatHist = [];
let whoDirty = false;

function sendRaw(c, txt) {
  if (!c || !c.ws || c.ws.readyState !== 1) return;
  if (c.ws.bufferedAmount > 4 * 1024 * 1024) return; // conexão entupida: descarta (o jogo se corrige sozinho)
  c.ws.send(txt);
}
const send = (c, o) => sendRaw(c, JSON.stringify(o));
function broadcastAuthed(o, onlineOnly) { const txt = JSON.stringify(o); for (const c of clients.values()) if (c.authed && (!onlineOnly || c.online)) sendRaw(c, txt); }

function pub(c) { return { p: c.pid, n: c.name, lv: c.prof.lv, ti: c.prof.ti, cl: c.prof.cl, mx: c.prof.mx, a: c.aid ? allyTag(c.aid) : null }; }
function allyTag(id) { const a = alliances.get(id); return a ? a.name : null; }

/* ---------------- chat ---------------- */
function pushChat(m) { chatHist.push(m); if (chatHist.length > CHAT_KEEP) chatHist = chatHist.slice(-CHAT_KEEP); chatDirty = true; }
let chatDirty = false;
function sysChat(txt) { const m = { t: 'chat', id: ++chatSeq, ts: Date.now(), sys: 1, txt }; pushChat(m); broadcastAuthed(m); }

/* ---------------- quem está online ---------------- */
function whoList() {
  const out = [];
  for (const c of clients.values()) if (c.authed) out.push({ p: c.pid, n: c.name, lv: c.prof.lv, ti: c.prof.ti, cl: c.prof.cl, m: c.map || '', o: c.online ? 1 : 0, a: c.aid ? allyTag(c.aid) : null, ai: c.aid || null, w: c.away ? 1 : 0 });
  return out;
}

/* ---------------- boosts globais ---------------- */
function boostList() {
  const now = Date.now();
  for (const [k, b] of boosts) if (b.until <= now) boosts.delete(k);
  return [...boosts.values()].map((b) => ({ id: b.id, left: b.until - now, by: b.by }));
}
function broadcastBoosts() { broadcastAuthed({ t: 'boosts', l: boostList() }, true); }

/* ---------------- salas (uma por mapa) ---------------- */
function roomOf(c) { return c.room ? rooms.get(c.room) : null; }
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
  if (!r.members.length) { rooms.delete(r.key); return; }
  const txt = JSON.stringify({ t: 'pl', p: c.pid });
  for (const p of r.members) sendRaw(clients.get(p), txt);
  if (r.host === c.pid) setHost(r, pickHost(r));
}
function joinRoom(c, map) {
  leaveRoom(c);
  if (!c.authed || !c.online || !map) return;
  const key = PERSONAL.has(map) ? map + '#' + c.pid : map;
  let r = rooms.get(key);
  if (!r) { r = { key, map, members: [], host: null }; rooms.set(key, r); }
  r.members.push(c.pid); c.room = key;
  if (!r.host || !clients.get(r.host)) r.host = c.pid;
  else { const h = clients.get(r.host); if (h.away && !c.away) setHost(r, c.pid); }
  send(c, { t: 'room', m: map, k: key, host: r.host, l: r.members.filter((p) => p !== c.pid).map((p) => pub(clients.get(p))) });
  const txt = JSON.stringify({ t: 'pj', p: pub(c) });
  for (const p of r.members) if (p !== c.pid) sendRaw(clients.get(p), txt);
}

/* ---------------- alianças ---------------- */
function allyState(id) {
  const a = alliances.get(id); if (!a) return null;
  return { id: a.id, name: a.name, owner: a.owner, m: a.members.map((x) => ({ l: x.l, n: x.n, on: !!(byName.get(x.l) && byName.get(x.l).authed), o: byName.get(x.l) && byName.get(x.l).online ? 1 : 0 })) };
}
function pushAlly(id) {
  const a = alliances.get(id); if (!a) return;
  const st = allyState(id);
  for (const x of a.members) { const c = byName.get(x.l); if (c && c.authed) send(c, { t: 'ally', a: st }); }
}
let allyDirty = false;
function saveAlliances() { allyDirty = true; }
function invitesOf(lname) {
  const s = invites.get(lname); if (!s) return [];
  const out = []; for (const id of s) { const a = alliances.get(id); if (a) out.push({ id, name: a.name }); else s.delete(id); }
  return out;
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
    case 'auth': return auth(c, msg);
    case 'logout': return logout(c, 'saiu');
  }
  if (!c.authed) return;
  switch (t) {
    case 'save': return saveMsg(c, msg);
    case 'load': return serial('save:' + c.lname, async () => { const sv = await store.getSave(c.lname); send(c, { t: 'loaded', save: sv ? { data: sv.data, play: sv.play, t: sv.t } : null }); });
    case 'prof': {
      const p = c.prof;
      const lv = msg.lv; p.lv = (typeof lv === 'number' && isFinite(lv)) || (Array.isArray(lv) && lv.length === 2 && lv.every((x) => typeof x === 'number' && isFinite(x))) ? lv : p.lv;
      p.ti = msg.ti ? cleanTxt(msg.ti, 24) : null;
      p.cl = msg.cl ? cleanTxt(msg.cl, 32) : null;
      p.mx = Math.max(0, Math.floor(+msg.mx || 0));
      whoDirty = true;
      const r = roomOf(c);
      if (r) { const txt = JSON.stringify({ t: 'prof', p: pub(c) }); for (const pid of r.members) if (pid !== c.pid) sendRaw(clients.get(pid), txt); }
      return;
    }
    case 'mode': {
      const on = !!msg.on;
      if (on === c.online) return;
      c.online = on; whoDirty = true;
      if (!on) leaveRoom(c);
      else { send(c, { t: 'boosts', l: boostList() }); if (c.map) joinRoom(c, c.map); }
      if (c.aid) pushAlly(c.aid);
      return;
    }
    case 'room': {
      const map = cleanTxt(msg.m, 24);
      if (!/^[a-z0-9_.-]{1,24}$/i.test(map)) return;
      c.map = map; whoDirty = true;
      if (c.online) joinRoom(c, map);
      return;
    }
    case 'away': {
      c.away = !!msg.v; whoDirty = true;
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
      const x = clients.get(String(msg.p)); if (!x || !x.room || x.room !== c.room || msg.m == null) return;
      sendRaw(x, JSON.stringify({ t: 'r', f: c.pid, m: msg.m }));
      return;
    }
    case 'chat': {
      const now = Date.now();
      c.chatT = c.chatT.filter((x) => now - x < 6000);
      if (c.chatT.length >= 5) return send(c, { t: 'note', msg: 'Calma! Espere um pouco para mandar outra mensagem.' });
      const txt = cleanTxt(msg.txt, 200); if (!txt) return;
      c.chatT.push(now);
      const m = { t: 'chat', id: ++chatSeq, ts: now, p: c.pid, n: c.name, lv: c.prof.lv, ti: c.prof.ti, cl: c.prof.cl, a: c.aid ? allyTag(c.aid) : null, txt };
      pushChat(m); broadcastAuthed(m);
      return;
    }
    case 'boost': {
      if (!c.online) return;
      const id = cleanTxt(msg.id, 16), dur = Math.max(10, Math.min(7200, +msg.dur || 0));
      if (!/^[a-z0-9]+$/i.test(id) || !dur) return;
      const now = Date.now(), b = boosts.get(id);
      boosts.set(id, { id, until: (b && b.until > now ? b.until : now) + dur * 1000, by: c.name });
      broadcastBoosts();
      sysChat('✨ ' + c.name + ' ativou ' + (cleanTxt(msg.nome, 30) || id) + ' para todos os jogadores online!');
      return;
    }
    case 'share': {
      if (!c.online || !c.aid) return;
      const a = alliances.get(c.aid); if (!a) return;
      const l = Array.isArray(msg.l) ? msg.l.slice(0, 64) : []; if (!l.length) return;
      const ex = new Set((Array.isArray(msg.ex) ? msg.ex : []).slice(0, 32).map(String));
      const txt = JSON.stringify({ t: 'share', from: c.name, l });
      for (const mb of a.members) { if (mb.l === c.lname) continue; const x = byName.get(mb.l); if (x && x.authed && x.online && !ex.has(x.pid)) sendRaw(x, txt); }
      return;
    }
    case 'ally': return allyMsg(c, msg);
  }
}

async function auth(c, msg) {
  if (c.authed) return;
  if (tooManyFails(c.ip)) return send(c, { t: 'auth_err', msg: 'Muitas tentativas erradas. Espere um minuto.' });
  const name = cleanName(msg.name), key = String(msg.key || '');
  if (!name || !/^[0-9a-f]{64}$/.test(key)) return send(c, { t: 'auth_err', msg: 'Usuário (2 a 20 letras) ou senha inválidos.' });
  const lname = name.toLowerCase();
  await serial('acc:' + lname, async () => {
    let acc = await store.getAccount(lname), created = false;
    if (msg.op === 'register') {
      if (acc) return send(c, { t: 'auth_err', msg: 'Esse nome já tem dono no servidor. Escolha outro ou entre com a senha dele.' });
      acc = await newAccount(name, key); created = true;
    } else if (!acc) {
      // conta que só existia no navegador: o servidor cria e o jogo manda o save de lá
      if (!msg.loc) return send(c, { t: 'auth_err', msg: 'Conta não encontrada no servidor. Use "Criar conta".' });
      acc = await newAccount(name, key); created = true;
    } else if (!(await checkKey(acc, key))) {
      noteFail(c.ip);
      return send(c, { t: 'auth_err', msg: 'Senha incorreta.' });
    }
    if (c.ws.readyState !== 1) return;
    const old = byName.get(lname);
    if (old && old !== c) kick(old, 'Sua conta entrou em outro aparelho. Este aqui ficou desconectado do servidor.');
    acc.last = Date.now(); store.putAccount(acc).catch((e) => log('conta:', e.message));
    c.authed = true; c.name = acc.name; c.lname = lname; c.online = false; byName.set(lname, c);
    c.aid = allyOf.get(lname) || null;
    // o save deste jogador é lido sozinho e vai só para ele
    const sv = created ? null : await store.getSave(lname);
    c.lastPlay = sv ? +sv.play || 0 : 0;
    send(c, { t: 'auth_ok', name: acc.name, p: c.pid, created, save: sv ? { data: sv.data, play: sv.play, t: sv.t } : null });
    send(c, { t: 'hist', l: chatHist });
    send(c, { t: 'ally', a: allyState(c.aid) });
    const inv = invitesOf(lname); if (inv.length) send(c, { t: 'ainv', l: inv });
    whoDirty = true;
    if (c.aid) pushAlly(c.aid);
    sysChat('👋 ' + acc.name + ' entrou no jogo.');
    log('entrou:', acc.name, created ? '(conta nova)' : '');
  });
}

function saveMsg(c, msg) {
  if (c.kicked) return;
  const now = Date.now();
  if (now - c.saveT < 3000 && !msg.force) return send(c, { t: 'saved', skip: 1 });
  const data = msg.data;
  if (typeof data !== 'string' || data.length < 10 || data.length > MAX_SAVE) return send(c, { t: 'note', msg: 'Save inválido ou grande demais para o servidor.' });
  const play = Math.max(0, +msg.play || 0);
  c.saveT = now;
  const lname = c.lname;
  return serial('save:' + lname, async () => {
    // um aparelho com save mais velho não sobrescreve um save mais jogado (a não ser que o jogador mande)
    if (!msg.force && play + 120 < c.lastPlay) return send(c, { t: 'save_old', play: c.lastPlay });
    await store.putSave(lname, { data, play, t: now });
    c.lastPlay = play;
    send(c, { t: 'saved', at: now });
  }).catch((e) => { log('save:', e.message); send(c, { t: 'note', msg: 'O servidor não conseguiu salvar agora. Seu save continua no navegador.' }); });
}

function allyMsg(c, msg) {
  const op = msg.op;
  if (op === 'create') {
    if (c.aid) return send(c, { t: 'note', msg: 'Você já está numa aliança.' });
    const name = cleanName(msg.name);
    if (!name) return send(c, { t: 'note', msg: 'O nome da aliança precisa de 2 a 20 letras.' });
    for (const a of alliances.values()) if (a.name.toLowerCase() === name.toLowerCase()) return send(c, { t: 'note', msg: 'Já existe uma aliança com esse nome.' });
    const id = crypto.randomBytes(6).toString('hex');
    alliances.set(id, { id, name, owner: c.lname, members: [{ l: c.lname, n: c.name }], created: Date.now() });
    allyOf.set(c.lname, id); c.aid = id; saveAlliances();
    pushAlly(id); whoDirty = true;
    sysChat('🤝 ' + c.name + ' fundou a aliança ' + name + '.');
    return;
  }
  if (op === 'invite') {
    const a = alliances.get(c.aid); if (!a) return send(c, { t: 'note', msg: 'Crie uma aliança primeiro.' });
    if (a.members.length >= MAX_ALLY) return send(c, { t: 'note', msg: 'A aliança já está cheia (' + MAX_ALLY + ').' });
    const x = clients.get(String(msg.p)); if (!x || !x.authed || x === c) return;
    if (x.aid) return send(c, { t: 'note', msg: x.name + ' já está em outra aliança.' });
    let s = invites.get(x.lname); if (!s) { s = new Set(); invites.set(x.lname, s); }
    s.add(a.id);
    send(x, { t: 'ainv', l: invitesOf(x.lname), from: c.name });
    send(c, { t: 'note', msg: 'Convite enviado para ' + x.name + '.' });
    return;
  }
  if (op === 'accept' || op === 'decline') {
    const id = String(msg.id || ''), s = invites.get(c.lname);
    if (!s || !s.has(id)) return;
    s.delete(id);
    if (op === 'decline') { send(c, { t: 'ainv', l: invitesOf(c.lname) }); return; }
    if (c.aid) return send(c, { t: 'note', msg: 'Saia da sua aliança antes de entrar em outra.' });
    const a = alliances.get(id); if (!a) return send(c, { t: 'note', msg: 'Essa aliança não existe mais.' });
    if (a.members.length >= MAX_ALLY) return send(c, { t: 'note', msg: 'A aliança já está cheia.' });
    a.members.push({ l: c.lname, n: c.name }); allyOf.set(c.lname, id); c.aid = id; saveAlliances();
    invites.delete(c.lname);
    send(c, { t: 'ainv', l: [] });
    pushAlly(id); whoDirty = true;
    sysChat('🤝 ' + c.name + ' entrou na aliança ' + a.name + '.');
    return;
  }
  if (op === 'leave' || op === 'kick') {
    const a = alliances.get(c.aid); if (!a) return;
    let who = c.lname;
    if (op === 'kick') { if (a.owner !== c.lname) return; who = String(msg.l || '').toLowerCase(); if (who === c.lname) return; }
    const mb = a.members.find((x) => x.l === who); if (!mb) return;
    a.members = a.members.filter((x) => x.l !== who); allyOf.delete(who);
    const xc = byName.get(who); if (xc) { xc.aid = null; send(xc, { t: 'ally', a: null }); }
    if (!a.members.length) { alliances.delete(a.id); sysChat('🤝 A aliança ' + a.name + ' acabou.'); }
    else { if (a.owner === who) a.owner = a.members[0].l; pushAlly(a.id); sysChat('🤝 ' + mb.n + (op === 'kick' ? ' foi removido da' : ' saiu da') + ' aliança ' + a.name + '.'); }
    saveAlliances(); whoDirty = true;
  }
}

function kick(c, why) {
  send(c, { t: 'kick', msg: why });
  c.kicked = true;
  logout(c, null);
}
function logout(c, why) {
  if (!c.authed) return;
  leaveRoom(c);
  if (byName.get(c.lname) === c) byName.delete(c.lname);
  const name = c.name, aid = c.aid;
  c.authed = false; c.online = false; c.aid = null;
  whoDirty = true;
  if (aid) pushAlly(aid);
  if (why) sysChat('🚪 ' + name + ' ' + why + '.');
}

/* ============================================================
   HTTP + WEBSOCKET
   ============================================================ */
let page = null, pageGz = null;
function loadPage() {
  try {
    page = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
    pageGz = zlib.gzipSync(page, { level: 9 });
    log('jogo carregado:', Math.round(page.length / 1024) + ' KB (' + Math.round(pageGz.length / 1024) + ' KB comprimido)');
  } catch (e) { page = null; log('aviso: public/index.html não encontrado — o servidor funciona, mas não serve o jogo'); }
}
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/status') {
    let authed = 0, online = 0; for (const c of clients.values()) { if (c.authed) authed++; if (c.online) online++; }
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, jogo: !!page, jogadores: authed, modoOnline: online, salas: rooms.size, armazenamento: store.kind, uptime: Math.round(process.uptime()) }));
    return;
  }
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (url === '/' || url === '/index.html' || url === '/AHD.html') {
    if (!page) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Coloque o jogo (AHD.html) em public/index.html'); return; }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...(gz ? { 'content-encoding': 'gzip' } : {}), vary: 'accept-encoding' });
    res.end(gz ? pageGz : page);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('não encontrado');
});

WS.attach(server, { path: '/ws', maxPayload: MAX_SAVE + 64 * 1024 }, (ws, req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const c = { ws, pid: (++seq).toString(36), ip, authed: false, online: false, away: false, kicked: false, name: '', lname: '', room: null, map: '', aid: null,
    prof: { lv: 1, ti: null, cl: null, mx: 0 }, chatT: [], saveT: 0, lastPlay: 0, q: Promise.resolve(), alive: true, rate: 0, rateT: Date.now() };
  clients.set(c.pid, c);
  send(c, { t: 'welcome', p: c.pid, v: PROTO, store: store.kind });
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (buf) => {
    // limite de mensagens por segundo (o jogo manda ~30/s em pacotes)
    const now = Date.now();
    if (now - c.rateT > 1000) { c.rateT = now; c.rate = 0; }
    if (++c.rate > 150) return;
    let msg; try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
    c.q = c.q.then(() => handle(c, msg)).catch((e) => log('erro:', e && e.stack || e));
  });
  ws.on('close', () => {
    clients.delete(c.pid);
    if (c.authed) logout(c, 'saiu do jogo');
    else leaveRoom(c);
  });
});

// mantém as conexões vivas e derruba as mortas
setInterval(() => { for (const c of clients.values()) { if (!c.alive) { try { c.ws.terminate(); } catch (e) { /* já foi */ } continue; } c.alive = false; try { c.ws.ping(); } catch (e) { /* ok */ } } }, 25000);
// lista de quem está online (no máximo 1x por segundo)
setInterval(() => { if (whoDirty) { whoDirty = false; broadcastAuthed({ t: 'who', l: whoList() }); } }, 1000);
// boosts vencidos e gravação das alianças/chat
setInterval(() => {
  const n = boosts.size; boostList(); if (boosts.size !== n) broadcastBoosts();
  if (allyDirty) { allyDirty = false; store.putKV('aliancas', [...alliances.values()]).catch((e) => log('alianças:', e.message)); }
  if (chatDirty) { chatDirty = false; store.putKV('chat', chatHist.slice(-CHAT_KEEP)).catch(() => {}); }
}, 5000);

async function main() {
  await store.init();
  const al = (await store.getKV('aliancas').catch(() => null)) || [];
  for (const a of al) { if (!a || !a.id || !Array.isArray(a.members) || !a.members.length) continue; alliances.set(a.id, a); for (const m of a.members) allyOf.set(m.l, a.id); }
  chatHist = ((await store.getKV('chat').catch(() => null)) || []).slice(-CHAT_KEEP);
  chatSeq = chatHist.reduce((m, x) => Math.max(m, x.id || 0), 0);
  loadPage();
  server.listen(PORT, () => log('A Hero\'s Destiny online na porta ' + PORT + ' · armazenamento: ' + store.kind + (store.kind === 'arquivos' ? ' (' + DATA_DIR + ')' : '')));
}
function shutdown() {
  log('desligando...');
  const done = () => process.exit(0);
  Promise.all([store.putKV('aliancas', [...alliances.values()]).catch(() => {}), store.putKV('chat', chatHist).catch(() => {})]).then(done, done);
  setTimeout(done, 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// um erro inesperado fica no log; o servidor continua de pé para os outros jogadores
process.on('uncaughtException', (e) => log('erro inesperado:', e && e.stack || e));
process.on('unhandledRejection', (e) => log('promessa rejeitada:', e && e.stack || e));
main().catch((e) => { console.error('Falha ao iniciar:', e); process.exit(1); });
