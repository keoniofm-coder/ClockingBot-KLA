// ================== WYSPER : STATS DU TABLEAU DE BORD (onglet Telegram de l'app) ==================
// Avec la clé d'accès Wysper (WYSPER_API_KEY), le bot recopie toutes les 15 minutes les chiffres du tableau de bord
// Wysper dans wystats/<jour de Paris>, que l'app affiche dans Tableau de bord › Telegram :
//  - heure par heure (heure de Paris), par compte et par membre : messages reçus et envoyés, présence au chat,
//    PPV envoyés, achats comptés et brut (GET /stats/hours + GET /ppv)
//  - temps de réponse du jour : médiane, 90e centile et nombre de réponses, en tout, par membre et par compte
//    (GET /stats/response-time)
// Les noms Wysper sont gardés tels quels : l'app les relie aux chatteurs et aux modèles avec les liens de l'import
// (config/import.whysper), comme les ventes. Le mois passé est rattrapé petit à petit, deux jours par passage.
// Plusieurs agences Wysper (WYSPER_API_KEY, WYSPER_API_KEY_2…) : les chiffres de chacune sont réunis dans le même jour.
// Une agence ajoutée : le mois passé est relu pour elle aussi.
const appSync = require("./app-sync");
const wysper = require("./wysper");

const { addDays, parisParts, parisMs } = appSync;
const KEYS = wysper.keys();
const AGSIG = KEYS.map((a) => a.id).join(","); // agences relevées (une de plus : on relit le mois passé)
const BACK_DAYS = 31; // rattrapage : le mois passé
const FIRST = "2026-10-20"; // présence au chat suivie par Wysper depuis le 20/10/2026
const PER_RUN = 2; // jours rattrapés par passage
const num = (v) => Number(v) || 0;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const id = (v) => (v == null ? "" : String(v));
// [médiane, 90e centile, nombre de réponses] ; null sans réponse
const rtOf = (x) => (x && x.median_sec != null ? [r2(x.median_sec), x.p90_sec != null ? r2(x.p90_sec) : null, num(x.replies ?? x.count ?? x.n)] : null);

async function pages(path, params, key) {
  const out = [];
  let cursor = "";
  for (let n = 0; n < 100; n++) {
    const r = await wysper.api(path, { ...params, limit: 200, cursor }, key);
    out.push(...(r.data || []));
    if (!r.has_more || !r.next_cursor) break;
    cursor = r.next_cursor;
  }
  return out;
}

