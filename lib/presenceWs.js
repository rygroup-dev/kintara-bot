// ============ PRESENCE WS — client headless (Path A, no browser) ============
// Replicates the game client connection:
//   1) login wallet -> cookie kintara_session
//   2) connect to wss://kintara.gg/ws/queue/<shard>, send {t:q_ping} until {t:queue_ready}
//   3) connect to wss://kintara.gg/ws/presence/<shard>, send {t:pos,...}
// Set region via pos -> server replies with {t:region_ack}. This gates region actions like fishing.
const WebSocket = require('ws');
const EventEmitter = require('events');
const { login } = require('./walletAuth');
const { config } = require('../config');

const HOST = 'kintara.gg';

class Presence extends EventEmitter {
  constructor(shard = config.shard) {
    super();
    this.shard = shard;
    this.cookie = null;
    this.queueWs = null;
    this.presenceWs = null;
    this.ready = false;
    this.region = 'world';
    this.pos = { x: 8.5, y: 0.25, z: 13.5, ry: 0 };
    this._qping = null;
    this._posTimer = null;
  }

  log(...a) { this.emit('log', a.join(' ')); }

  async connect() {
    const auth = await login();
    this.cookie = auth.cookie;
    this.player = auth.player;
    this.myId = auth.player?.id;
    this.log('walletAuth ok pid=' + auth.player?.id);
    await this._queue();
  }

  _wsOpts() { return { headers: { Cookie: this.cookie, Origin: 'https://kintara.gg' } }; }

  _queue() {
    return new Promise((resolve, reject) => {
      const url = `wss://${HOST}/ws/queue/${this.shard}`;
      this.log('connect queue ' + url);
      const ws = new WebSocket(url, this._wsOpts());
      this.queueWs = ws;
      const to = setTimeout(() => reject(new Error('queue connect timeout')), 20000);
      ws.on('open', () => { clearTimeout(to); this.log('queue open'); this._qping = setInterval(() => { try { ws.send(JSON.stringify({ t: 'q_ping' })); } catch {} }, 5000); ws.send(JSON.stringify({ t: 'q_ping' })); });
      ws.on('message', (buf) => {
        let d; try { d = JSON.parse(buf.toString()); } catch { return; }
        if (d.t === 'queue_pos') this.emit('queue', d);
        else if (d.t === 'queue_ready') { this.log('queue_ready -> presence'); clearInterval(this._qping); try { ws.close(); } catch {} this._presence().then(resolve).catch(reject); }
      });
      ws.on('error', (e) => { clearTimeout(to); reject(new Error('queue ws err: ' + e.message)); });
      ws.on('close', () => { clearInterval(this._qping); });
    });
  }

  _presence() {
    return new Promise((resolve, reject) => {
      const url = `wss://${HOST}/ws/presence/${this.shard}`;
      this.log('connect presence ' + url);
      const ws = new WebSocket(url, this._wsOpts());
      this.presenceWs = ws;
      const to = setTimeout(() => reject(new Error('presence connect timeout')), 20000);
      ws.on('open', () => {
        clearTimeout(to); this.ready = true; this.log('presence open');
        this._sendPos(true);
        this._posTimer = setInterval(() => this._sendPos(false), 3000); // heartbeat posisi
        resolve();
      });
      ws.on('message', (buf) => {
        let d; try { d = JSON.parse(buf.toString()); } catch { return; }
        this.emit('msg', d);
        if (d.t === 'region_ack') { this.region = d.region; this.emit('region_ack', d); }
        else if (d.t === 'snap') this.emit('snap', d);
        else if (d.t === 'res_evt') { this._onResEvt(d); this.emit('res_evt', d); }
        else if (d.t === 'res_snap') this.emit('res_snap', d);
        else if (d.t === 'harv_full') this.emit('harv_full', d);
      });
      ws.on('error', (e) => { clearTimeout(to); reject(new Error('presence ws err: ' + e.message)); });
      ws.on('close', () => { clearInterval(this._posTimer); this.ready = false; this.emit('close'); });
    });
  }

  _sendPos(full) {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    const base = { t: 'pos', region: this.region, x: this.pos.x, y: 0.25, z: this.pos.z, ry: this.pos.ry, mov: false, le: 0, tut: 18 };
    if (full) base.outfit = { outfitSchema: 15, hat: 0, top: 0, pants: 0, shoe: 0, skinTone: 1 };
    // gather action (chop/mine/fish) — server needs this to gate grant-*-xp
    if (this.act) { base.act = this.act; if (this.act === 'fish') { base.fc = this.fishCastCol; base.fr = this.fishCastRow; base.fph = this.fishPhase; } }
    // wild blocked-tile manifest (host -> hub) so the hub can spawn/path mobs (wildMobs in snap)
    if (this.pendingWblk) { base.wblk = this.pendingWblk; this.pendingWblk = null; }
    try { this.presenceWs.send(JSON.stringify(base)); } catch {}
  }

  /** Set fishing action in pos (act='fish' + cast tile + phase). Pond tile col/row. */
  setFishing(castCol, castRow, phase) { this.act = 'fish'; this.fishCastCol = castCol; this.fishCastRow = castRow; this.fishPhase = phase; this._sendPos(false); }
  setAct(a) { this.act = a || null; this._sendPos(false); }
  /** Send wild blocked-tile manifest to the hub (host) -> hub spawns/paths mobs. tiles=['col,row',...] */
  sendWildManifest(tiles) { this.pendingWblk = tiles && tiles.length ? tiles : null; this._sendPos(false); }

