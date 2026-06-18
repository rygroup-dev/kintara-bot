// ============ BANK — deposit barang ke bankSlots (safety sebelum combat) ============
// Confirmed live: walk ke gedung bank Mainland (col6.5,row13 = world -24,-17.5),
// pindah invSlots->bankSlots via save-backpack, carried total turun (aman kalau mati).
const gs = require('./gameState');

const BANK_WORLD = { x: 6.5 - 30.5, z: 13 - 30.5 }; // -24, -17.5

/**
 * Deposit resource tertentu (atau semua tradeable) ke bank. HARUS sudah di posisi
 * bank Mainland (panggil presence.walkTo(BANK_WORLD) dulu, region=world).
 * @param {KintaraClient} cli
 * @param {string[]} types resource types yg di-bank
 * @returns {Promise<{moved:string[], ok:boolean}>}
 */
async function depositAll(cli, types = ['wood', 'stone', 'coal', 'metal', 'fish', 'cooked_fish_meat']) {
  const st = await gs.fetchState(cli); const bp = st.backpack;
  const inv = bp.invSlots || []; const bank = bp.bankSlots || [];
  const moved = [];
  for (const type of types) {
    let movedQty = 0;
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
  if (!moved.length) return { moved: [], ok: true };
  try { await gs.pushBackpack(cli, bp, st.stateSeq, []); return { moved, ok: true }; }
  catch (e) { return { moved, ok: false, err: e.message }; }
}

module.exports = { depositAll, BANK_WORLD };