// Les chiffres d'un jour de Paris pour une agence (sa clé), prêts pour l'app
async function dayStats(d, now = Date.now(), key = KEYS[0]?.key) {
  const t0 = parisMs(d, 0), t1 = parisMs(addDays(d, 1), 0);
  const q = { from: d, to: d, tz: "Europe/Paris" };
  const hours = await wysper.api("/stats/hours", q, key);
  const ppv = await pages("/ppv", { since: new Date(t0).toISOString(), until: new Date(t1).toISOString() }, key);
  const rt = await wysper.api("/stats/response-time", q, key).catch((e) => (console.warn("Wysper stats (réponse) :", e.message), null));
  const a = {}, u = {};
  const H = {}, M = {};
  const hourOf = (iso) => {
    const ms = Date.parse(iso);
    if (!(ms >= t0 && ms < t1)) return null;
    return parisParts(ms).h;
  };
  // [reçus, envoyés, présence (s), PPV envoyés, achats, brut €]
  const hRow = (h, acc) => (H[`${h}|${acc}`] ||= [h, acc, 0, 0, 0, 0, 0, 0]);
  // [envoyés, présence (s), PPV envoyés, achats, brut €]
  const mRow = (h, acc, uid) => (M[`${h}|${acc}|${uid}`] ||= [h, acc, uid, 0, 0, 0, 0, 0]);
  for (const x of hours.hours || []) {
    const h = hourOf(x.hour), acc = id(x.account?.telegram_id);
    if (h == null || !acc) continue;
    if (x.account?.name) a[acc] = x.account.name;
    const r = hRow(h, acc);
    r[2] += num(x.received); r[3] += num(x.sent); r[4] += num(x.online_sec); r[6] += num(x.unlocks); r[7] = r2(r[7] + num(x.brut_cents) / 100);
  }
  for (const x of hours.members || []) {
    const h = hourOf(x.hour), acc = id(x.account?.telegram_id), uid = id(x.member?.user_id);
    if (h == null || !acc || !uid) continue;
    if (x.account?.name) a[acc] = x.account.name;
    if (x.member?.name) u[uid] = x.member.name;
    const r = mRow(h, acc, uid);
    r[3] += num(x.sent); r[4] += num(x.online_sec); r[6] += num(x.unlocks); r[7] = r2(r[7] + num(x.brut_cents) / 100);
  }
  for (const x of hours.accounts || []) if (x?.telegram_id != null && x.name) a[id(x.telegram_id)] = x.name;
  // PPV envoyés (débloqués ou non), à l'heure de leur envoi
  for (const x of ppv) {
    const h = hourOf(x.sent_at), acc = id(x.account?.telegram_id);
    if (h == null || !acc) continue;
    if (x.account?.name) a[acc] ||= x.account.name;
    hRow(h, acc)[5]++;
    const uid = id(x.sent_by?.user_id);
    if (!uid) continue;
    if (x.sent_by?.name) u[uid] ||= x.sent_by.name;
    mRow(h, acc, uid)[5]++;
  }
  // temps de réponse : en tout, par membre, puis compte par compte
  const rts = { t: rtOf(rt), m: {}, a: {} };
  for (const x of rt?.members || []) {
    const uid = id(x.member?.user_id);
    if (!uid) continue;
    if (x.member?.name) u[uid] ||= x.member.name;
    const v = rtOf(x);
    if (v) rts.m[uid] = v;
  }
  for (const acc of Object.keys(a)) {
    const r = await wysper.api("/stats/response-time", { ...q, account: acc }, key).catch(() => null);
    const v = rtOf(r);
    if (v) rts.a[acc] = v;
  }
  const sort = (l) => l.sort((x, y) => x[0] - y[0] || String(x[1]).localeCompare(String(y[1])) || String(x[2]).localeCompare(String(y[2])));
  return {
    date: d, at: now, v: 1,
    // jour fini depuis 6 h : les chiffres ne bougeront plus
    fin: now >= parisMs(addDays(d, 1), 6),
    a, u, h: sort(Object.values(H)), m: sort(Object.values(M)), rt: rts,
  };
}

// temps de réponse de deux agences réunis : médiane moyenne pondérée par le nombre de réponses, 90e centile le plus haut
function rtJoin(x, y) {
  if (!x || !x[2]) return y && y[2] ? y : x || y || null;
  if (!y || !y[2]) return x;
  const n = num(x[2]) + num(y[2]);
  return [r2((x[0] * x[2] + y[0] * y[2]) / n), x[1] == null && y[1] == null ? null : Math.max(num(x[1]), num(y[1])), n];
}
// Un jour pour toutes les agences : une agence en erreur n'empêche pas les autres (le jour reste alors à relire)
async function dayStatsAll(d, now = Date.now()) {
  if (KEYS.length === 1) return dayStats(d, now, KEYS[0].key);
  const docs = [];
  let err = null;
  for (const a of KEYS) {
    try {
      docs.push(await dayStats(d, now, a.key));
    } catch (e) {
      console.warn(`Wysper stats (${d}, agence ${a.id}) :`, e.message);
      err = e;
    }
  }
  if (!docs.length) throw err;
  const out = { date: d, at: now, v: 1, fin: !err && docs.every((x) => x.fin), a: {}, u: {}, h: [], m: [], rt: { t: null, m: {}, a: {} } };
  for (const x of docs) {
    Object.assign(out.a, x.a);
    for (const [k, v] of Object.entries(x.u)) out.u[k] ||= v;
    out.h.push(...x.h);
    out.m.push(...x.m);
    out.rt.t = rtJoin(out.rt.t, x.rt.t);
    for (const [k, v] of Object.entries(x.rt.m)) out.rt.m[k] = rtJoin(out.rt.m[k], v);
    Object.assign(out.rt.a, x.rt.a);
  }
  const sort = (l) => l.sort((x, y) => x[0] - y[0] || String(x[1]).localeCompare(String(y[1])) || String(x[2]).localeCompare(String(y[2])));
  sort(out.h);
  sort(out.m);
  return out;
}

