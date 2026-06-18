// ============ BANK — deposit items into bankSlots (safety before combat) ============
// Confirmed live: walk to the Mainland bank building (col6.5,row13 = world -24,-17.5),
// move invSlots -> bankSlots via save-backpack, carried total decreases (safe if you die).
const gs = require('./gameState');

const BANK_WORLD = { x: 6.5 - 30.5, z: 13 - 30.5 }; // -24, -17.5

/**
 * Deposits selected resources, or all tradeables, into the bank. Must already be at the
 * Mainland bank position; call presence.walkTo(BANK_WORLD) first with region=world.
 * @param {KintaraClient} cli
 * @param {string[]} types resource types to bank
 * @returns {Promise<{moved:string[], ok:boolean}>}
 */
async function depositAll(cli, types = ['wood', 'stone', 'coal', 'metal', 'fish', 'cooked_fish_meat']) {
  const st = await gs.fetchState(cli); const bp = st.backpack;
  const inv = bp.invSlots || []; const bank = bp.bankSlots || [];
  const moved = [];
  let movedQty = 0;
  for (const type of types) {
    for (let i = 0; i < inv.length; i++) {
      if (inv[i] && inv[i].t === type && inv[i].n > 0) {
        const n = inv[i].n;
        let bi = bank.findIndex((s) => s && s.t === type);
        if (bi >= 0) bank[bi].n += n;
        else { bi = bank.findIndex((s) => !s); if (bi >= 0) bank[bi] = { t: type, n }; else break; }
        movedQty += n;
        moved.push(`${n} ${type}`);
        inv[i] = null;
      }
    }
    if (movedQty > 0) bp[type] = Math.max(0, Number(bp[type] || 0) - movedQty);
  }
  try { await gs.pushBackpack(cli, bp, st.stateSeq, []); return { moved, ok: true }; }
  catch (e) { return { moved, ok: false, err: e.message }; }
}

module.exports = { depositAll, BANK_WORLD };
