// ================== WYSPER : VENTES TELEGRAM EN DIRECT ==================
// Avec une clé d'accès Wysper (WYSPER_API_KEY dans Railway, lecture seule), le bot lit chaque minute les
// paiements de l'agence (GET /payments) et remplit lui-même les ventes Telegram de l'app, sans import :
//  - chaque paiement est gardé dans wysper/<jour de Paris> (heure, compte, membre, fan, brut, statut)
//  - les lignes Ventes de ce jour sont recalculées comme le ferait l'import d'un fichier à l'heure de Paris :
//    jour réel (minuit à minuit), shift du planning (sinon celui de l'heure), chatteur et modèle reliés comme
//    pour l'import (config/import.whysper), montant brut (la plateforme Telegram de l'app retire sa part)
//  - un remboursement ou un litige retire la vente ; une correction faite à la main dans l'app est gardée
//  - les noms Wysper pas encore reliés attendent dans config/wysperState.unknown : l'app les montre à relier
//  - les réattributions 🔄 en attente sont faites dès que la ou les ventes sont retrouvées
// Temps réel : avec WYSPER_WEBHOOK_SECRET, le bot ouvre une adresse (POST /wysper sur le port PORT de Railway) où Wysper
// envoie chaque paiement dans la seconde, signé (HMAC-SHA256). La lecture par la clé passe alors à toutes les 5 minutes,
// pour rattraper ce qui serait arrivé pendant un redémarrage du bot.
// Les jours d'avant la mise en route (config/wysper.from) ne sont pas touchés : l'import du fichier reste
// possible pour eux. config/wysper.on = false (bouton de l'app) met la synchro en pause.
const appSync = require("./app-sync");

const http = require("http");
const crypto = require("crypto");

const KEY = (process.env.WYSPER_API_KEY || "").trim();
// secret de signature whsec_… de l'adresse « Événements en temps réel » (page Intégrations de Wysper)
const SECRET = (process.env.WYSPER_WEBHOOK_SECRET || "").trim();
const BASE = (process.env.WYSPER_API_URL || "https://wysper.io/api/v1").trim().replace(/\/+$/, "");
// avec le temps réel, la lecture par la clé ne sert plus qu'à rattraper : toutes les 5 minutes
const EVERY_S = Math.max(30, Number(process.env.WYSPER_POLL_S || (SECRET ? 300 : 60)));
const TOLERANCE_S = 300; // anti-rejeu : une requête signée il y a plus de 5 minutes est refusée
const OVERLAP_MS = 5 * 60e3; // on relit toujours les 5 dernières minutes : rien ne passe entre deux lectures
const LINK_DAYS = 45; // relier un nom refait au plus les 45 derniers jours

const enabled = () => !!(KEY || SECRET) && appSync.enabled();
const { addDays, parisParts, parisMs } = appSync;
// même normalisation que l'import de l'app (impNorm)
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => Number(v) || 0;
const ekey = (slot, c, m, p) => `${slot || "x"}_${c}_${m}_${p}`;
const SLOTS = ["matin", "aprem", "soir", "nuit"];
// créneau d'une heure de Paris, comme l'import : avant 2 h = shift du soir du même jour
const slotOfHour = (h) => (h < 2 ? "soir" : h < 8 ? "nuit" : h < 14 ? "matin" : h < 20 ? "aprem" : "soir");

