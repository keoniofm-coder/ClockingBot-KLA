// ================== 💸 PRIMES DU MOIS, CALCULÉES TOUTES SEULES ==================
// Barème de Kéoni (22 nov. 2026), d'après les chiffres de l'app pour le mois :
//   📅 1 absence max dans le mois : 3,50 €        (Pointage : absences, sauf les jours de day off)
//   🔓 25 % d'unlock PPV ou plus : 3,50 €           (Wysper : PPV payés sur PPV envoyés, tous ses comptes Wysper)
//   💬 Temps de réponse sous 2 min : 2,50 €         (Wysper : médiane du jour, moyenne du mois pondérée par les réponses)
//   🔌 Moins de 5 coupures : 2 €                    (Pointage : shifts avec une coupure)
//   ⏰ Moins de 3 retards : 1,50 €                  (Pointage : retards, aussi ceux d'un shift passé ensuite en coupure)
//   📨 Apport de candidature confirmé : 2 €        (à la main : 🛠️ Admin › 💸 Primes, choix « Candidature confirmée »)
// Comptent : les chatteurs actifs qui ont au moins un shift pointé dans le mois (présent, retard ou coupure).
// Pour les toucher, il faut avoir travaillé au moins 20 jours dans le mois (jours avec un shift pointé ; PRIMES_MIN_DAYS).
// Le 1er à 10 h, les primes du mois qui vient de finir sont écrites dans l'app (primes/<mois>-auto-<chatteur>-<critère>,
// datées du dernier jour du mois : payées avec la paie du 1er) puis le récap part dans le salon primes (primes.js).
// 📊 Primes en cours (admins, en éphémère) : où en est chaque chatteur ce mois-ci. Les mêmes chiffres sont gardés dans
// primesLive/<mois> pour l'onglet Paies de l'app (mis à jour toutes les 30 minutes).
const { ButtonStyle, EmbedBuilder } = require("discord.js");
const appSync = require("./app-sync");
const wysper = require("./wysper");
const { money } = require("./penalties");
const { reply, done, showView, row, button, plS, EPHEMERAL } = require("./ui");

const ctx = {}; // isAdmin(i) (index.js)
const states = new Map(); // userId -> { month }
const { addDays, parisParts } = appSync;
const num = (v) => Number(v) || 0;

const BAREME = [
  { k: "abs", e: "📅", l: "1 absence max dans le mois", short: "Max 1 absence", amount: 3.5, ok: (s) => s.abs <= 1 },
  { k: "unlock", e: "🔓", l: "25 % d'unlock PPV ou plus", short: "Unlock PPV 25 %+", amount: 3.5, ok: (s) => s.rate != null && s.rate >= 25 },
  { k: "rt", e: "💬", l: "Temps de réponse sous 2 min", short: "Réponse sous 2 min", amount: 2.5, ok: (s) => s.rt != null && s.rt < 120 },
  { k: "cut", e: "🔌", l: "Moins de 5 coupures", short: "Moins de 5 coupures", amount: 2, ok: (s) => s.cut < 5 },
  { k: "ret", e: "⏰", l: "Moins de 3 retards", short: "Moins de 3 retards", amount: 1.5, ok: (s) => s.ret < 3 },
];
// prime donnée à la main, au choix dans la fiche 💸
const CANDIDATURE = { k: "candidature", e: "📨", l: "Apport de candidature confirmé", amount: 2 };
// minimum de jours travaillés dans le mois (Kéoni, 22 nov. 2026 : 20 jours)
const CFG = { minDays: Number(process.env.PRIMES_MIN_DAYS) || 20 };
const baremeTxt = () => [...BAREME, CANDIDATURE].map((b) => `${b.e} ${b.l} : **${money(b.amount)}**`).join("\n") +
  `\n-# 🗓️ Il faut au moins ${CFG.minDays} jours travaillés dans le mois pour toucher les primes du barème.`;

// jour de travail (coupé à 2 h), mois, dernier jour d'un mois
const workDay = (t = Date.now()) => parisParts(t - 121 * 60e3).date;
const lastDay = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}`;
};
const monthStep = (m, n) => {
  const d = new Date(`${m}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};
