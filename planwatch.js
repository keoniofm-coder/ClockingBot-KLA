// ================== CHANGEMENTS FAITS DEPUIS L'APP ==================
// Sur un shift en cours (ou qui commence dans les 2 h), un changement fait dans l'app (box, modèle, chatteur
// ajouté ou retiré) est annoncé dans le salon box, comme ceux faits depuis Discord.
// Le planning de ces jours-là est relu toutes les 10 s et comparé à la lecture d'avant. Un changement est
// annoncé quand plus rien ne bouge sur ce jour d'une lecture à l'autre (ou au bout de 45 s) : changer un
// chatteur de modèle puis choisir ses box, ou en changer plusieurs à la suite, fait un seul message. Ce que le bot écrit lui-même n'est pas annoncé une deuxième fois (l'action qui
// l'écrit le dit déjà), sauf quand il le demande (la fenêtre « Modifier le shift » : loud, annoncé tout de suite).
const appSync = require("./app-sync");
const { SLOTS, withEmoji, boxList, boxLabel } = require("./planning");
const { tag, fitMsg, running, isNow, slotOf, midsOf } = require("./planedit").helpers;

const ctx = {}; // notify(payload), refresh(date)
const seen = new Map(); // date -> Map("slot|chatterId" -> { accts, boxes })
const sids = new Map(); // date -> Map(sid -> "slot|chatterId")
const quiet = new Map(); // "date|slot|chatterId" (ou "date|*") -> heure où le bot l'a écrit
const pending = new Map(); // "date|slot|chatterId" -> { a: état d'avant le changement, t: vu à }, en attente d'annonce
let flush = false; // annoncer tout de suite à la prochaine lecture

// Ce qu'un chatteur a sur un shift (toutes ses entrées de ce shift réunies)
function statesOf(plan) {
  const m = new Map();
  for (const s of plan) {
    const k = `${s.slot}|${s.chatterId}`;
    const x = m.get(k) || { accts: [], boxes: {} };
    for (const a of s.accts || []) if (!x.accts.includes(a)) x.accts.push(a);
    for (const mid of midsOf(s.accts)) x.boxes[mid] = boxList([...(x.boxes[mid] || []), ...boxList(s.boxes?.[mid])]);
    m.set(k, x);
  }
  for (const x of m.values()) {
    x.accts.sort();
    for (const mid of Object.keys(x.boxes)) if (!x.boxes[mid].length) delete x.boxes[mid];
  }
  return m;
}

// Appelé par app-sync après chaque écriture du planning par le bot
function onWrite(date, patch, loud) {
  if (loud) {
    flush = true;
    return void setTimeout(() => check().catch((e) => console.error("Changements de l'app :", e.message)), 300);
  }
  const t = Date.now();
  const idx = sids.get(date);
  for (const [sid, e] of Object.entries(patch || {})) {
    const k = e && e.slot && e.chatterId ? `${e.slot}|${e.chatterId}` : idx?.get(sid);
    quiet.set(`${date}|${k || "*"}`, t);
  }
}

// Avant une écriture à annoncer : lit l'état d'avant si ce jour n'a pas encore été lu
async function prime(date) {
  if (busy) await busy.catch(() => {});
  if (seen.has(date) || !appSync.enabled()) return;
  const plan = await appSync.planOf(date);
  seen.set(date, statesOf(plan));
  sids.set(date, new Map(plan.map((s) => [s.sid, `${s.slot}|${s.chatterId}`])));
}

// Shifts surveillés : ceux où le bot prévient le salon box (en cours ou qui commencent dans les 2 h)
function liveShifts() {
  const td = appSync.parisParts(Date.now()).date;
  return [-1, 0, 1].flatMap((k) => SLOTS.map((s) => ({ date: appSync.addDays(td, k), slot: s.k }))).filter((x) => running(x.date, x.slot));
}