// ---------- API Wysper ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
  for (let k = 0; ; k++) {
    const res = await fetch(`${BASE}${path}${q ? "?" + q : ""}`, {
      headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json", "User-Agent": "KL-Agency-bot" },
      signal: AbortSignal.timeout(20000),
    });
    if ((res.status === 429 || res.status === 503) && k < 3) {
      await sleep(Math.min(30, Number(res.headers.get("retry-after")) || 2) * 1000);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 200);
      try { msg = JSON.parse(text).error?.message || msg; } catch {}
      const err = new Error(`Wysper ${res.status} : ${msg}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  }
}
// Tous les paiements modifiés depuis since (triés par updated_at), page par page
async function paymentsSince(since) {
  const out = [];
  let cursor = "";
  for (let n = 0; n < 200; n++) {
    const r = await api("/payments", { since, limit: 200, cursor });
    out.push(...(r.data || []));
    if (!r.has_more || !r.next_cursor) break;
    cursor = r.next_cursor;
  }
  return out;
}

// ---------- Noms des fans (contacts du CRM), pour les réattributions ----------
// GET /contacts compte par compte, puis seulement ce qui a changé ; gardé en mémoire
const contacts = { names: new Map(), since: {}, at: 0 };
async function loadContacts(accountIds) {
  if (Date.now() - contacts.at < 5 * 60e3) return;
  for (const acc of accountIds) {
    const since = contacts.since[acc] || "";
    const started = new Date().toISOString();
    let cursor = "";
    for (let n = 0; n < 300; n++) {
      const r = await api("/contacts", { account: acc, limit: 200, cursor, since });
      for (const c of r.data || []) if (c?.telegram_id) contacts.names.set(`${acc}|${c.telegram_id}`, c.name || c.telegram_username || "");
      if (!r.has_more || !r.next_cursor) break;
      cursor = r.next_cursor;
    }
    contacts.since[acc] = started;
  }
  contacts.at = Date.now();
}
const fanName = (p) => contacts.names.get(`${p.acc}|${p.b}`) || p.bn || "";

// ---------- Un paiement, tel qu'on le garde (wysper/<jour>.p[payment_id]) ----------
function slim(x) {
  const at = Date.parse(x.paid_at);
  return {
    s: x.status, at, u: Date.parse(x.updated_at) || at, type: x.type || "ppv",
    // pr : prix du média (le « brut » du tableau de bord et de l'export) ; g : payé par le fan ; n : net de l'agence
    pr: x.price_cents != null ? num(x.price_cents) : num(x.amount_gross_cents),
    g: num(x.amount_gross_cents), n: num(x.amount_net_cents), cur: x.currency || "EUR",
    r: num(x.refund?.amount_cents), acc: String(x.account?.telegram_id ?? ""), an: x.account?.name || "",
    uid: x.sent_by?.user_id != null ? String(x.sent_by.user_id) : "", un: x.sent_by?.name || "",
    b: x.buyer?.telegram_id != null ? String(x.buyer.telegram_id) : "", bu: x.buyer?.telegram_username || "",
    test: x.livemode === false || /^test_/.test(x.payment_id || ""),
  };
}
// Montant compté (brut, en €), règle du tableau de bord Wysper : payé, ni remboursé ni en litige (un litige gagné
// repasse à « payé »). Brut = prix du média, comme la colonne Brut de l'export.
const counted = (p) => (p.test || p.s !== "paid" ? 0 : (p.pr ?? p.g) / 100);

// ---------- Contexte de l'app (liens, chatteurs, plateforme) ----------
async function appCtx() {
  const [imp, chatters, cat] = await Promise.all([appSync.getDoc("config", "import"), appSync.collMap("chatters"), appSync.appCatalog()]);
  const w = imp?.whysper || {};
  const pid = (w.platformId && cat.platforms[w.platformId] && w.platformId) ||
    Object.keys(cat.platforms).find((k) => /telegram/i.test(cat.platforms[k].name || "")) || "";
  return { links: { c: w.chatters || {}, m: w.models || {} }, chatters, models: cat.models, platforms: cat.platforms, pid };
}
// nom Wysper -> chatteur (ou modèle) : lien de l'import, sinon un chatteur qui porte exactement ce nom
function linkOf(map, all, raw) {
  const n = norm(raw);
  if (!n) return "";
  const v = map[n];
  if (v === "-") return "-";
  if (v && all[v]) return v;
  const same = Object.keys(all).filter((id) => norm(all[id]?.name) === n && all[id]?.active !== false);
  return same.length === 1 ? same[0] : "";
}

// ---------- Recalcul des lignes Ventes d'un jour ----------
// Lignes de la plateforme écrites par l'import Whysper ou par le bot : remplacées ; les parts tapées ou
// corrigées à la main (manuel, adj) restent. Les lignes tapées à la main (sans src) ne sont pas touchées.
const KEEP = new Set(["manuel", "adj"]);
// comparaison sans tenir compte de l'ordre des clés (la base les range à sa façon)
const stable = (v) => (Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v);
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
async function recomputeDay(d, ctx, unknown, raMap) {
  const [wd, day, plan] = await Promise.all([appSync.getDoc("wysper", d), appSync.getDoc("days", d), appSync.planOf(d)]);
  const pays = Object.values(wd?.p || {});
  const groups = {};
  for (const p of pays) {
    const amt = counted(p);
    if (!amt) continue;
    const mid = linkOf(ctx.links.m, ctx.models, p.an);
    // réattribution faite (et pas annulée depuis)
    const ra = p.ra && raMap[p.ra] && raMap[p.ra].status === "applied" ? p.to : "";
    const cid = ra && ctx.chatters[ra] ? ra : linkOf(ctx.links.c, ctx.chatters, p.un || "(sans membre)");
    if (mid === "-" || cid === "-") continue;
    if (!mid || !cid) {
      const kind = !mid ? "m" : "c";
      const raw = !mid ? p.an : p.un || "(sans membre)";
      const u = (unknown[kind][norm(raw) || "sans membre"] ||= { raw, byDay: {} });
      const x = (u.byDay[d] ||= [0, 0]);
      x[0]++;
      x[1] = r2(x[1] + amt);
      continue;
    }
    const h = parisParts(p.at).h;
    const mine = plan.filter((s) => s.chatterId === cid && ctx.chatters[s.chatterId]);
    const at = slotOfHour(h);
    const slot = mine.some((s) => s.slot === at) ? at : mine.length === 1 ? mine[0].slot : at;
    const key = ekey(slot, cid, mid, ctx.pid);
    const g = (groups[key] ||= { slot, c: cid, m: mid, sales: 0, n: 0 });
    g.sales += amt;
    g.n++;
  }
  const prev = day?.entries || {};
  const plat = ctx.platforms[ctx.pid] || {};
  const patch = {};
  const owned = Object.entries(prev).filter(([, e]) => e && e.platformId === ctx.pid && (e.src === "whysper" || e.src === "wysper"));
  const keepOf = (e) => Object.fromEntries(Object.entries(e?.parts || {}).filter(([f, v]) => v && KEEP.has(f)));
  const nulls = (e) => Object.fromEntries(Object.keys(e?.parts || {}).filter((f) => !KEEP.has(f)).map((f) => [f, null]));
  for (const [key, e] of owned) {
    if (groups[key]) continue;
    const keep = keepOf(e);
    if (!Object.keys(keep).length) { patch[key] = null; continue; }
    const s = Object.values(keep).reduce((x, v) => [x[0] + num(v[0]), x[1] + num(v[1])], [0, 0]);
    const ne = { ...e, sales: r2(s[0]), tips: r2(s[1]), parts: { ...nulls(e), ...keep }, at: Date.now() };
    if (!same([e.sales, e.tips, e.parts], [ne.sales, ne.tips, ne.parts])) patch[key] = ne;
  }
  for (const [key, g] of Object.entries(groups)) {
    const e = prev[key];
    // une ligne tapée à la main (sans src) sur le même chatteur : elle reste à côté, comme avec l'import
    const keep = e && (e.src === "whysper" || e.src === "wysper") ? keepOf(e) : {};
    const parts = { ...(e?.parts ? nulls(e) : {}), ...keep, api: [r2(g.sales), 0] };
    const tot = Object.values(parts).filter(Boolean).reduce((x, v) => [x[0] + num(v[0]), x[1] + num(v[1])], [0, 0]);
    const ne = {
      slot: g.slot, chatterId: g.c, modelId: g.m, platformId: ctx.pid, sales: r2(tot[0]), tips: r2(tot[1]), parts,
      ra: e?.ra ?? null, rate: e?.rate ?? num(ctx.chatters[g.c]?.rate ?? 10), fee: e?.fee ?? num(plat.fee ?? 20),
      cur: e?.cur || (plat.currency === "USD" ? "USD" : "EUR"), at: Date.now(), src: "whysper", n: g.n,
    };
    if (e && e.src !== "whysper" && e.src !== "wysper") {
      // une ligne tapée à la main occupe déjà cette clé : on la garde en part « manuel »
      ne.parts = { manuel: [num(e.sales), num(e.tips)], api: [r2(g.sales), 0] };
      ne.sales = r2(num(e.sales) + g.sales);
      ne.tips = r2(num(e.tips));
      ne.rate = e.rate ?? ne.rate;
    }
    if (!e || !same([e.slot, e.sales, e.tips, e.parts, e.src, e.n], [ne.slot, ne.sales, ne.tips, ne.parts, ne.src, ne.n])) patch[key] = ne;
  }
  if (Object.keys(patch).length) await appSync.mergeDoc("days", d, { entries: patch }, { date: d, entries: {} });
  return Object.keys(patch).length;
}

// ---------- Réattributions 🔄 : la ou les ventes retrouvées passent au bon chatteur ----------
const raSame = (a, b) => {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x === y || (" " + x + " ").includes(" " + y + " ") || (" " + y + " ").includes(" " + x + " "));
};
function raCid(ctx, id, uid, name) {
  if (id && ctx.chatters[id]) return id;
  const ids = Object.keys(ctx.chatters);
  return (uid && ids.find((k) => String(ctx.chatters[k].discordId || "") === String(uid))) ||
    (name && ids.find((k) => norm(ctx.chatters[k].name) === norm(name))) || "";
}
async function applyReattribs(ctx, raList, from, touched) {
  const pending = raList.filter((r) => r.status !== "applied" && r.fan && num(r.amount) > 0 && r.date && addDays(r.date, 1) >= from);
  if (!pending.length) return 0;
  const days = [...new Set(pending.flatMap((r) => [-1, 0, 1].map((k) => addDays(r.date, k))))].filter((d) => d >= from);
  const docs = Object.fromEntries(await Promise.all(days.map(async (d) => [d, (await appSync.getDoc("wysper", d))?.p || {}])));
  const accs = [...new Set(Object.values(docs).flatMap((p) => Object.values(p).map((x) => x.acc)).filter(Boolean))];
  await loadContacts(accs).catch((e) => console.warn("Wysper contacts :", e.message));
  const used = new Set(Object.values(docs).flatMap((p) => Object.entries(p).filter(([, x]) => x.ra).map(([id]) => id)));
  let done = 0;
  for (const r of pending.sort((a, b) => (a.at || 0) - (b.at || 0))) {
    const fromC = raCid(ctx, r.fromId, r.fromUid, r.fromName), toC = raCid(ctx, r.toId, r.toUid, r.toName);
    if (!toC) continue;
    const amt = num(r.amount);
    const cand = [];
    for (const k of [0, -1, 1]) {
      const d = addDays(r.date, k);
      for (const [id, p] of Object.entries(docs[d] || {})) {
        if (used.has(id) || !counted(p)) continue;
        const seller = linkOf(ctx.links.c, ctx.chatters, p.un || "(sans membre)");
        if (fromC ? seller !== fromC : !raSame(p.un, r.fromName)) continue;
        if (![fanName(p), p.bu].some((f) => raSame(f, r.fan))) continue;
        cand.push({ id, d, p, v: counted(p) });
      }
    }
    let pick = null;
    for (const tol of [0.015, 1]) {
      const one = cand.find((c) => Math.abs(c.v - amt) <= tol);
      if (one) { pick = [one]; break; }
      if (cand.length > 1 && cand.length <= 14)
        for (let m = 3; m < 1 << cand.length && !pick; m++) {
          if (!(m & (m - 1))) continue;
          const sub = cand.filter((_, i) => (m >> i) & 1);
          if (Math.abs(sub.reduce((s, c) => s + c.v, 0) - amt) <= tol) pick = sub;
        }
      if (pick) break;
    }
    if (!pick) continue;
    for (const c of pick) {
      used.add(c.id);
      await appSync.mergeDoc("wysper", c.d, { p: { [c.id]: { ra: r.id, to: toC } } });
      touched.add(c.d);
    }
    await appSync.mergeDoc("reattrib", r.id, { status: "applied", appliedAt: Date.now(), appliedBy: "wysper", sales: pick.map((c) => c.id), appliedFile: null });
    r.status = "applied";
    r.appliedBy = "wysper";
    done++;
  }
  return done;
}

// ---------- Un tour de synchro ----------
// config/wysper : réglages de l'app (on, from) ; config/wysperState : état du bot (réécrit en entier par lui seul).
// Les tours passent l'un après l'autre (lecture par la clé et paiements reçus en temps réel).
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}
const tick = (o = {}) => (enabled() ? serial(() => run(o)) : Promise.resolve(null));
async function run({ now = Date.now(), force = false, incoming = null } = {}) {
  const [cfg0, st0] = await Promise.all([appSync.getDoc("config", "wysper").catch(() => null), appSync.getDoc("config", "wysperState").catch(() => null)]);
  const cfg = cfg0 || {}, st = st0 || {};
  const save = (patch) => appSync.putDoc("config", "wysperState", { ...st, ...patch });
  try {
    if (cfg.on === false && !force) return { paused: true };
    const today = parisParts(now).date;
    let from = cfg.from;
    if (!from) {
      // première mise en route : le bot prend les ventes à partir d'aujourd'hui
      from = today;
      await appSync.mergeDoc("config", "wysper", { from, on: true }, { from, on: true });
    }
    const ctx = await appCtx();
    if (!ctx.pid) throw new Error("plateforme Telegram introuvable dans l'app");
    const fromMs = parisMs(from, 0);
    const keep = st.since && st.from === from;
    const since = new Date(keep ? Math.max(Date.parse(st.since) - OVERLAP_MS, 0) : fromMs).toISOString();
    // paiements reçus en temps réel, sinon lus avec la clé depuis la dernière fois
    const list = incoming || (KEY ? await paymentsSince(since) : []);
    // rangés par jour de Paris (heure de paiement) ; seulement la version la plus récente de chaque paiement
    const byDay = {};
    let maxU = keep ? Date.parse(st.since) : 0;
    for (const x of list) {
      if (!x?.payment_id || !x.paid_at) continue;
      const p = slim(x);
      if (!incoming) maxU = Math.max(maxU, p.u || 0);
      const d = parisParts(p.at).date;
      if (d < from) continue;
      const o = (byDay[d] ||= {})[x.payment_id];
      if (!o || o.u <= p.u) byDay[d][x.payment_id] = p;
    }
    const touched = new Set();
    for (const [d, ps] of Object.entries(byDay)) {
      const old = (await appSync.getDoc("wysper", d))?.p || {};
      const patch = {};
      for (const [id, p] of Object.entries(ps)) {
        const o = old[id];
        if (o && (o.u || 0) > p.u) continue;
        const np = { ...p, ...(o?.ra ? { ra: o.ra, to: o.to } : {}) };
        if (!o || !same(o, np)) patch[id] = np;
      }
      if (Object.keys(patch).length) {
        await appSync.mergeDoc("wysper", d, { p: patch }, { date: d, p: {} });
        touched.add(d);
      }
    }
    // noms reliés ou changés dans l'app : on refait les jours récents
    const sig = JSON.stringify(stable([ctx.links, ctx.pid]));
    const lo = [from, addDays(today, -LINK_DAYS)].sort()[1];
    if ((st.sig && st.sig !== sig) || force || st.from !== from) for (let d = lo; d <= today; d = addDays(d, 1)) touched.add(d);
    // toutes les 10 minutes, aujourd'hui et hier sont refaits (planning changé entre-temps)
    const full = now - (st.fullAt || 0) > 10 * 60e3;
    if (full) [today, addDays(today, -1)].filter((d) => d >= from).forEach((d) => touched.add(d));
    // réattributions 🔄 en attente
    const raList = await appSync.reattribsWhere("").catch(() => []);
    const raMap = Object.fromEntries(raList.map((r) => [r.id, r]));
    const nRa = await applyReattribs(ctx, raList, from, touched).catch((e) => (console.warn("Wysper réatrib :", e.message), 0));
    // une réattribution annulée (supprimée) : ses ventes reviennent à leur vendeur
    for (const [id, d] of Object.entries(st.raIds || {})) if (!raMap[id]) touched.add(d);
    // noms à relier : ceux des jours pas refaits restent, ceux des jours refaits sont recomptés
    const unknown = { c: {}, m: {} };
    for (const kind of ["c", "m"])
      for (const [n, u] of Object.entries(st.unknown?.[kind] || {})) {
        const byDay = Object.fromEntries(Object.entries(u.byDay || {}).filter(([d]) => !touched.has(d) && d >= lo));
        if (Object.keys(byDay).length) unknown[kind][n] = { raw: u.raw, byDay };
      }
    let lines = 0;
    for (const d of [...touched].sort()) if (d >= from && d <= addDays(today, 1)) lines += await recomputeDay(d, ctx, unknown, raMap);
    for (const kind of ["c", "m"])
      for (const u of Object.values(unknown[kind])) {
        const v = Object.values(u.byDay);
        u.n = v.reduce((a, x) => a + x[0], 0);
        u.amt = r2(v.reduce((a, x) => a + x[1], 0));
      }
    const raIds = {};
    for (const r of raList) if (r.status === "applied" && r.appliedBy === "wysper" && r.date) raIds[r.id] = r.date;
    await save({
      from, since: new Date(Math.min(maxU || fromMs, now)).toISOString(), sig, lastErr: null,
      ...(incoming ? { lastEvent: now } : { lastOk: now, lastN: list.length }),
      live: !!SECRET, key: !!KEY, fullAt: full ? now : st.fullAt, unknown, raIds,
    });
    return { payments: list.length, days: touched.size, lines, reattribs: nRa };
  } catch (e) {
    console.error("Wysper :", e.message);
    await save({ lastErr: String(e.message).slice(0, 300), lastErrAt: now }).catch(() => {});
    return { error: e.message };
  }
}
// petit changement de l'état (test reçu…), entre deux tours
const patchState = (patch) => serial(async () => {
  const st = (await appSync.getDoc("config", "wysperState")) || {};
  await appSync.putDoc("config", "wysperState", { ...st, ...patch });
});

// ---------- Vérification avec le tableau de bord Wysper ----------
// Total brut du jour chez Wysper (GET /stats/sales, mêmes règles : payé, ni remboursé ni en litige, jour de Paris)
// comparé au total Telegram du jour dans l'app. Écart : on relit toute la journée chez Wysper, puis on recompare.
// Résultat gardé dans config/wysperState.checks[jour] (✅ / ⚠️ dans l'app) ; récap posté dans le salon ventes.
const VENTES_CHANNEL_ID = (process.env.VENTES_CHANNEL_ID || "").trim();
const ctxDiscord = {};
const eur = (v) => `${Number(r2(v)).toLocaleString("fr-FR", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })} €`;
const dayLong = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
async function dayTotals(d, ctx) {
  const [wd, day] = await Promise.all([appSync.getDoc("wysper", d), appSync.getDoc("days", d)]);
  const t = { l: 0, ln: 0, a: 0, j: 0, m: 0, f: 0, y: 0, u: {}, i: {} };
  for (const p of Object.values(wd?.p || {})) {
    const v = counted(p);
    if (!v) continue;
    t.l += v;
    t.ln++;
    const mid = linkOf(ctx.links.m, ctx.models, p.an), cid = p.to && ctx.chatters[p.to] ? p.to : linkOf(ctx.links.c, ctx.chatters, p.un || "(sans membre)");
    if (mid === "-" || cid === "-") { const k = mid === "-" ? p.an : p.un; t.i[k] = r2((t.i[k] || 0) + v); }
    else if (!mid || !cid) { const k = !mid ? p.an : p.un || "(sans membre)"; t.u[k] = r2((t.u[k] || 0) + v); }
  }
  for (const e of Object.values(day?.entries || {})) {
    if (!e || e.platformId !== ctx.pid) continue;
    t.y += num(e.sales) + num(e.tips);
    const parts = e.parts && Object.values(e.parts).some(Boolean) ? e.parts : { manuel: [num(e.sales), num(e.tips)] };
    for (const [f, v] of Object.entries(parts)) {
      if (!v) continue;
      const x = num(v[0]) + num(v[1]);
      if (f === "api") t.a += x; else if (f === "adj") t.j += x; else if (f === "manuel") t.m += x; else t.f += x;
    }
  }
  for (const k of ["l", "a", "j", "m", "f", "y"]) t[k] = r2(t[k]);
  return t;
}
async function wysperDay(d) {
  if (!KEY) return null;
  const r = await api("/stats/sales", { from: d, to: d, tz: "Europe/Paris" });
  return { w: r2(num(r.brut_cents) / 100), wn: num(r.unlocks) };
}
// une journée relue en entier chez Wysper (paiements modifiés depuis son début)
async function refetchDay(d, now) {
  const list = (await paymentsSince(new Date(parisMs(d, 0)).toISOString())).filter((x) => x?.paid_at && parisParts(Date.parse(x.paid_at)).date === d);
  return run({ now, incoming: list });
}
function checkText(d, c) {
  const head = c.ok
    ? `✅ **Ventes Telegram · ${dayLong(d)}** : ${eur(c.w ?? c.l)} dans Wysper = ${eur(c.y)} dans l'app${c.wn != null ? ` · ${c.wn} vente${c.wn > 1 ? "s" : ""}` : ""}`
    : `⚠️ **Ventes Telegram · ${dayLong(d)}** : ${c.w != null ? `${eur(c.w)} dans Wysper` : `${eur(c.l)} reçus de Wysper`} · ${eur(c.y)} dans l'app · écart ${c.y - (c.w ?? c.l) > 0 ? "+" : "−"}${eur(Math.abs(c.y - (c.w ?? c.l)))}`;
  const why = [];
  const list = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${eur(v)})`).join(", ");
  if (Object.keys(c.u).length) why.push(`-# 🔗 À relier dans l'app (Ventes) : ${list(c.u)}`);
  if (Object.keys(c.i).length) why.push(`-# 🚫 Noms ignorés : ${list(c.i)}`);
  if (Math.abs(c.j) >= 0.01) why.push(`-# ✏️ Corrigé à la main dans l'app : ${c.j > 0 ? "+" : "−"}${eur(Math.abs(c.j))}`);
  if (c.m >= 0.01) why.push(`-# ✍️ Tapé à la main dans l'app : ${eur(c.m)}`);
  if (c.f >= 0.01) why.push(`-# 📄 Venu d'un import de fichier : ${eur(c.f)}`);
  if (c.w != null && Math.abs(c.w - c.l) >= 0.01) why.push(`-# ❓ ${eur(Math.abs(c.w - c.l))} ${c.w > c.l ? "comptés par Wysper mais pas reçus par le bot" : "reçus par le bot mais plus comptés par Wysper"}`);
  return [head, ...why].join("\n");
}
// post : false (silencieux), true (toujours), "changed" (seulement si le résultat a changé depuis le dernier envoi)
async function check(d, { now = Date.now(), post = false } = {}) {
  if (!enabled()) return null;
  const ctx = await appCtx();
  let w = await wysperDay(d).catch((e) => (console.warn("Wysper stats :", e.message), null));
  let t = await dayTotals(d, ctx);
  if (w && Math.abs(w.w - t.l) >= 0.01) {
    await serial(() => refetchDay(d, now));
    t = await dayTotals(d, ctx);
  }
  const c = { at: now, ...(w || {}), ...t };
  c.ok = Math.abs((w ? w.w : t.l) - t.y) < 0.01;
  const text = checkText(d, c);
  const sig = crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
  const st = (await appSync.getDoc("config", "wysperState")) || {};
  const prev = st.checks?.[d];
  let posted = prev?.posted || "";
  if (ctxDiscord.client && VENTES_CHANNEL_ID && (post === true || (post === "changed" && posted !== sig))) {
    try {
      const ch = await ctxDiscord.client.channels.fetch(VENTES_CHANNEL_ID);
      await ch.send({ content: post === "changed" ? `${text}\n-# Mis à jour à ${new Date(now).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" })}` : text, allowedMentions: { parse: [] } });
      posted = sig;
    } catch (e) {
      console.error("Wysper (récap du jour) :", e.message);
    }
  }
  await serial(async () => {
    const st2 = (await appSync.getDoc("config", "wysperState")) || {};
    const checks = Object.fromEntries(Object.entries(st2.checks || {}).filter(([k]) => k >= addDays(d, -40)));
    checks[d] = { at: now, ok: c.ok, w: c.w ?? null, wn: c.wn ?? null, l: c.l, y: c.y, u: c.u, i: c.i, j: c.j, m: c.m, f: c.f, posted };
    await appSync.putDoc("config", "wysperState", { ...st2, checks });
  });
  return { ...c, text };
}

