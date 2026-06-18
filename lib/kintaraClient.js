// ============ KINTARA REST CLIENT ============
// Wrapper tipis di atas fetch global (Node 18+) dengan:
// - cookie session injection (Opsi A)
// - retry + timeout
// - logging error ke errorbus
const { config } = require('../config');
const { login } = require('./walletAuth');

const DEFAULT_TIMEOUT = 15000;
// Re-login otomatis maksimal sekali per 15s, hindari storm saat server 401 beruntun.
const RELOGIN_MIN_GAP_MS = 15000;

class KintaraClient {
  constructor({ apiBase = config.apiBase, fanoutBase = config.fanoutBase, cookie = config.sessionCookie, autoLogin = false, privateKey = config.walletPrivateKey } = {}) {
    this.apiBase = apiBase;
    this.fanoutBase = fanoutBase;
    this.cookie = cookie || '';
    this.autoLogin = autoLogin;
    this.privateKey = privateKey;
    this.player = null;
    this._lastError = null;
    this._lastLoginAt = 0;
    this._loginInflight = null;
  }

  setCookie(cookie) {
    this.cookie = cookie;
  }

  /**
   * Login sendiri pakai walletAuth (private key) -> set cookie + player.
   * De-dupe: panggilan paralel share satu promise. Hormati RELOGIN_MIN_GAP_MS.
   * @returns {Promise<object>} player
   */
  async ensureLogin(force = false) {
    if (this._loginInflight) return this._loginInflight;
    if (!force && this.cookie) return this.player;
    if (!force && Date.now() - this._lastLoginAt < RELOGIN_MIN_GAP_MS && this.cookie) return this.player;
    this._loginInflight = (async () => {
      const auth = await login(this.privateKey);
      this.cookie = auth.cookie;
      this.player = auth.player || this.player;
      this._lastLoginAt = Date.now();
      return this.player;
    })();
    try {
      return await this._loginInflight;
    } finally {
      this._loginInflight = null;
    }
  }

  /** Factory: login dulu lalu kembalikan {client, player}. Gantikan boilerplate login()+new di caller. */
  static async create(opts = {}) {
    const client = new KintaraClient({ autoLogin: true, ...opts });
    const player = await client.ensureLogin(true);
    return { client, player };
  }

