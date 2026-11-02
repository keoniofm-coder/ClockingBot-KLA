// ================== 💸 PRIMES ==================
// 🛠️ Admin › 💸 Primes ouvre une petite fiche : le chatteur (recherche), le montant, € ou $, et la raison.
// La prime est gardée dans l'app (primes/<id>) et annoncée dans le salon primes :
//   « @chatteur Bien joué 💸 Prime de **20 €** | A ramené un bon chatteur »
// L'onglet Paies de l'app l'ajoute à sa paie (quinzaine du jour de la prime, coupée à 2 h comme les pénalités).
// 🗑️ sous chaque prime du salon (admins) : l'annuler sur place, en deux clics (le message reste, barré).
// Comme les pénalités : le 16 et le 1er à 2 h, le récap des primes de la quinzaine qui finit part dans le salon primes
// (une ligne par chatteur avec son total et ses raisons) ; rien n'est posté s'il n'y a eu aucune prime.
// 📋 Récap de la quinzaine (après une prime) : voir les autres quinzaines et envoyer le récap à la main.
const { UserSelectMenuBuilder, StringSelectMenuBuilder, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const { money, workDay, periodOf, periodStep, periodLabel, payDayLabel } = require("./penalties");
const { reply, done, showView, row, button, plS, EPHEMERAL } = require("./ui");

const PRIMES_CHANNEL_ID = (process.env.PRIMES_CHANNEL_ID ?? "1548285118026878996").trim();
// Fourni par index.js : isAdmin(i), client, nameOf(uid), getData(), saveData()
const ctx = {};
const states = new Map(); // userId -> { period } du récap ouvert

const monthLabel = (m) => new Date(`${m}-01T12:00:00Z`).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
const dayShort = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const curOf = (p) => (p?.currency === "USD" ? "USD" : "EUR");

// Le message du salon
const lineOf = (p) => `<@${p.uid}> Bien joué 💸 Prime de **${money(p.amount, curOf(p))}** | ${p.reason}`;
const rmRow = (p) => row(new ButtonBuilder().setCustomId(`pr_rm~${p.id}`).setEmoji("🗑️").setStyle(ButtonStyle.Secondary));

// ---------- Récap d'une quinzaine ----------
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
const rowTxt = (r) => `<@${r.uid}> · **${totTxt(r.tot)}** · ${r.l.length} prime${plS(r.l.length)}\n-# ${r.l.map((p) => p.reason).join(" · ").slice(0, 300)}`;
// « 📋 Récap des primes du 1er au 15 novembre 2026 » : une ligne par @chatteur avec son total et ses raisons, puis le total
function recapText(k, list) {
  const rows = recapRows(list);
  let body = rows.map(rowTxt).join("\n");
  if (body.length > 1700) body = body.slice(0, body.lastIndexOf("\n", 1700)) + "\n…";
  return [
    `📋 **Récap des primes ${periodLabel(k)}**`,
    `-# À ajouter à la paie du ${payDayLabel(k)}.`,
    "",
    rows.length ? body : "_Aucune prime sur cette quinzaine._",
    ...(rows.length ? ["", `**Total : ${totTxt(totals(list))}** 💸`] : []),
  ].join("\n");
}
// Envoie le récap d'une quinzaine dans le salon primes
async function postRecap(k, t = Date.now(), list = null) {
  list ||= await periodList(k);
  const ch = await ctx.client.channels.fetch(PRIMES_CHANNEL_ID);
  const msg = await ch.send({ content: recapText(k, list), allowedMentions: { users: [...new Set(list.map((p) => p.uid))].slice(0, 100) } });
  markSent(k, { channelId: ch.id, id: msg.id, at: t });
  return list.length;
}
function markSent(k, v) {
  const data = ctx.getData();
  data.primeRecaps ||= {};
  data.primeRecaps[k] = v;
  for (const x of Object.keys(data.primeRecaps)) if (x < periodStep(k, -6)) delete data.primeRecaps[x];
  ctx.saveData();
}
// Le 1er et le 16 à 2 h (et au démarrage, si le bot était éteint à ce moment-là) : récap de la quinzaine qui vient de finir
async function autoRecap(t = Date.now()) {
  if (!appSync.enabled() || !PRIMES_CHANNEL_ID || !ctx.getData) return null;
  const d = workDay(t);
  const cur = periodOf(d);
  const prev = periodStep(cur, -1);
  const since = Number(d.slice(8, 10)) - (cur.endsWith("A") ? 1 : 16); // jours depuis la coupure
  // déjà fait après la fin de la quinzaine (un envoi à la main avant la fin ne compte pas : il en manquait peut-être)
  const sent = ctx.getData().primeRecaps?.[prev];
  if ((sent && periodOf(workDay(sent.at)) > prev) || since > 2) return null;
  const list = await periodList(prev);
  // aucune prime : rien à poster, c'est noté pour ne pas revenir dessus
  if (!list.length) return markSent(prev, { at: t, empty: true }), null;
  await postRecap(prev, t, list);
  return prev;
}
// Le récap dans Discord (visible seulement par l'admin) : changer de quinzaine, l'envoyer dans le salon
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
      rows.length ? rows.map(rowTxt).join("\n").slice(0, 1800) : "_Aucune prime sur cette quinzaine._",
      sent && !sent.empty ? `-# Récap envoyé dans le salon primes le ${dayShort(workDay(sent.at + 121 * 60e3))}.` : "",
    ].filter(Boolean).join("\n"),
    components: [
      row(
        button("pr_pe_-1", "Quinzaine d'avant", "◀️", ButtonStyle.Secondary),
        button("pr_pe_1", "Quinzaine d'après", "▶️", ButtonStyle.Secondary, k >= periodOf(workDay())),
        button("pr_post", "Envoyer le récap", "📣", ButtonStyle.Secondary, !rows.length),
        button("pr_add", "Nouvelle prime", "💸", ButtonStyle.Success)
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

// ---------- La petite fiche ----------
const label = (l, d) => (d ? new LabelBuilder().setLabel(l).setDescription(d) : new LabelBuilder().setLabel(l));
const text = (id, placeholder, max) => new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(max).setPlaceholder(placeholder);
function modal() {
  return new ModalBuilder().setCustomId("pr_new").setTitle("💸 Prime").addLabelComponents(
    label("Chatteur").setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId("who").setRequired(true).setMinValues(1).setMaxValues(1).setPlaceholder("🔎 Tape son nom")),
    label("Montant", "ex : 20 (ajouté à sa paie dans l'app)").setTextInputComponent(text("amount", "ex : 20", 8)),
    label("Monnaie").setStringSelectMenuComponent(
      new StringSelectMenuBuilder().setCustomId("cur").setRequired(true).setMinValues(1).setMaxValues(1).addOptions(
        { label: "Euros (€)", value: "EUR", emoji: "💶", default: true },
        { label: "Dollars ($)", value: "USD", emoji: "💵" }
      )
    ),
    label("Raison", "Elle s'affiche dans le salon primes").setTextInputComponent(text("reason", "ex : A ramené un bon chatteur", 200))
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
  const amount = parseAmount(field(i, "getTextInputValue", "amount"));
  const currency = (field(i, "getStringSelectValues", "cur") || [])[0] === "USD" ? "USD" : "EUR";
  const reason = String(field(i, "getTextInputValue", "reason") || "").replace(/\s+/g, " ").trim();
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
  };
  let where = "";
  try {
    const ch = await ctx.client.channels.fetch(PRIMES_CHANNEL_ID);
    const msg = await ch.send({ content: lineOf(p), components: [rmRow(p)], allowedMentions: { users: [p.uid] } });
    p.msg = { channelId: ch.id, id: msg.id };
    where = ` dans <#${ch.id}>`;
  } catch (e) {
    console.error("Prime (salon) :", e.message);
    where = ` ⚠️ Message pas envoyé dans le salon primes : ${String(e.message).slice(0, 150)}`;
  }
  await appSync.addPrime(p);
  return showView(i, {
    content: [
      `✅ Envoyé${where} : <@${p.uid}> 💸 **${money(amount, currency)}** | ${reason}`,
      c ? `-# Ajoutée à sa paie dans l'app (onglet Paies, ${monthLabel(m)}).` : "-# ⚠️ Pas relié à un chatteur de l'app : relie son compte Discord dans sa fiche pour qu'elle compte dans sa paie.",
    ].join("\n"),
    components: [row(button("pr_add", "Nouvelle prime", "💸", ButtonStyle.Success), button("pr_sum", "Récap de la quinzaine", "📋", ButtonStyle.Secondary))],
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

// ---------- Interactions pr_… ----------
async function handle(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const id = i.customId;
  if (id === "pr_new") return submit(i);
  if (id === "pr_add") return i.showModal(modal());
  if (id.startsWith("pr_rm~")) return rmAsk(i, id.slice(6));
  if (id === "pr_rmno") return done(i, "D'accord, rien n'est annulé.", 4000);
  // 📋 récap : ◀️ ▶️ change de quinzaine, 📣 l'envoie dans le salon primes
  if (id === "pr_sum" || id.startsWith("pr_pe_") || id === "pr_post") {
    if (id === "pr_sum") states.set(i.user.id, {});
    const st = states.get(i.user.id);
    if (!st) return done(i, "Ce menu a expiré : reclique sur 📋 Récap de la quinzaine.", 8000);
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

module.exports = { ctx, open, handle, modal, lineOf, parseAmount, PRIMES_CHANNEL_ID, autoRecap, postRecap, recapText };
