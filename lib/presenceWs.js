// ============ PRESENCE WS — client headless (Path A, no browser) ============
// Replikasi koneksi game client:
//   1) login wallet -> cookie kintara_session
//   2) connect wss://kintara.gg/ws/queue/<shard>, kirim {t:q_ping} s/d {t:queue_ready}
//   3) connect wss://kintara.gg/ws/presence/<shard>, kirim {t:pos,...}
// Set region via pos -> server bales {t:region_ack}. Itu gerbang aksi region (fishing).
const WebSocket = require('ws');
const EventEmitter = require('events');
const { login } = require('./walletAuth');
const { config } = require('../config');

const HOST = 'kintara.gg';

class Presence extends EventEmitter {
  constructor(shard = config.shard || 's2') {
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
    // combat / survival state
    this.eq = null;            // equipped item type (wild_sword utk combat)
    this.hp = 100;             // server-authoritative, di-update dari wild_mb_ack/snap self-entry
    this.shield = 0;           // shield charges (0-5), dari potion_shield
    this.lifeEpoch = 0;        // le terakhir dari server (echo di pos/wm_ev)
    this.wildMobs = [];        // [{i,d,lv,x,z,ry,col,row,alive}] dari snap.npcs.wildMobs
    this._mobsAt = 0;          // timestamp snap mob terakhir
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
        this._trackLifeEpoch(d);
        if (d.t === 'region_ack') { this.region = d.region; this.emit('region_ack', d); }
        else if (d.t === 'snap') { this._onSnap(d); this.emit('snap', d); }
        else if (d.t === 'res_evt') { this._onResEvt(d); this.emit('res_evt', d); }
        else if (d.t === 'res_snap') this.emit('res_snap', d);
        else if (d.t === 'harv_full') this.emit('harv_full', d);
        else if (d.t === 'wild_mb_ack') this._onWildMbAck(d);
        else if (d.t === 'pvit') this._onPvit(d);
        else if (d.t === 'skill_xp' && d.xp) { this.skillXp = d.xp; this.emit('skill_xp', d.xp); }
        else if (d.t === 'wm_ev' && d.a === 'hit' && Number(d.by) === Number(this.myId)) this.emit('wm_kill', d);
      });
      ws.on('error', (e) => { clearTimeout(to); reject(new Error('presence ws err: ' + e.message)); });
      ws.on('close', () => { clearInterval(this._posTimer); this.ready = false; this.emit('close'); });
    });
  }

  _sendPos(full) {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    const base = { t: 'pos', region: this.region, x: this.pos.x, y: 0.25, z: this.pos.z, ry: this.pos.ry, mov: false, le: this.lifeEpoch || 0, tut: 18 };
    if (full) base.outfit = { outfitSchema: 15, hat: 0, top: 0, pants: 0, shoe: 0, skinTone: 1 };
    // aksi gather (chop/mine/fish) — server butuh ini utk gate grant-*-xp
    if (this.act) { base.act = this.act; if (this.act === 'fish') { base.fc = this.fishCastCol; base.fr = this.fishCastRow; base.fph = this.fishPhase; } }
    // equipped item (presence visual + server context). wild_sword wajib utk combat.
    if (this.eq) base.eq = this.eq;
    // wild realm: HP + shield + spawn-protect + blocked-tile manifest (hub butuh utk spawn+path mob)
    if (/^wild/.test(this.region)) {
      base.php = Math.max(0, Math.min(100, this.hp | 0));
      base.wsh = Math.max(0, Math.min(5, this.shield | 0));
      base.wsp = 0;
      if (this.pendingWblk) { base.wblk = this.pendingWblk; this.pendingWblk = null; }
    }
    // wild blocked-tile manifest non-wild path (legacy harvest hosting)
    else if (this.pendingWblk) { base.wblk = this.pendingWblk; this.pendingWblk = null; }
    try { this.presenceWs.send(JSON.stringify(base)); } catch {}
  }

  /** Set aksi mancing di pos (act='fish' + cast tile + fase). Tile pond col/row. */
  setFishing(castCol, castRow, phase) { this.act = 'fish'; this.fishCastCol = castCol; this.fishCastRow = castRow; this.fishPhase = phase; this._sendPos(false); }
  setAct(a) { this.act = a || null; this._sendPos(false); }
  /** Kirim manifest blocked-tile wild ke hub (host) -> hub spawn+path mob. tiles=['col,row',...] */
  sendWildManifest(tiles) { this.pendingWblk = tiles && tiles.length ? tiles : null; this._sendPos(false); }

  // ===== COMBAT (Wilderness) =====
  // Mob server-authoritative: hub broadcast posisi+HP di snap.npcs.wildMobs.
  // Coord wild: world x=col-24.5, z=row-24.5 (WILD 50x50, off=-24.5).
  static WILD_OFF = -24.5;

  /** Track life-epoch dari pesan server (snap/ack bawa le). Echo balik di pos+wm_ev. */
  _trackLifeEpoch(d) {
    const le = d && d.le != null && Number.isFinite(Number(d.le)) ? Number(d.le) | 0 : null;
    if (le != null && le > (this.lifeEpoch | 0)) this.lifeEpoch = le;
  }

  /** Parse snap: extract wildMobs (nested di npcs) + self HP. */
  _onSnap(d) {
    // self HP dari players[] self-entry kalau ada (php)
    if (Array.isArray(d.players) && this.myId != null) {
      const self = d.players.find((p) => Number(p.id) === Number(this.myId));
      if (self && self.php != null && Number.isFinite(Number(self.php))) this.hp = Number(self.php) | 0;
    }
    // wildMobs nested di npcs (INI yg dulu kelewat — recon lama cek top-level)
    const npcs = d.npcs && typeof d.npcs === 'object' ? d.npcs : null;
    const arr = npcs && Array.isArray(npcs.wildMobs) ? npcs.wildMobs : null;
    if (arr && /^wild/.test(this.region)) {
      const OFF = Presence.WILD_OFF;
      this.wildMobs = arr.map((m, i) => {
        const lv = Number(m.lv) | 0;
        const x = Number(m.x), z = Number(m.z);
        return {
          i, d: Number(m.d) === 1 ? 1 : 0, lv, alive: lv > 0,
          x: Number.isFinite(x) ? x : null, z: Number.isFinite(z) ? z : null,
          col: Number.isFinite(x) ? Math.round(x - OFF) : null,
          row: Number.isFinite(z) ? Math.round(z - OFF) : null,
          st: Number(m.st) || 0,
        };
      });
      this._mobsAt = Date.now();
      this.emit('mobs', this.wildMobs);
    }
  }

  /** wild_mb_ack: hub balas HP/shield setelah kita lapor kontak (wmb). Kita gak kirim wmb,
   *  tapi tetap update HP kalau server push (defense-in-depth). */
  _onWildMbAck(d) {
    if (d.php != null && Number.isFinite(Number(d.php))) { this.hp = Number(d.php) | 0; this.emit('hp', this.hp); }
    if (d.wsh != null && Number.isFinite(Number(d.wsh))) this.shield = Number(d.wsh) | 0;
    if (this.hp <= 0) this.emit('died', d);
  }

  /** pvit broadcast — biasanya remote, tapi kalau pid==kita ambil HP. */
  _onPvit(d) {
    if (Number(d.pid) === Number(this.myId)) {
      if (d.php != null && Number.isFinite(Number(d.php))) { this.hp = Number(d.php) | 0; this.emit('hp', this.hp); }
      if (d.wsh != null && Number.isFinite(Number(d.wsh))) this.shield = Number(d.wsh) | 0;
      if (this.hp <= 0) this.emit('died', d);
    }
  }

  /** Equip senjata (broadcast eq di pos). 'wild_sword' wajib utk wm_ev. */
  equip(itemType) { this.eq = itemType || null; this._sendPos(false); }

  /** Tile wild col/row dari posisi sekarang. */
  wildTile() { return { col: Math.round(this.pos.x - Presence.WILD_OFF), row: Math.round(this.pos.z - Presence.WILD_OFF) }; }

  /** Mob hidup terdekat dari posisi sekarang (cheb tile). null kalau gak ada. */
  nearestMob() {
    const me = this.wildTile();
    let best = null, bestD = Infinity;
    for (const m of this.wildMobs) {
      if (!m.alive || m.col == null) continue;
      const dd = Math.max(Math.abs(m.col - me.col), Math.abs(m.row - me.row));
      if (dd < bestD) { bestD = dd; best = m; }
    }
    return best ? { ...best, cheb: bestD } : null;
  }

  /** Kirim hit ke mob index i. n=hitMult (1 base, 2 L2, +1 strength). Hormati cooldown di caller. */
  sendWildMobHit(i, n = 1) {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return false;
    if (!/^wild/.test(this.region)) return false;
    const msg = { t: 'wm_ev', region: this.region, a: 'hit', i: i | 0, le: this.lifeEpoch | 0, px: this.pos.x, pz: this.pos.z };
    if (n > 1) msg.n = n | 0;
    try { this.presenceWs.send(JSON.stringify(msg)); return true; } catch { return false; }
  }


  // ===== GATHER (harvest) =====
  // Belajar lokasi node dari res_evt broadcast (key tile + kind + actionProof).
  _onResEvt(d) {
    if (!this.nodes) this.nodes = new Map();
    for (const k of (d.keys || [])) {
      const cur = this.nodes.get(k) || {};
      this.nodes.set(k, { kind: d.kind, hasCoal: !!d.hasCoal, hasMetal: !!d.hasMetal, lastProof: d.actionProof || cur.lastProof, seen: Date.now() });
    }
    // proof utk node yg KITA panen
    if (this.myId && d.by === this.myId && d.actionProof) { this._lastMyProof = { keys: d.keys, proof: d.actionProof }; }
  }
  /** daftar node terkini by kind (dari res_evt). */
  knownNodes(kind) { return [...(this.nodes || new Map()).entries()].filter(([, v]) => v.kind === kind).map(([k, v]) => ({ key: k, ...v })); }

  /** Mulai harvest node (server balas actionProof utk node ini). keys=['col,row']. */
  sendHarv(kind, keys, hasCoal = false) {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    const uniq = [...new Set(keys.map(String))].sort();
    try { this.presenceWs.send(JSON.stringify({ t: 'harv', region: this.region, k: kind, keys: uniq, hasCoal })); } catch {}
  }
  /** Harvest 1 node penuh (event-driven): harv -> tiap res_evt refresh proof+h -> harv_hit s/d felled. */
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

  /** Hit harvest (echo actionProof yg didapat dari snap/res_evt utk node ini). */
  sendHarvHit(kind, keys, hasCoal, hasMetal, actionProof) {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    const uniq = [...new Set(keys.map(String))].sort();
    const payload = { t: 'harv_hit', region: this.region, k: kind, keys: uniq, hasCoal: !!hasCoal, hasMetal: !!hasMetal };
    if (actionProof) payload.actionProof = actionProof;
    try { this.presenceWs.send(JSON.stringify(payload)); } catch {}
  }
  clearAct() { this.act = null; this._sendPos(false); }
  /** Konversi world x/z -> tile col/row utk realm aktif (pond off=-19.5). */
  pondTile() { return { col: Math.round(this.pos.x + 19.5), row: Math.round(this.pos.z + 19.5) }; }

  /** Pindah realm + posisi. Server akan bales region_ack. */
  setRegion(region, x, z) { this.region = region; if (x != null) this.pos.x = x; if (z != null) this.pos.z = z; this._sendPos(true); }
  moveTo(x, z) { this.pos.x = x; this.pos.z = z; this._sendPos(false); }

  _sendPosMoving() {
    if (!this.presenceWs || this.presenceWs.readyState !== WebSocket.OPEN) return;
    const m = { t: 'pos', region: this.region, x: this.pos.x, y: 0.25, z: this.pos.z, ry: this.pos.ry, mov: true, le: this.lifeEpoch || 0, tut: 18 };
    if (this.eq) m.eq = this.eq;
    if (/^wild/.test(this.region)) {
      m.php = Math.max(0, Math.min(100, this.hp | 0));
      m.wsh = Math.max(0, Math.min(5, this.shield | 0));
      m.wsp = 0;
      if (this.pendingWblk) { m.wblk = this.pendingWblk; this.pendingWblk = null; }
    }
    try { this.presenceWs.send(JSON.stringify(m)); } catch {}
  }

  /** Jalan realistis ke (tx,tz) di world coord, kirim pos @MOVE_SPEED. Berhenti kalau until()=true. */
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

// ---- CLI smoke test: connect, masuk, tunggu region_ack + sampel snap ----
if (require.main === module) {
  const p = new Presence(process.argv[2] || config.shard || 's2');
  p.on('log', (m) => console.log('[ws]', m));
  p.on('queue', (d) => process.stdout.write(`queue ahead=${d.ahead}  \r`));
  p.on('region_ack', (d) => console.log('\n✅ region_ack:', d.region));
  let snaps = 0; p.on('snap', (d) => { if (snaps++ === 0) console.log('snap: region=' + d.region + ' online=' + d.onlineTotal + ' players=' + (d.players?.length)); });
  p.connect()
    .then(() => { console.log('✅ PRESENCE LIVE region=' + p.region + ' pos=', p.pos); setTimeout(() => { console.log('done sample'); p.close(); process.exit(0); }, 12000); })
    .catch((e) => { console.error('🛑', e.message); process.exit(1); });
}