// ---------- Temps réel : l'adresse où Wysper envoie chaque paiement ----------
// Signature : HMAC-SHA256(secret, X-Wysper-Timestamp + "." + corps brut), en-tête « v1=<hex> » (deux pendant une rotation)
function verify(headers, raw, secret = SECRET, now = Date.now()) {
  const ts = String(headers["x-wysper-timestamp"] || "");
  if (!/^\d+$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > TOLERANCE_S) return 400;
  const expected = crypto.createHmac("sha256", secret).update(`${ts}.`).update(raw).digest();
  const ok = String(headers["x-wysper-signature"] || "").split(",").some((part) => {
    const given = part.trim().replace(/^v1=/, "");
    return /^[0-9a-f]{64}$/.test(given) && crypto.timingSafeEqual(Buffer.from(given, "hex"), expected);
  });
  return ok ? true : 401;
}
const seen = new Set();
async function handleEvent(ev, now = Date.now()) {
  if (!ev?.id || seen.has(ev.id)) return null;
  seen.add(ev.id);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  // événement de test (bouton « Tester » de Wysper) : rien n'est compté, on note juste qu'il est bien arrivé
  if (ev.livemode === false || /^test_/.test(ev.data?.payment_id || "")) {
    await patchState({ lastTest: now, lastTestType: ev.type || "" });
    return { test: true };
  }
  if (!/^payment\./.test(ev.type || "") || !ev.data?.payment_id) return null; // premiers messages : pas utilisés ici
  return tick({ now, incoming: [ev.data] });
}
function webhookServer(port = Number(process.env.PORT || 8080)) {
  const srv = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end("Bot KL Agency : en ligne");
    }
    if (req.method !== "POST" || !/^\/wysper\/?$/.test(path)) {
      res.writeHead(404);
      return res.end();
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 2e6) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const v = verify(req.headers, raw);
      if (v !== true) {
        res.writeHead(v);
        return res.end();
      }
      let ev;
      try {
        ev = JSON.parse(raw.toString("utf8"));
      } catch {
        res.writeHead(400);
        return res.end();
      }
      // répondre d'abord (Wysper attend une réponse en moins de 10 s), traiter ensuite
      res.writeHead(200);
      res.end();
      handleEvent(ev).catch((e) => console.error("Wysper (temps réel) :", e.message));
    });
  });
  srv.listen(port, () => console.log(`Wysper : adresse temps réel ouverte (POST /wysper, port ${port}).`));
  return srv;
}

