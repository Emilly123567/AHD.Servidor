/* ============================================================
   WebSocket mínimo (RFC 6455) — sem dependências
   Servidor só de texto: handshake, quadros mascarados do navegador,
   fragmentação, ping/pong e fechamento. Não usa compressão.
   ============================================================ */
'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Conn extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.readyState = 1; // 0 conectando, 1 aberto, 2 fechando, 3 fechado
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragLen = 0;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.finish());
    socket.on('end', () => this.finish());
    socket.on('error', () => this.finish());
  }
  get bufferedAmount() { return this.socket.writableLength || 0; }
  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const hi = b.readUInt32BE(2), lo = b.readUInt32BE(6);
        if (hi > 0) return this.fail(1009);
        len = lo; off = 10;
      }
      if (!masked) return this.fail(1002); // o navegador sempre mascara
      if (len > this.maxPayload || this.fragLen + len > this.maxPayload) return this.fail(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (this.readyState === 3) return;
      if (op === 0x8) { this.close(data.length >= 2 ? data.readUInt16BE(0) : 1000); return; }
      if (op === 0x9) { this.frame(0xA, data); continue; }
      if (op === 0xA) { this.emit('pong'); continue; }
      if (op === 0x1 || op === 0x2) {
        if (this.frags.length) return this.fail(1002);
        if (fin) { this.emit('message', data); continue; }
        this.frags.push(data); this.fragLen = data.length; continue;
      }
      if (op === 0x0) {
        if (!this.frags.length) return this.fail(1002);
        this.frags.push(data); this.fragLen += data.length;
        if (fin) { const all = Buffer.concat(this.frags); this.frags = []; this.fragLen = 0; this.emit('message', all); }
        continue;
      }
      return this.fail(1002);
    }
  }
  frame(op, payload) {
    if (this.readyState !== 1 && op !== 0x8) return;
    const n = payload.length;
    let head;
    if (n < 126) { head = Buffer.alloc(2); head[1] = n; }
    else if (n < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6); }
    head[0] = 0x80 | op;
    try { this.socket.write(head); if (n) this.socket.write(payload); } catch (e) { this.finish(); }
  }
  send(text) { if (this.readyState === 1) this.frame(0x1, Buffer.from(String(text), 'utf8')); }
  ping() { this.frame(0x9, Buffer.alloc(0)); }
  close(code) {
    if (this.readyState >= 2) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code || 1000, 0);
    this.frame(0x8, p);
    this.readyState = 2;
    try { this.socket.end(); } catch (e) { /* já foi */ }
    setTimeout(() => this.terminate(), 2000).unref();
  }
  fail(code) { this.close(code); this.buf = Buffer.alloc(0); }
  terminate() { try { this.socket.destroy(); } catch (e) { /* já foi */ } this.finish(); }
  finish() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}

// liga o WebSocket num servidor http: onConn(conn, req) a cada conexão em `path`
function attach(server, opts, onConn) {
  const path = opts.path || '/ws', maxPayload = opts.maxPayload || 1024 * 1024;
  server.on('upgrade', (req, socket) => {
    const url = (req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    if (url !== path || !key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    onConn(new Conn(socket, maxPayload), req);
  });
}

module.exports = { attach };