const monthLabel = (m) => new Date(`${m}-01T12:00:00Z`).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
const ofMonth = (m) => `${/^(avril|août|octobre)/.test(monthLabel(m)) ? "d'" : "de "}${monthLabel(m)}`;
const dayShort = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
// « 1 min 25 », « 45 s »
const dur = (s) => {
  s = Math.round(num(s));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  return m < 60 ? `${m} min${r && m < 10 ? ` ${String(r).padStart(2, "0")}` : ""}` : `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, "0")}` : ""}`;
};
const pct = (v) => `${(Math.round(v * 10) / 10).toLocaleString("fr-FR")} %`;

// ---------- Les chiffres du mois, chatteur par chatteur ----------
// upTo : dernier jour compté (le mois en cours s'arrête à aujourd'hui)
async function monthStats(m, t = Date.now()) {
  const from = `${m}-01`, end = lastDay(m), today = workDay(t);
  const upTo = end < today ? end : today;
  const [att, wst, offs, chatters, imp, cat] = await Promise.all([
    appSync.docsBetween("att", from, upTo),
    appSync.docsBetween("wystats", from, upTo).catch(() => ({})),
    appSync.offsBetween(from, upTo).catch(() => []),
    appSync.appChatters(true),
    appSync.getDoc("config", "import").catch(() => null),
    appSync.appCatalog().catch(() => ({ models: {} })),
  ]);
  const off = new Set(offs.map((o) => `${o.date}|${o.chatterId}`));
  const byId = Object.fromEntries(chatters.map((c) => [c.id, c]));
  const S = {};
  const z = (cid) => (S[cid] ||= { cid, shifts: 0, dates: new Set(), abs: 0, ret: 0, cut: 0, sends: 0, unl: 0, rtS: 0, rtN: 0 });
  // Pointage
  for (const [date, doc] of Object.entries(att)) {
    if (date < from || date > upTo) continue;
    for (const mk of Object.values(doc?.marks || {})) {
      if (!mk?.chatterId || !byId[mk.chatterId]) continue;
      const x = z(mk.chatterId);
      if (["present", "retard", "coupure"].includes(mk.status)) { x.shifts++; x.dates.add(date); }
      if (mk.status === "absent" && !off.has(`${date}|${mk.chatterId}`)) x.abs++;
      if (mk.status === "coupure") x.cut++;
      // un retard reste un retard quand le shift passe ensuite en coupure (heure du clock in gardée)
      if (mk.status === "retard" || (mk.status === "coupure" && mk.in && mk.slot && appSync.lateness(mk.slot, mk.in).isLate)) x.ret++;
    }
  }
  // Wysper : noms des membres reliés aux chatteurs comme dans l'app (liens de l'import)
  const w = imp?.whysper || {};
  const links = { c: w.chatters || {}, m: w.models || {} };
  const all = Object.fromEntries(chatters.map((c) => [c.id, { name: c.name, active: c.active }]));
  for (const doc of Object.values(wst)) {
    if (!doc || doc.v !== 1) continue;
    const cOf = {}, mOf = {};
    const who = (uid) => (cOf[uid] ??= wysper.linkOf(links.c, all, doc.u?.[uid] || ""));
    const skipAcc = (acc) => (mOf[acc] ??= wysper.linkOf(links.m, cat.models || {}, doc.a?.[acc] || "")) === "-";
    for (const r of doc.m || []) {
      const [, acc, uid, , , sends, unl] = r;
      const cid = who(uid);
      if (!cid || cid === "-" || !byId[cid] || skipAcc(acc)) continue;
      const x = z(cid);
      x.sends += num(sends);
      x.unl += num(unl);
    }
    for (const [uid, v] of Object.entries(doc.rt?.m || {})) {
      const cid = who(uid);
      if (!cid || cid === "-" || !byId[cid] || !Array.isArray(v) || !num(v[2])) continue;
      const x = z(cid);
      x.rtS += num(v[0]) * num(v[2]);
      x.rtN += num(v[2]);
    }
  }
  const done = upTo === end && today > end;
  // jours encore possibles : ceux après aujourd'hui, et aujourd'hui s'il n'a pas encore de shift pointé
  const after = done ? 0 : Math.round((Date.parse(end + "T12:00:00Z") - Date.parse(upTo + "T12:00:00Z")) / 864e5);
  const rows = Object.values(S)
    .filter((x) => x.shifts > 0 && byId[x.cid]?.active)
    .map(({ dates, ...x }) => {
      const c = byId[x.cid];
      const s = { ...x, days: dates.size, name: c.name, uid: c.discordId || "", rate: x.sends ? (x.unl / x.sends) * 100 : null, rt: x.rtN ? x.rtS / x.rtN : null };
      s.ok = BAREME.filter((b) => b.ok(s)).map((b) => b.k);
      s.total = Math.round(BAREME.filter((b) => s.ok.includes(b.k)).reduce((a, b) => a + b.amount, 0) * 100) / 100;
      // elig : assez de jours ; reach : peut encore les avoir d'ici la fin du mois
      s.elig = s.days >= CFG.minDays;
      s.reach = s.elig || s.days + after + (done || dates.has(upTo) ? 0 : 1) >= CFG.minDays;
      s.pay = s.elig ? s.total : 0;
      return s;
    })
    .sort((a, b) => b.reach - a.reach || b.total - a.total || a.name.localeCompare(b.name, "fr"));
  return { month: m, from, upTo, end, done, minDays: CFG.minDays, rows, at: t };
}

// ---------- Ce que l'app affiche (onglet Paies) ----------
const slim = (r) => ({
  name: r.name, shifts: r.shifts, days: r.days, abs: r.abs, ret: r.ret, cut: r.cut, sends: r.sends, unl: r.unl,
  rate: r.rate == null ? null : Math.round(r.rate * 10) / 10, rt: r.rt == null ? null : Math.round(r.rt), ok: r.ok, total: r.total,
  elig: r.elig, reach: r.reach,
});
async function saveLive(st) {
  await appSync.putDoc("primesLive", st.month, {
    month: st.month, at: st.at, upTo: st.upTo, done: st.done, minDays: st.minDays,
    bareme: [...BAREME.map(({ k, e, l, short, amount }) => ({ k, e, l, short, amount })), { ...CANDIDATURE, manual: true }],
    rows: Object.fromEntries(st.rows.map((r) => [r.cid, slim(r)])),
  });
}
// mois en cours (et le mois d'avant les 2 premiers jours, le temps que tout soit pointé)
async function refreshLive(t = Date.now()) {
  if (!appSync.enabled()) return 0;
  const m = workDay(t).slice(0, 7);
  const months = Number(workDay(t).slice(8, 10)) <= 2 ? [monthStep(m, -1), m] : [m];
  for (const k of months) await saveLive(await monthStats(k, t));
  return months.length;
}

// ---------- Le 1er à 10 h : les primes du mois fini, écrites dans l'app ----------
const autoId = (m, cid, k) => `${m}-auto-${cid}-${k}`;
async function writeMonth(m, t = Date.now()) {
  const st = await monthStats(m, t);
  await saveLive(st).catch((e) => console.warn("Primes (app) :", e.message));
  const have = new Set((await appSync.primesIn(m)).filter((p) => p.auto).map((p) => p.id));
  let n = 0;
  for (const r of st.rows.filter((x) => x.elig))
    for (const b of BAREME) {
      const id = autoId(m, r.cid, b.k);
      if (!r.ok.includes(b.k) || have.has(id)) continue;
      await appSync.addPrime({
        id, month: m, date: st.end, at: t, by: "auto", auto: b.k,
        uid: r.uid || `app:${r.cid}`, chatterId: r.cid, name: r.name, amount: b.amount, currency: "EUR", reason: `${b.e} ${b.short}`,
      });
      n++;
    }
  return { ...st, written: n };
}

// ---------- 📊 Primes en cours (admins, en éphémère) ----------
const mark = (ok) => (ok ? "✅" : "❌");
// jours travaillés : ✅ assez, ⏳ encore possible, ❌ trop tard
const daysTxt = (r, min) => `🗓️ ${r.elig ? `${r.days} jours ✅` : `${r.days}/${min} jours ${r.reach ? "⏳" : "❌"}`}`;
function lineOf(r, manual, min = CFG.minDays) {
  const has = (k) => r.ok.includes(k);
  const extra = manual?.length ? ` · 📨 +${money(manual.reduce((a, p) => a + num(p.amount), 0))}` : "";
  const tot = r.reach ? `**${money(r.total)}**` : `~~${money(r.total)}~~`;
  return [
    `**${r.name}** · ${tot}${extra} · ${daysTxt(r, min)}`,
    `-# 📅 ${r.abs} ${mark(has("abs"))} · ⏰ ${r.ret} ${mark(has("ret"))} · 🔌 ${r.cut} ${mark(has("cut"))} · 🔓 ${r.rate == null ? "pas de PPV" : pct(r.rate)} ${mark(has("unlock"))} · 💬 ${r.rt == null ? "pas de chiffres" : dur(r.rt)} ${mark(has("rt"))}`,
  ].join("\n");
}
async function liveView(st) {
  const now = Date.now();
  const cur = workDay(now).slice(0, 7);
  const m = (st.month ||= cur);
  const [s, primes] = await Promise.all([monthStats(m, now), appSync.primesIn(m).catch(() => [])]);
  saveLive(s).catch((e) => console.warn("Primes (app) :", e.message));
  const manual = primes.filter((p) => !p.auto);
  const manBy = (r) => manual.filter((p) => p.chatterId === r.cid);
  const auto = s.rows.reduce((a, r) => a + (r.reach ? r.total : 0), 0);
  const man = manual.reduce((a, p) => a + (p.currency === "USD" ? 0 : num(p.amount)), 0);
  const lines = s.rows.map((r) => lineOf(r, manBy(r)));
  let desc = lines.join("\n");
  if (desc.length > 3900) desc = desc.slice(0, desc.lastIndexOf("\n**", 3900)) + "\n…";
  const embed = new EmbedBuilder()
    .setColor(0x4cc992)
    .setTitle(`📊 Primes ${ofMonth(m)}${s.done ? "" : ` · en cours, jusqu'au ${dayShort(s.upTo)}`}`)
    .setDescription(desc || "_Personne n'a encore de shift pointé ce mois-ci._")
    .addFields({ name: "Barème", value: baremeTxt() })
    .setFooter({ text: `Total : ${money(Math.round((auto + man) * 100) / 100)}${man ? ` (dont ${money(man)} à la main)` : ""} · 🗓️ jours travaillés (${s.minDays} minimum, ⏳ encore possible) · 📅 absences · ⏰ retards · 🔌 coupures · 🔓 unlock PPV · 💬 temps de réponse` });
  return {
    content: st.note || "",
    embeds: [embed],
    components: [
      row(
        button("pa_m_-1", "Mois d'avant", "◀️", ButtonStyle.Secondary),
        button("pa_m_1", "Mois d'après", "▶️", ButtonStyle.Secondary, m >= cur),
        button("pa_live", "Actualiser", "🔄", ButtonStyle.Secondary)
      ),
    ],
  };
}

async function handle(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  if (!appSync.enabled()) return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  const id = i.customId;
  // depuis le message du salon : un nouveau message éphémère ; depuis la vue : on la remplace
  const fresh = !i.message?.flags?.has?.(EPHEMERAL);
  if (id === "pa_live" || id.startsWith("pa_m_")) {
    if (fresh) states.set(i.user.id, {});
    const st = states.get(i.user.id) || {};
    states.set(i.user.id, st);
    if (fresh) await i.deferReply({ flags: EPHEMERAL });
    else await i.deferUpdate();
    if (id.startsWith("pa_m_")) st.month = monthStep(st.month || workDay().slice(0, 7), Number(id.slice(5)) || 0);
    return showView(i, await liveView(st));
  }
  return done(i, "Ce bouton a expiré.", 5000);
}

module.exports = { ctx, CFG, BAREME, CANDIDATURE, baremeTxt, monthStats, writeMonth, refreshLive, saveLive, handle, liveView, lastDay, monthStep, workDay };