function start({ client } = {}) {
  ctxDiscord.client = client;
  if (!KEY && !SECRET) return console.log("Wysper : ni WYSPER_API_KEY ni WYSPER_WEBHOOK_SECRET, ventes Telegram en direct désactivées.");
  if (!appSync.enabled()) return console.log("Wysper : lien avec l'app désactivé (Supabase), rien à faire.");
  if (SECRET) webhookServer();
  if (!KEY) return console.log("Wysper : pas de WYSPER_API_KEY, pas de rattrapage ni de réattribution par nom de fan.");
  console.log(`Wysper : rattrapage des paiements toutes les ${EVERY_S} s.`);
  const go = () => tick().then((r) => r?.lines && console.log("Wysper :", JSON.stringify(r))).catch((e) => console.error("Wysper :", e.message));
  setTimeout(go, 5000);
  setInterval(go, EVERY_S * 1000);
  // vérifications avec le tableau de bord Wysper : toutes les heures (sans rien poster), récap de la veille à 00h20
  // dans le salon ventes, dernière vérif de la veille à 06h00 (postée seulement si le résultat a changé)
  const cron = require("node-cron");
  const today = () => parisParts(Date.now()).date;
  const ver = (d, post) => check(d, { post }).catch((e) => console.error("Wysper (vérif) :", e.message));
  const on = async () => (await appSync.getDoc("config", "wysper").catch(() => null))?.on !== false;
  cron.schedule("7 * * * *", async () => {
    if (!(await on())) return;
    const h = parisParts(Date.now()).h;
    if (h !== 0) await ver(today(), false);
    if (h > 0 && h < 6) await ver(addDays(today(), -1), false);
  }, { timezone: "Europe/Paris" });
  cron.schedule("20 0 * * *", async () => (await on()) && ver(addDays(today(), -1), true), { timezone: "Europe/Paris" });
  cron.schedule("0 6 * * *", async () => (await on()) && ver(addDays(today(), -1), "changed"), { timezone: "Europe/Paris" });
}

module.exports = { start, tick, check, verify, handleEvent, webhookServer, recomputeDay, slim, counted, norm, enabled, api, _contacts: contacts };