// ---------- Passages ----------
let busy = false;
let finDays = null; // jours déjà relus une fois finis (config/wystatsState.fin)
// noms Wysper vus dans les stats, pour la liste Équipe › Noms des plateformes de l'app :
// { u: { idMembre: [nom, dernier jour vu] }, a: { idCompte: [nom, dernier jour vu] } }
let names = null;
function addNames(doc) {
  let ch = false;
  for (const k of ["u", "a"])
    for (const [id, nm] of Object.entries(doc[k] || {})) {
      const cur = names[k][id];
      if (!nm || (cur && cur[1] > doc.date)) continue;
      if (!cur || cur[0] !== nm || cur[1] < doc.date) { names[k][id] = [nm, doc.date]; ch = true; }
    }
  return ch;
}
async function saveDay(d, now) {
  const doc = await dayStatsAll(d, now);
  await appSync.putDoc("wystats", d, doc);
  const ch = addNames(doc);
  if (doc.fin) finDays[d] = now;
  if (doc.fin || ch) {
    const keep = Object.fromEntries(Object.entries(finDays).filter(([k]) => k >= addDays(d, -400)));
    await appSync.putDoc("config", "wystatsState", { fin: keep, finAg: AGSIG, names, at: now });
  }
  return doc;
}
async function run({ now = Date.now(), back = PER_RUN } = {}) {
  if (!KEYS.length || !appSync.enabled() || busy) return null;
  busy = true;
  const done = [];
  try {
    if (!finDays) {
      const st = await appSync.getDoc("config", "wystatsState").catch(() => null);
      // une agence ajoutée depuis : les jours finis sont relus pour elle aussi
      finDays = (st?.finAg || "1") === AGSIG ? st?.fin || {} : {};
      names = { u: { ...(st?.names?.u || {}) }, a: { ...(st?.names?.a || {}) } };
    }
    const p = parisParts(now);
    const today = p.date;
    const days = [today];
    // la veille reste ouverte jusqu'à 6 h (ventes et présence du shift de nuit)
    if (!finDays[addDays(today, -1)]) days.push(addDays(today, -1));
    // rattrapage du mois passé, les jours les plus récents d'abord
    const lo = [FIRST, addDays(today, -BACK_DAYS)].sort()[1];
    let n = 0;
    for (let d = addDays(today, -2); d >= lo && n < back; d = addDays(d, -1)) if (!finDays[d]) { days.push(d); n++; }
    for (const d of days) {
      try {
        await saveDay(d, now);
        done.push(d);
      } catch (e) {
        console.warn(`Wysper stats (${d}) :`, e.message);
        if (e.status === 401 || e.status === 403) break;
      }
    }
  } finally {
    busy = false;
  }
  return done;
}

function start() {
  if (!KEYS.length) return console.log("Wysper stats : pas de WYSPER_API_KEY, onglet Telegram du tableau de bord sans données.");
  if (!appSync.enabled()) return;
  const go = () => run().then((d) => d?.length && console.log("Wysper stats :", d.join(", "))).catch((e) => console.error("Wysper stats :", e.message));
  setTimeout(go, 20000);
  const cron = require("node-cron");
  cron.schedule("*/15 * * * *", go, { timezone: "Europe/Paris" });
  console.log("Wysper stats : relevé toutes les 15 minutes.");
}

module.exports = { start, run, dayStats, dayStatsAll, _reset: () => { finDays = null; names = null; busy = false; } };
