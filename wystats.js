// ================== WYSPER : STATS DU TABLEAU DE BORD (onglet Telegram de l'app) ==================
// Avec la clé d'accès Wysper (WYSPER_API_KEY), le bot recopie toutes les 15 minutes les chiffres du tableau de bord
// Wysper dans wystats/<jour de Paris>, que l'app affiche dans Tableau de bord › Telegram :
//  - heure par heure (heure de Paris), par compte et par membre : messages reçus et envoyés, présence au chat,
//    PPV envoyés, achats comptés et brut (GET /stats/hours + GET /ppv)
//  - temps de réponse du jour : médiane, 90e centile et nombre de réponses, en tout, par membre et par compte
//    (GET /stats/response-time)
// Les noms Wysper sont gardés tels quels : l'app les relie aux chatteurs et aux modèles avec les liens de l'import
// (config/import.whysper), comme les ventes. Le mois passé est rattrapé petit à petit, deux jours par passage.
const appSync = require("./app-sync");
const wysper = require("./wysper");

const { addDays, parisParts, parisMs } = appSync;
const KEY = (process.env.WYSPER_API_KEY || "").trim();
const BACK_DAYS = 31; // rattrapage : le mois passé
const FIRST = "2026-10-20"; // présence au chat suivie par Wysper depuis le 20/10/2026
const PER_RUN = 2; // jours rattrapés par passage
const num = (v) => Number(v) || 0;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const id = (v) => (v == null ? "" : String(v));
// [médiane, 90e centile, nombre de réponses] ; null sans réponse
const rtOf = (x) => (x && x.median_sec != null ? [r2(x.median_sec), x.p90_sec != null ? r2(x.p90_sec) : null, num(x.replies ?? x.count ?? x.n)] : null);

async function pages(path, params) {
  const out = [];
  let cursor = "";
  for (let n = 0; n < 100; n++) {
    const r = await wysper.api(path, { ...params, limit: 200, cursor });
    out.push(...(r.data || []));
    if (!r.has_more || !r.next_cursor) break;
    cursor = r.next_cursor;
  }
  return out;
}

// Les chiffres d'un jour de Paris, prêts pour l'app
async function dayStats(d, now = Date.now()) {
  const t0 = parisMs(d, 0), t1 = parisMs(addDays(d, 1), 0);
  const q = { from: d, to: d, tz: "Europe/Paris" };
  const hours = await wysper.api("/stats/hours", q);
  const ppv = await pages("/ppv", { since: new Date(t0).toISOString(), until: new Date(t1).toISOString() });
  const rt = await wysper.api("/stats/response-time", q).catch((e) => (console.warn("Wysper stats (réponse) :", e.message), null));
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
    const r = await wysper.api("/stats/response-time", { ...q, account: acc }).catch(() => null);
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

// ---------- Passages ----------
let busy = false;
let finDays = null; // jours déjà relus une fois finis (config/wystatsState.fin)
async function saveDay(d, now) {
  const doc = await dayStats(d, now);
  await appSync.putDoc("wystats", d, doc);
  if (doc.fin) {
    finDays[d] = now;
    const keep = Object.fromEntries(Object.entries(finDays).filter(([k]) => k >= addDays(d, -400)));
    await appSync.putDoc("config", "wystatsState", { fin: keep, at: now });
  }
  return doc;
}
async function run({ now = Date.now(), back = PER_RUN } = {}) {
  if (!KEY || !appSync.enabled() || busy) return null;
  busy = true;
  const done = [];
  try {
    if (!finDays) finDays = (await appSync.getDoc("config", "wystatsState").catch(() => null))?.fin || {};
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
  if (!KEY) return console.log("Wysper stats : pas de WYSPER_API_KEY, onglet Telegram du tableau de bord sans données.");
  if (!appSync.enabled()) return;
  const go = () => run().then((d) => d?.length && console.log("Wysper stats :", d.join(", "))).catch((e) => console.error("Wysper stats :", e.message));
  setTimeout(go, 20000);
  const cron = require("node-cron");
  cron.schedule("*/15 * * * *", go, { timezone: "Europe/Paris" });
  console.log("Wysper stats : relevé toutes les 15 minutes.");
}

module.exports = { start, run, dayStats, _reset: () => { finDays = null; busy = false; } };