let busy = null;
let again = false;
function check() {
  if (!appSync.enabled() || !ctx.notify) return Promise.resolve();
  if (busy) {
    again = true;
    return busy;
  }
  busy = scan().finally(() => {
    busy = null;
    if (again) {
      again = false;
      check().catch((e) => console.error("Changements de l'app :", e.message));
    }
  });
  return busy;
}
async function scan() {
  const t0 = Date.now();
  const now0 = flush;
  flush = false;
  const live = liveShifts();
  const dates = [...new Set(live.map((x) => x.date))];
  for (const d of [...seen.keys()]) if (!dates.includes(d)) seen.delete(d), sids.delete(d);
  for (const [q, t] of quiet) if (t0 - t > 10 * 60e3) quiet.delete(q);
  for (const date of dates) {
    const plan = await appSync.planOf(date);
    const cur = statesOf(plan);
    sids.set(date, new Map(plan.map((s) => [s.sid, `${s.slot}|${s.chatterId}`])));
    const before = seen.get(date);
    seen.set(date, cur);
    if (!before) continue; // première lecture : rien à comparer
    const slots = live.filter((x) => x.date === date).map((x) => x.slot);
    const all = quiet.has(`${date}|*`);
    const moving = new Set();
    for (const k of new Set([...before.keys(), ...cur.keys()])) {
      const pk = `${date}|${k}`;
      if (!slots.includes(k.split("|")[0]) || JSON.stringify(before.get(k)) === JSON.stringify(cur.get(k))) continue;
      if (all || quiet.has(pk)) {
        pending.delete(pk);
        continue;
      }
      if (!pending.has(pk)) pending.set(pk, { a: before.get(k) || null, t: t0 });
      moving.add(pk);
    }
    // une écriture du bot finie avant cette lecture y est forcément : plus besoin de la taire
    for (const [q, t] of quiet) if (q.startsWith(date + "|") && t < t0) quiet.delete(q);
    if (moving.size) ctx.refresh?.(date);
    // tout part ensemble quand plus rien ne bouge ce jour-là (tout de suite après la fenêtre « Modifier le shift »)
    const mine = [...pending].filter(([pk]) => pk.startsWith(date + "|"));
    if (moving.size && !now0 && !mine.some(([, p]) => t0 - p.t > 45e3)) continue;
    const changes = [];
    for (const [pk, { a }] of mine) {
      pending.delete(pk);
      const k = pk.slice(date.length + 1);
      const b = cur.get(k) || null;
      const [slot, cid] = k.split("|");
      if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ date, slot, cid, a, b });
    }
    if (changes.length) await announce(date, changes);
  }
  for (const pk of [...pending.keys()]) if (!dates.some((d) => pk.startsWith(d + "|"))) pending.delete(pk);
}

async function announce(date, changes) {
  const [chatters, cat] = await Promise.all([appSync.appChatters(), appSync.appCatalog()]);
  const byId = Object.fromEntries(chatters.map((c) => [c.id, c]));
  const mName = (mid) => withEmoji(cat.models[mid]?.name || mid);
  const lines = [];
  const users = [];
  for (const x of changes) {
    const c = byId[x.cid];
    const line = c && changeLine(x, c, mName, cat);
    if (!line) continue;
    lines.push(line);
    if (c.discordId) users.push(c.discordId);
  }
  if (!lines.length) return;
  await ctx.notify({ content: fitMsg(lines.join("\n")), allowedMentions: { users } });
  console.log(`Changements de l'app annoncés (${date}) : ${lines.length}`);
}

// « 📦 @Jean · **ANNA 🍑** · Box : 1️⃣ & 2️⃣ · ☀️ Aprem », « 🔀 @Moise passe de Axelle 🍒 à **ANNA 🍑** Telegram · Box : 4️⃣ · ☀️ Aprem »
function changeLine(x, c, mName, cat) {
  const sl = slotOf(x.slot);
  const where = `${sl.emoji} ${sl.l}`;
  const big = (mid) => `**${mName(mid).toLocaleUpperCase("fr")}**`;
  const acct = (st, mid) => {
    const plats = st.accts.filter((k) => k.startsWith(mid + "|")).map((k) => cat.platName(k.split("|")[1])).join(" + ");
    return [big(mid), plats].filter(Boolean).join(" ") + (st.boxes[mid] ? ` · ${boxLabel(st.boxes[mid])}` : "");
  };
  const accts = (st, list = midsOf(st.accts)) => list.map((mid) => acct(st, mid)).join(" · ") || "aucun compte";
  if (!x.a) return isNow(x.date, x.slot) ? `💪🏼 ${tag(c)} en renfort · ${where} · ${accts(x.b)}` : `➕ ${tag(c)} ajouté · ${where} · ${accts(x.b)}`;
  if (!x.b) return `➖ ${tag(c)} n'est plus sur ${where}`;
  const ma = midsOf(x.a.accts), mb = midsOf(x.b.accts);
  const gone = ma.filter((m) => !mb.includes(m)), came = mb.filter((m) => !ma.includes(m));
  const parts = [];
  if (gone.length && came.length) parts.push(`passe de ${gone.map(mName).join(" + ")} à ${accts(x.b, came)}`);
  else if (came.length) parts.push(`prend aussi ${accts(x.b, came)}`);
  else if (gone.length) parts.push(`quitte ${gone.map(mName).join(" + ")}`);
  const moved = parts.length > 0;
  for (const mid of mb.filter((m) => ma.includes(m))) {
    const A = x.a.boxes[mid] || [], B = x.b.boxes[mid] || [];
    if (A.join() !== B.join()) parts.push(B.length ? `${big(mid)} · ${boxLabel(B)}` : `plus de box sur ${mName(mid)}`);
  }
  // même modèle, autre plateforme
  if (!parts.length && x.a.accts.join() !== x.b.accts.join()) return `🔀 ${tag(c)} passe sur ${accts(x.b)} · ${where}`;
  if (!parts.length) return null;
  return `${moved ? "🔀" : "📦"} ${tag(c)}${moved ? "" : " ·"} ${parts.join(" · ")} · ${where}`;
}

module.exports = { ctx, check, prime, onWrite, statesOf, changeLine };
