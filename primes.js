// ================== 💸 PRIMES ==================
// 🛠️ Admin › 💸 Primes ouvre une petite fiche : le chatteur (recherche), le montant, € ou $, et la raison.
// La prime est gardée dans l'app (primes/<id>) et annoncée dans le salon primes :
//   « @chatteur Bien joué 💸 Prime de **20 €** | A ramené un bon chatteur »
// Les primes se paient en fin de mois : l'onglet Paies de l'app les ajoute à la paie du 1er du mois suivant
// (mois du jour de la prime, coupé à 2 h comme les pénalités).
// 🗑️ sous chaque prime du salon (admins) : l'annuler sur place, en deux clics (le message reste, barré).
// Le 1er à 10 h (pas le 16 : seules les pénalités ont un récap à la quinzaine), les primes du barème du mois qui finit
// sont calculées et ajoutées (primesauto.js), puis le récap part dans le salon primes (une ligne par chatteur avec son
// total et ses raisons) ; rien n'est posté s'il n'y en a eu aucune.
// 📋 Récap du mois (après une prime) : voir les autres mois, annuler une prime, envoyer le récap à la main.
// En bas du salon primes, un message garde le barème et deux boutons (admins) : 📊 Primes en cours, 💸 Nouvelle prime.
const { UserSelectMenuBuilder, StringSelectMenuBuilder, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const { money, workDay } = require("./penalties");
const { reply, done, showView, row, button, plS, opt, EPHEMERAL } = require("./ui");
const auto = require("./primesauto");

const PRIMES_CHANNEL_ID = (process.env.PRIMES_CHANNEL_ID ?? "1548285118026878996").trim();
// Fourni par index.js : isAdmin(i), client, nameOf(uid), getData(), saveData()
const ctx = {};
const states = new Map(); // userId -> { period } du récap ouvert (un mois : « 2026-11 »)

const monthLabel = (m) => new Date(`${m}-01T12:00:00Z`).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
// les primes vont par mois : « 2026-11 », payées le 1er du mois suivant
const periodOf = (date) => date.slice(0, 7);
const periodStep = (m, n) => {
  const d = new Date(`${m}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};
const periodLabel = (m) => `${/^(avril|août|octobre)/.test(monthLabel(m)) ? "d'" : "de "}${monthLabel(m)}`;
const payDayLabel = (m) => `1er ${monthLabel(periodStep(m, 1)).split(" ")[0]}`;
const dayShort = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const curOf = (p) => (p?.currency === "USD" ? "USD" : "EUR");

// Le message du salon ; un chatteur sans compte Discord relié (prime calculée) : son nom en gras
const who = (p) => (/^\d+$/.test(String(p.uid)) ? `<@${p.uid}>` : `**${p.name || "?"}**`);
const mentions = (list) => [...new Set(list.map((p) => String(p.uid)).filter((u) => /^\d+$/.test(u)))].slice(0, 100);
const lineOf = (p) => `${who(p)} Bien joué 💸 Prime de **${money(p.amount, curOf(p))}** | ${p.reason}`;
const rmRow = (p) => row(new ButtonBuilder().setCustomId(`pr_rm~${p.id}`).setEmoji("🗑️").setStyle(ButtonStyle.Secondary));

// ---------- Récap d'un mois ----------
// totaux par monnaie : « +30 € et +5 $ »
const totals = (l) => l.reduce((t, p) => ((t[curOf(p)] += Number(p.amount) || 0), t), { EUR: 0, USD: 0 });
const totTxt = (t) => Object.entries(t).filter(([, v]) => v).map(([c, v]) => `+${money(Math.round(v * 100) / 100, c)}`).join(" et ") || "0 €";
const totVal = (t) => t.EUR + t.USD;
async function periodList(k) {
  return (await appSync.primesIn(k.slice(0, 7))).filter((p) => periodOf(p.date) === k).sort((a, b) => (a.at || 0) - (b.at || 0));
}
// une ligne par chatteur, les plus grosses primes d'abord
function recapRows(list) {
  const by = new Map();
  for (const p of list) by.set(p.uid, [...(by.get(p.uid) || []), p]);
  return [...by.entries()]
    .map(([uid, l]) => ({ uid, l, tot: totals(l) }))
    .sort((a, b) => totVal(b.tot) - totVal(a.tot) || b.l.length - a.l.length);
}
const rowTxt = (r) => `${who(r.l[0])} · **${totTxt(r.tot)}** · ${r.l.length} prime${plS(r.l.length)}\n-# ${r.l.map((p) => p.reason).join(" · ").slice(0, 300)}`;
// « 📋 Récap des primes de novembre 2026 » : une ligne par @chatteur avec son total et ses raisons, puis le total
function recapText(k, list, short = []) {
  const rows = recapRows(list);
  let body = rows.map(rowTxt).join("\n");
  if (body.length > 1700) body = body.slice(0, body.lastIndexOf("\n", 1700)) + "\n…";
  return [
    `📋 **Récap des primes ${periodLabel(k)}**`,
    `-# À ajouter à la paie du ${payDayLabel(k)}.`,
    "",
    rows.length ? body : "_Aucune prime ce mois-ci._",
    ...(rows.length ? ["", `**Total : ${totTxt(totals(list))}** 💸`] : []),
    ...(short.length ? [`-# 🗓️ Moins de ${auto.CFG.minDays} jours travaillés, pas de primes du barème : ${short.map((r) => `${r.name} (${r.days} j)`).join(", ")}`] : []),
  ].join("\n");
}
// Envoie le récap d'un mois dans le salon primes
async function postRecap(k, t = Date.now(), list = null, short = []) {
  list ||= await periodList(k);
  const ch = await ctx.client.channels.fetch(PRIMES_CHANNEL_ID);
  const msg = await ch.send({ content: recapText(k, list, short), allowedMentions: { users: mentions(list) } });
  markSent(k, { channelId: ch.id, id: msg.id, at: t });
  await ensurePanel(true).catch((e) => console.warn("Primes (barème) :", e.message));
  return list.length;
}
function markSent(k, v) {
  const data = ctx.getData();
  data.primeRecaps ||= {};
  data.primeRecaps[k] = v;
  for (const x of Object.keys(data.primeRecaps)) if (x < periodStep(k, -6)) delete data.primeRecaps[x];
  ctx.saveData();
}
// Le 1er à 10 h (et au démarrage, si le bot était éteint à ce moment-là) : les primes du barème du mois qui vient de
// finir sont ajoutées dans l'app, puis le récap part dans le salon primes
const RECAP_HOUR = 10;
async function autoRecap(t = Date.now()) {
  if (!appSync.enabled() || !PRIMES_CHANNEL_ID || !ctx.getData) return null;
  const { date: d, h } = appSync.parisParts(t);
  const day = Number(d.slice(8, 10));
  if (day === 1 && h < RECAP_HOUR) return null;
  const prev = periodStep(periodOf(d), -1);
  // déjà fait après la fin du mois (un envoi à la main avant la fin ne compte pas : il en manquait peut-être)
  const sent = ctx.getData().primeRecaps?.[prev];
  if ((sent && periodOf(workDay(sent.at)) > prev) || day - 1 > 2) return null;
  const st = await auto.writeMonth(prev, t);
  const list = await periodList(prev);
  // aucune prime : rien à poster, c'est noté pour ne pas revenir dessus
  if (!list.length) return markSent(prev, { at: t, empty: true }), null;
  await postRecap(prev, t, list, st.rows.filter((r) => !r.elig && r.total));
  return prev;
}
// Le récap dans Discord (visible seulement par l'admin) : changer de mois, l'envoyer dans le salon
async function sumView(st) {
  const k = (st.period ||= periodOf(workDay()));
  const list = await periodList(k);
  const rows = recapRows(list);
  const tot = totals(list);
  const sent = ctx.getData?.().primeRecaps?.[k];
  return {
    content: [
      st.note,
      `📋 **Primes ${periodLabel(k)}**${totVal(tot) ? ` · ${totTxt(tot)} au total` : ""} · paie du ${payDayLabel(k)}`,
      rows.length ? rows.map(rowTxt).join("\n").slice(0, 1800) : "_Aucune prime ce mois-ci._",
      sent && !sent.empty ? `-# Récap envoyé dans le salon primes le ${dayShort(workDay(sent.at + 121 * 60e3))}.` : "",
    ].filter(Boolean).join("\n"),
    components: [
      ...(list.length
        ? [
            row(
              new StringSelectMenuBuilder()
                .setCustomId("pr_del")
                .setPlaceholder("🗑️ Annuler une prime…")
                .addOptions(list.slice(-25).map((p) => opt(`${p.name || "?"} · ${money(p.amount, curOf(p))}`, p.id, p.reason, null)))
            ),
          ]
        : []),
      row(
        button("pr_pe_-1", "Mois d'avant", "◀️", ButtonStyle.Secondary),
        button("pr_pe_1", "Mois d'après", "▶️", ButtonStyle.Secondary, k >= periodOf(workDay())),
        button("pr_post", "Envoyer le récap", "📣", ButtonStyle.Secondary, !rows.length),
        button("pr_add", "Nouvelle prime", "💸", ButtonStyle.Success),
        button("pa_live", "Primes en cours", "📊", ButtonStyle.Secondary)
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

// ---------- La petite fiche ----------
const label = (l, d) => (d ? new LabelBuilder().setLabel(l).setDescription(d) : new LabelBuilder().setLabel(l));
const text = (id, placeholder, max, required = true) => new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(max).setPlaceholder(placeholder);
const C = auto.CANDIDATURE;
function modal() {
  return new ModalBuilder().setCustomId("pr_new").setTitle("💸 Prime").addLabelComponents(
    label("Chatteur").setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId("who").setRequired(true).setMinValues(1).setMaxValues(1).setPlaceholder("🔎 Tape son nom")),
    label("Prime").setStringSelectMenuComponent(
      new StringSelectMenuBuilder().setCustomId("kind").setRequired(true).setMinValues(1).setMaxValues(1).addOptions(
        { label: `${C.l} : ${money(C.amount)}`, value: C.k, emoji: C.e, description: "Montant et raison remplis tout seuls" },
        { label: "Autre prime", value: "other", emoji: "✏️", description: "Écris le montant et la raison ci-dessous", default: true }
      )
    ),
    label("Montant (pour une autre prime)", "ex : 20 (ajouté à sa paie dans l'app)").setTextInputComponent(text("amount", "ex : 20", 8, false)),
    label("Monnaie").setStringSelectMenuComponent(
      new StringSelectMenuBuilder().setCustomId("cur").setRequired(true).setMinValues(1).setMaxValues(1).addOptions(
        { label: "Euros (€)", value: "EUR", emoji: "💶", default: true },
        { label: "Dollars ($)", value: "USD", emoji: "💵" }
      )
    ),
    label("Raison (pour une autre prime)", "Elle s'affiche dans le salon primes").setTextInputComponent(text("reason", "ex : Meilleur chatteur de la semaine", 200, false))
  );
}
async function open(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  if (!appSync.enabled()) return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  return i.showModal(modal());
}
const field = (i, fn, id) => {
  try {
    return i.fields[fn](id);
  } catch {
    return null;
  }
};
// « 20 », « 12,50 », « 20 € » -> 20 ; NaN si ce n'est pas un montant
const parseAmount = (v) => {
  const raw = String(v || "").replace(",", ".").replace(/[€$\s]/g, "");
  return raw ? Math.round(Number(raw) * 100) / 100 : NaN;
};

// La fiche envoyée : la prime part dans le salon primes et dans l'app
async function submit(i) {
  const u = field(i, "getSelectedUsers", "who")?.first?.();
  // 📨 candidature confirmée : montant et raison du barème
  const cand = (field(i, "getStringSelectValues", "kind") || [])[0] === C.k;
  const amount = cand ? C.amount : parseAmount(field(i, "getTextInputValue", "amount"));
  const currency = !cand && (field(i, "getStringSelectValues", "cur") || [])[0] === "USD" ? "USD" : "EUR";
  const reason = cand ? `${C.e} ${C.l}` : String(field(i, "getTextInputValue", "reason") || "").replace(/\s+/g, " ").trim();
  await i.deferReply({ flags: EPHEMERAL });
  const errors = [
    !u && "choisis le chatteur.",
    u?.bot && "choisis un chatteur, pas un bot.",
    !(Number.isFinite(amount) && amount > 0 && amount <= 10000) && "écris le montant (ex : 20).",
    !reason && "écris la raison.",
  ].filter(Boolean);
  if (errors.length) return done(i, `⚠️ Rien n'est envoyé : ${errors.join(" ")}`, 30000);
  const date = workDay();
  const m = date.slice(0, 7);
  const c = await appSync.chatterOf(u.id, [ctx.nameOf?.(u.id)].filter(Boolean), false).catch(() => null);
  const p = {
    id: `${m}-${appSync.newId()}`, month: m, date, at: Date.now(), by: i.user.id,
    uid: u.id, chatterId: c?.id || null, name: c?.name || ctx.nameOf?.(u.id) || u.username, amount, currency, reason,
    ...(cand ? { kind: C.k } : {}),
  };
  let where = "";
  try {
    const ch = await ctx.client.channels.fetch(PRIMES_CHANNEL_ID);
    const msg = await ch.send({ content: lineOf(p), components: [rmRow(p)], allowedMentions: { users: [p.uid] } });
    p.msg = { channelId: ch.id, id: msg.id };
    where = ` dans <#${ch.id}>`;
    ensurePanel(true).catch((e) => console.warn("Primes (barème) :", e.message));
  } catch (e) {
    console.error("Prime (salon) :", e.message);
    where = ` ⚠️ Message pas envoyé dans le salon primes : ${String(e.message).slice(0, 150)}`;
  }
  await appSync.addPrime(p);
  return showView(i, {
    content: [
      `✅ Envoyé${where} : <@${p.uid}> 💸 **${money(amount, currency)}** | ${reason}`,
      c ? `-# Ajoutée à sa paie du ${payDayLabel(m)} dans l'app (onglet Paies) : les primes se paient en fin de mois.` : "-# ⚠️ Pas relié à un chatteur de l'app : relie son compte Discord dans sa fiche pour qu'elle compte dans sa paie.",
    ].join("\n"),
    components: [row(button("pr_add", "Nouvelle prime", "💸", ButtonStyle.Success), button("pr_sum", "Récap du mois", "📋", ButtonStyle.Secondary))],
  });
}

// Annule une prime : retirée de l'app (donc de la paie) ; son message reste, barré, sans le bouton 🗑️
async function cancel(p, by) {
  await appSync.delPrime(p.id);
  if (p.msg)
    await ctx.client.channels
      .fetch(p.msg.channelId)
      .then((ch) => ch.messages.edit(p.msg.id, { content: `~~${lineOf(p)}~~\n-# Annulée par <@${by}>`, components: [], allowedMentions: { parse: [] } }))
      .catch((e) => console.warn("Prime annulée (message) :", e.message));
  return `🗑️ Annulée : <@${p.uid}> ${money(p.amount, curOf(p))} | ${p.reason}. Elle est retirée de sa paie dans l'app.`;
}
const byId = async (id) => (await appSync.primesIn(id.slice(0, 7))).find((x) => x.id === id);
async function rmAsk(i, pid) {
  await i.deferReply({ flags: EPHEMERAL });
  const p = await byId(pid);
  if (!p) return done(i, "Cette prime est déjà annulée.", 8000);
  return showView(i, {
    content: `🗑️ Annuler la prime de <@${p.uid}> : **${money(p.amount, curOf(p))}** | ${p.reason} (${dayShort(p.date)}) ?\n-# Elle est retirée de sa paie dans l'app, et son message reste barré dans le salon.`,
    components: [row(button(`pr_rmok~${p.id}`, "Oui, annuler", "🗑️", ButtonStyle.Danger), button("pr_rmno", "Non", null, ButtonStyle.Secondary))],
    allowedMentions: { parse: [] },
  });
}

// ---------- En bas du salon primes : le barème et les boutons (admins) ----------
function panel() {
  return {
    content: [
      "💸 **Primes du mois**",
      auto.baremeTxt(),
      `-# Calculées toutes seules avec le pointage et Wysper, ajoutées à la paie et récapitulées ici le 1er du mois à ${RECAP_HOUR} h.`,
    ].join("\n"),
    components: [row(button("pa_live", "Primes en cours", "📊", ButtonStyle.Secondary), button("pr_add", "Nouvelle prime", "💸", ButtonStyle.Success))],
    allowedMentions: { parse: [] },
  };
}
// bump : le reposter tout en bas (après un récap ou une prime) ; sinon le remettre seulement s'il a disparu
async function ensurePanel(bump = false) {
  if (!PRIMES_CHANNEL_ID || !ctx.getData) return null;
  const data = ctx.getData();
  const ch = await ctx.client.channels.fetch(PRIMES_CHANNEL_ID);
  const old = data.primesPanel?.id ? await ch.messages.fetch(data.primesPanel.id).catch(() => null) : null;
  if (old && !bump) {
    if (old.content !== panel().content) await old.edit(panel());
    return old.id;
  }
  if (old) await old.delete().catch(() => {});
  const msg = await ch.send(panel());
  data.primesPanel = { channelId: ch.id, id: msg.id };
  ctx.saveData();
  return msg.id;
}

// ---------- Interactions pr_… ----------
async function handle(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const id = i.customId;
  if (id === "pr_new") return submit(i);
  if (id === "pr_add") return i.showModal(modal());
  if (id.startsWith("pr_rm~")) return rmAsk(i, id.slice(6));
  if (id === "pr_del") return rmAsk(i, i.values?.[0] || "");
  if (id === "pr_rmno") return done(i, "D'accord, rien n'est annulé.", 4000);
  // 📋 récap : ◀️ ▶️ change de mois, 📣 l'envoie dans le salon primes
  if (id === "pr_sum" || id.startsWith("pr_pe_") || id === "pr_post") {
    if (id === "pr_sum") states.set(i.user.id, {});
    const st = states.get(i.user.id);
    if (!st) return done(i, "Ce menu a expiré : reclique sur 📋 Récap du mois.", 8000);
    await i.deferUpdate();
    st.note = "";
    if (id.startsWith("pr_pe_")) st.period = periodStep(st.period || periodOf(workDay()), Number(id.slice(6)) || 0);
    else if (id === "pr_post") {
      const n = await postRecap(st.period || periodOf(workDay())).catch((e) => ({ error: e.message }));
      st.note = n?.error ? `⚠️ Récap pas envoyé : ${String(n.error).slice(0, 150)}` : `📣 Récap ${periodLabel(st.period)} envoyé dans <#${PRIMES_CHANNEL_ID}>.`;
    }
    return showView(i, await sumView(st));
  }
  if (id.startsWith("pr_rmok~")) {
    await i.deferUpdate();
    const p = await byId(id.slice(8));
    return done(i, p ? await cancel(p, i.user.id) : "Cette prime est déjà annulée.", 15000);
  }
  return reply(i, { content: "Ce bouton a expiré : reclique sur 🛠️ Admin › 💸 Primes." });
}

module.exports = { ctx, open, handle, modal, lineOf, parseAmount, PRIMES_CHANNEL_ID, autoRecap, postRecap, recapText, ensurePanel, panel, RECAP_HOUR };