  // ===== GATHER (harvest) =====
  // Learn node locations from res_evt broadcasts (tile key + kind + actionProof).
  _onResEvt(d) {
    if (!this.nodes) this.nodes = new Map();
    for (const k of (d.keys || [])) {
      const cur = this.nodes.get(k) || {};
      this.nodes.set(k, { kind: d.kind, hasCoal: !!d.hasCoal, hasMetal: !!d.hasMetal, lastProof: d.actionProof || cur.lastProof, seen: Date.now() });
    }
    // proof for the node we harvested
    if (this.myId && d.by === this.myId && d.actionProof) { this._lastMyProof = { keys: d.keys, proof: d.actionProof }; }
  }
  /** Current node list by kind (from res_evt). */
  knownNodes(kind) { return [...(this.nodes || new Map()).entries()].filter(([, v]) => v.kind === kind).map(([k, v]) => ({ key: k, ...v })); }

  /** Start harvesting a node; server replies with actionProof for this node. keys=['col,row']. */
  sendHarv(kind, keys, hasCoal = false) {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    const uniq = [...new Set(keys.map(String))].sort();
    try { this.presenceWs.send(JSON.stringify({ t: 'harv', region: this.region, k: kind, keys: uniq, hasCoal })); } catch {}
  }
  /** Harvest 1 full node (event-driven): harv -> each res_evt refreshes proof+h -> harv_hit until felled. */
  async harvestNode(kind, key, hasCoal = false, hasMetal = false, { maxHits = 10, hitGap = 1700 } = {}) {
    this.setAct(kind === 'tree' ? 'chop' : 'mine');
    let h = 0, hm = 99, lastProof = '', loot = null, hits = 0;
    const onEvt = (d) => { if (d.by === this.myId && (d.keys || []).includes(key)) { h = d.h; hm = d.hm; if (d.actionProof) lastProof = d.actionProof; loot = d.loot; } };
    this.on('res_evt', onEvt);
    this.sendHarv(kind, [key], hasCoal);
    for (let i = 0; i < maxHits; i++) {
      await new Promise((r) => setTimeout(r, hitGap));
      if (hm < 99 && h >= hm) break; // felled
      this.sendHarvHit(kind, [key], hasCoal, hasMetal, lastProof); hits++;
    }
    await new Promise((r) => setTimeout(r, 800));
    this.removeListener('res_evt', onEvt); this.clearAct();
    return { felled: hm < 99 && h >= hm, h, hm, hits, loot };
  }

  /** Harvest hit; echoes the actionProof obtained from snap/res_evt for this node. */
  sendHarvHit(kind, keys, hasCoal, hasMetal, actionProof) {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    const uniq = [...new Set(keys.map(String))].sort();
    const payload = { t: 'harv_hit', region: this.region, k: kind, keys: uniq, hasCoal: !!hasCoal, hasMetal: !!hasMetal };
    if (actionProof) payload.actionProof = actionProof;
    try { this.presenceWs.send(JSON.stringify(payload)); } catch {}
  }
  clearAct() { this.act = null; this._sendPos(false); }
  /** Convert world x/z -> tile col/row for the active realm (pond offset=-19.5). */
  pondTile() { return { col: Math.round(this.pos.x + 19.5), row: Math.round(this.pos.z + 19.5) }; }

  /** Change realm + position. Server replies with region_ack. */
  setRegion(region, x, z) { this.region = region; if (x != null) this.pos.x = x; if (z != null) this.pos.z = z; this._sendPos(true); }
  moveTo(x, z) { this.pos.x = x; this.pos.z = z; this._sendPos(false); }

  _sendPosMoving() {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    try { this.presenceWs.send(JSON.stringify({ t: 'pos', region: this.region, x: this.pos.x, y: 0.25, z: this.pos.z, ry: this.pos.ry, mov: true, le: 0, tut: 18 })); } catch {}
  }

  /** Walk realistically to (tx,tz) in world coords, sending pos at MOVE_SPEED. Stops when until() returns true. */
  async walkTo(tx, tz, { speed = 3.5, dt = 0.15, until = null, maxSec = 30 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const dx = tx - this.pos.x, dz = tz - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.4) break;
      if (until && until()) return 'until';
      if ((Date.now() - t0) / 1000 > maxSec) return 'timeout';
      const move = Math.min(dist, speed * dt);
      this.pos.x += (dx / dist) * move;
      this.pos.z += (dz / dist) * move;
      this.pos.ry = Math.atan2(dx, dz);
      this._sendPosMoving();
      await new Promise((r) => setTimeout(r, dt * 1000));
    }
    this.pos.x = tx; this.pos.z = tz; this._sendPos(false);
    return 'arrived';
  }
  close() { try { this.presenceWs?.close(); } catch {} try { this.queueWs?.close(); } catch {} clearInterval(this._qping); clearInterval(this._posTimer); }
}

module.exports = { Presence };

// ---- CLI smoke test: connect, enter, wait for region_ack + sample snap ----
if (require.main === module) {
  const p = new Presence(process.argv[2] || config.shard);
  p.on('log', (m) => console.log('[ws]', m));
  p.on('queue', (d) => process.stdout.write(`queue ahead=${d.ahead}  \r`));
  p.on('region_ack', (d) => console.log('\n✅ region_ack:', d.region));
  let snaps = 0; p.on('snap', (d) => { if (snaps++ === 0) console.log('snap: region=' + d.region + ' online=' + d.onlineTotal + ' players=' + (d.players?.length)); });
  p.connect()
    .then(() => { console.log('✅ PRESENCE LIVE region=' + p.region + ' pos=', p.pos); setTimeout(() => { console.log('done sample'); p.close(); process.exit(0); }, 12000); })
    .catch((e) => { console.error('🛑', e.message); process.exit(1); });
}
