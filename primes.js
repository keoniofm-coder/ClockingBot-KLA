// ================== 💸 PRIMES ==================
// 🛠️ Admin › 💸 Primes ouvre une petite fiche : le chatteur (recherche), le montant, € ou $, et la raison.
// La prime est gardée dans l'app (primes/<id>) et annoncée dans le salon primes :
//   « @chatteur Bien joué 💸 Prime de **20 €** | A ramené un bon chatteur »
// L'onglet Paies de l'app l'ajoute à sa paie (quinzaine du jour de la prime, coupée à 2 h comme les pénalités).
// 🗑️ sous chaque prime du salon (admins) : l'annuler sur place, en deux clics (le message reste, barré).
const { UserSelectMenuBuilder, StringSelectMenuBuilder, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const { money, workDay } = require("./penalties");
const { reply, done, showView, row, button, EPHEMERAL } = require("./ui");

const PRIMES_CHANNEL_ID = (process.env.PRIMES_CHANNEL_ID ?? "1548285118026878996").trim();
// Fourni par index.js : isAdmin(i), client, nameOf(uid)
const ctx = {};

const monthLabel = (m) => new Date(`${m}-01T12:00:00Z`).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
const dayShort = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const curOf = (p) => (p?.currency === "USD" ? "USD" : "EUR");

// Le message du salon
const lineOf = (p) => `<@${p.uid}> Bien joué 💸 Prime de **${money(p.amount, curOf(p))}** | ${p.reason}`;
const rmRow = (p) => row(new ButtonBuilder().setCustomId(`pr_rm~${p.id}`).setEmoji("🗑️").setStyle(ButtonStyle.Secondary));

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
    components: [row(button("pr_add", "Nouvelle prime", "💸", ButtonStyle.Success))],
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
  if (id.startsWith("pr_rmok~")) {
    await i.deferUpdate();
    const p = await byId(id.slice(8));
    return done(i, p ? await cancel(p, i.user.id) : "Cette prime est déjà annulée.", 15000);
  }
  return reply(i, { content: "Ce bouton a expiré : reclique sur 🛠️ Admin › 💸 Primes." });
}

module.exports = { ctx, open, handle, modal, lineOf, parseAmount, PRIMES_CHANNEL_ID };