  /**
   * Internal request helper.
   * @param {'GET'|'POST'} method
   * @param {string} base - apiBase or fanoutBase
   * @param {string} pathname
   * @param {object|null} body
   * @param {number} timeoutMs
   */
  async _request(method, base, pathname, body = null, timeoutMs = DEFAULT_TIMEOUT, _retried = false) {
    if (!this.cookie) {
      if (this.autoLogin) {
        await this.ensureLogin();
      } else {
        throw new Error('KINTARA_SESSION_COOKIE belum diset di .env — login manual dulu di browser lalu copy cookie, atau pakai autoLogin/WALLET_PRIVATE_KEY.');
      }
    }

    const url = base + pathname;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers = {
      Cookie: this.cookie,
      Accept: 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        // Non-JSON response (kemungkinan HTML login page -> cookie expired)
        if (this.autoLogin && !_retried) {
          clearTimeout(timer);
          await this.ensureLogin(true);
          return this._request(method, base, pathname, body, timeoutMs, true);
        }
        throw new Error(`Non-JSON response (status ${res.status}) — kemungkinan cookie expired/invalid. Body: ${text.slice(0, 200)}`);
      }

      if (!res.ok) {
        // Auto re-login sekali kalau cookie expired (401) dan autoLogin aktif.
        if (res.status === 401 && this.autoLogin && !_retried) {
          clearTimeout(timer);
          await this.ensureLogin(true);
          return this._request(method, base, pathname, body, timeoutMs, true);
        }
        const err = new Error(json?.error || json?.message || `HTTP ${res.status} on ${pathname}`);
        err.status = res.status;
        err.body = json;
        throw err;
      }

      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Generic helpers ----
  get(pathname, timeoutMs) { return this._request('GET', this.apiBase, pathname, null, timeoutMs); }
  post(pathname, body, timeoutMs) { return this._request('POST', this.apiBase, pathname, body, timeoutMs); }
  fanoutGet(pathname, timeoutMs) { return this._request('GET', this.fanoutBase, pathname, null, timeoutMs); }
  fanoutPost(pathname, body, timeoutMs) { return this._request('POST', this.fanoutBase, pathname, body, timeoutMs); }

  // ============ AUTH & PLAYER ============
  me() { return this.get('/api/auth/me'); }
  playerStats(playerId) { return this.get(`/api/auth/player-stats?playerId=${playerId}`); }
  viewerLevel() { return this.get('/api/auth/viewer-level'); }
  saveMotto(motto) { return this.post('/api/auth/save-motto', { motto }); }
  clientSettings(settings) { return this.post('/api/auth/client-settings', settings); }
  profileBadge(badge) { return this.post('/api/auth/profile-badge', badge); }
  logout() { return this.post('/api/auth/logout', {}); }

  // ============ BACKPACK / INVENTORY ============
  // PENTING: save-backpack memerlukan objek backpack LENGKAP (resources nested,
  // invSlots, hotbar, mountSlots, bankSlots, ..., baseSeq, intentionalRemovals).
  // Bangun body-nya via lib/gameState.buildBackpackBody — JANGAN kirim partial
  // (resiko wipe inventory). Lihat lib/gameState.js.
  saveBackpack(fullBackpackBody) { return this.post('/api/auth/save-backpack', fullBackpackBody); }
  saveHp(hp) { return this.post('/api/auth/save-hp', { hp }); }
  saveSpawn(realm, col, row) { return this.post('/api/auth/save-spawn', { realm, col, row }); }
  saveOutfit(outfit) { return this.post('/api/auth/save-outfit', outfit); }
  saveSkills(skillXp, baseSeq) {
    const body = { skillXp };
    if (baseSeq !== undefined) body.baseSeq = baseSeq;
    return this.post('/api/auth/save-skills', body);
  }
  grantTool(type) { return this.post('/api/auth/grant-tool', { type }); }

  // ============ FISHING / COOKING ============
  grantFishXp(payload = {}) { return this.post('/api/auth/grant-fish-xp', payload); }
  grantCookXp(payload = {}) { return this.post('/api/auth/grant-cook-xp', payload); }

  // ============ POTIONS ============
  consumePotion(type) { return this.post('/api/auth/consume-potion', { type }); }
  alchemistPotionBuy(potionType, qty = 1) { return this.post('/api/auth/alchemist-potion-buy', { potionType, qty }); }
  alchemistMountBuy(payload) { return this.post('/api/auth/alchemist-mount-buy', payload); }

  // ============ WILDERNESS / HUNTING ============
  groundBags(shardId) { return this.get(`/api/wild/ground-bags?shard=${shardId}`); }
  lootBag(bagId) { return this.post('/api/wild/loot-bag', { bagId }); }
  wildDie(payload = {}) { return this.post('/api/wild/die', payload); }

  // ============ MARKETPLACE ============
  marketplaceListings({ limit = 20, offset = 0, itemType = null, mine = false } = {}) {
    const params = new URLSearchParams({ limit, offset });
    if (itemType) params.set('itemType', itemType);
    if (mine) params.set('mine', '1');
    return this.get(`/api/marketplace/listings?${params.toString()}`);
  }
  marketplaceStats(itemType) { return this.get(`/api/marketplace/stats?itemType=${itemType}`); }
  marketplaceReleaseReserve(listingId) { return this.post('/api/marketplace/release-reserve', { listingId }); }
  // Jual item dari inventory. payload: {itemType, slotKind:'inv', slotIndex, quantity, currency:'gold', priceGold}
  marketplaceSell(payload) { return this.post('/api/marketplace/sell', payload); }
  marketplaceCancel(listingId) { return this.post('/api/marketplace/cancel', { listingId }); }
  marketplaceTokenQuote(payload) { return this.post('/api/marketplace/token-quote', payload); }
  marketplaceTokenBuyConfirm(payload) { return this.post('/api/marketplace/token-buy-confirm', payload); }

  // ============ CRAFTING / BLACKSMITH / SHOP ============
  blacksmithSmith(payload) { return this.post('/api/auth/blacksmith-smith', payload); }
  cosmeticShopBuy(payload) { return this.post('/api/auth/cosmetic-shop-buy', payload); }
  petShopBuy(payload) { return this.post('/api/auth/pet-shop-buy', payload); }
  furnitureShopBuy(payload) { return this.post('/api/auth/furniture-shop-buy', payload); }
  merchantTradeForGold(payload) { return this.post('/api/auth/merchant-trade-for-gold', payload); }

  // ============ WORLD / CHAT ============
  worldChat(afterMsgId, region = 'world', shard = 1) {
    return this.fanoutGet(`/api/world/chat?after=${afterMsgId}&region=${region}&shard=${shard}`);
  }
  worldChatBootstrap(region = 'world', shard = 1) {
    return this.fanoutGet(`/api/world/chat/bootstrap?region=${region}&shard=${shard}`);
  }
  sendWorldChat(message, region = 'world', shard = 1) {
    return this.post('/api/world/chat', { message, region, shard });
  }

  expansionTribute() { return this.fanoutGet('/api/world/expansion-tribute'); }
  expansionTributeContribute(payload) { return this.post('/api/world/expansion-tribute/contribute', payload); }

  merchantCampaign() { return this.fanoutGet('/api/world/merchant-campaign'); }
  merchantCampaignContribute(payload) { return this.post('/api/world/merchant-campaign/contribute', payload); }

  // ============ DAILY QUEST ============
  dailyQuestProgress() { return this.post('/api/auth/daily-quest-progress', {}); }
  dailyQuestClaim(questId) { return this.post('/api/auth/daily-quest-claim', { questId }); }

  // ============ CASINO & SPINNER ============
  dailySpinnerSpin() { return this.post('/api/auth/daily-spinner-spin', {}); }
  spinnerPaidTicker() { return this.post('/api/auth/spinner-paid-ticker', {}); }
  spinnerPaidQuote() { return this.post('/api/auth/spinner-paid-quote', {}); }
  spinnerPaidConfirm(payload) { return this.post('/api/auth/spinner-paid-confirm', payload); }

  blackjackDebit(bet) { return this.post('/api/auth/casino-blackjack-debit', { bet }); }
  blackjackAction(action) { return this.post('/api/auth/casino-blackjack-action', { action }); }
  blackjackRefund() { return this.post('/api/auth/casino-blackjack-refund', {}); }
  blackjackRecover() { return this.post('/api/auth/casino-blackjack-recover', {}); }
  blackjackSettle() { return this.post('/api/auth/casino-blackjack-settle', {}); }
  rouletteSpin(payload) { return this.post('/api/auth/casino-roulette-spin', payload); }

  // ============ PROPERTY ============
  mansionStatus(id) { return this.get(`/api/mansion/${id}`); }
  houseStatus(id) { return this.get(`/api/house/${id}/status`); }
  trailerStatus(id) { return this.get(`/api/trailer/${id}/status`); }
  flatStatus(id) { return this.get(`/api/flat/${id}/status`); }
  housePurchase(id) { return this.post(`/api/house/${id}/purchase`, {}); }
  trailerPurchase(id) { return this.post(`/api/trailer/${id}/purchase`, {}); }
  flatPurchase(id) { return this.post(`/api/flat/${id}/purchase`, {}); }
  mansionLock(id) { return this.post(`/api/mansion/${id}/lock`, {}); }
  houseLock(id) { return this.post(`/api/house/${id}/lock`, {}); }
  houseUnlock(id) { return this.post(`/api/house/${id}/unlock`, {}); }
  houseTry(id) { return this.post(`/api/house/${id}/try`, {}); }

  // ============ BANK ============
  bankUnlockPage(page) { return this.post('/api/bank/unlock-page', { page }); }

  // ============ FRIENDS & DM ============
  friendsList() { return this.get('/api/friends/list'); }
  friendsPendingCount() { return this.get('/api/friends/pending-count'); }
  friendsSearch(query) { return this.get(`/api/friends/search?query=${encodeURIComponent(query)}`); }
  dmUnreadSummary() { return this.get('/api/friends/dm/unread-summary'); }
  friendsAccept(payload) { return this.post('/api/friends/accept', payload); }
  friendsCancelOutgoing(payload) { return this.post('/api/friends/cancel-outgoing', payload); }
  dmMarkRead(payload) { return this.post('/api/friends/dm/mark-read', payload); }

  // ============ TOKEN & SERVER INFO ============
  tokenBlimpStats() { return this.fanoutGet('/api/token/blimp-stats'); }
  servers() { return this.get('/api/servers'); }
  version() { return this.get('/api/version'); }
  propertySignsStatus() { return this.fanoutGet('/api/property-signs/status'); }

  // ============ PLAYER REPORT ============
  reportPlayer(payload) { return this.post('/api/auth/player-report', payload); }
}

module.exports = { KintaraClient, DEFAULT_TIMEOUT };
