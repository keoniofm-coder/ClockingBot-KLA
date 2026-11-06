// ================== 🔄 RÉATTRIBUTION DE VENTES ==================
// 🛠️ Admin › 🔄 Réatrib/Ventes ouvre une petite fiche : le chatteur qui a la vente (dans Whysper), celui à qui la
// donner, le montant, le fan (acheteur) et le jour de la vente. Elle est gardée dans l'app (reattrib/<id>, en attente)
// et annoncée dans le salon réatrib :
//   « Ventes de @Samuel | Montant : **100 €** » puis « Réatribuer à @Moise » et « -# Fan : Jean · vente du 2 nov. · ⏳ »
// Au prochain import Whysper, l'app retrouve la ou les ventes (fan, vendeur, montant, jour), les passe au bon chatteur
// et le dit dans l'aperçu ; le bot voit qu'elle est faite et met « ✅ Fait dans l'app » sous le message.
// 🗑️ sous chaque réattribution (admins) : l'annuler (le message reste, barré).
const { UserSelectMenuBuilder, StringSelectMenuBuilder, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const wysper = require("./wysper");
const { money, workDay } = require("./penalties");
const { parseAmount } = require("./primes");
const { reply, done, showView, row, button, EPHEMERAL } = require("./ui");

const REATTRIB_CHANNEL_ID = (process.env.REATTRIB_CHANNEL_ID ?? "1557008074491826237").trim();
// Fourni par index.js : isAdmin(i), client, nameOf(uid)
const ctx = {};

const dayShort = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const curOf = (r) => (r?.currency === "USD" ? "USD" : "EUR");
const who = (uid, name) => (uid ? `<@${uid}>` : `**${name || "?"}**`);

// Le message du salon ; la dernière ligne dit où elle en est dans l'app
function statusTxt(r) {
  if (r.status === "applied") {
    const n = r.sales?.length || 0;
    const how = r.appliedBy === "wysper" ? " (vente retrouvée dans Wysper)" : r.appliedFile ? ` (import du ${dayShort(r.appliedFile)})` : "";
    return `✅ Fait dans l'app${how}${n > 1 ? ` · ${n} ventes` : ""}`;
  }
  return wysper.enabled() ? "⏳ En attente de la vente dans Wysper" : "⏳ En attente du prochain import Whysper";
}
const lineOf = (r) =>
  [
    `Ventes de ${who(r.fromUid, r.fromName)} | Montant : **${money(r.amount, curOf(r))}**`,
    `Réatribuer à ${who(r.toUid, r.toName)}`,
    `-# 👤 Fan : ${r.fan} · vente du ${dayShort(r.date)} · ${statusTxt(r)}`,
  ].join("\n");
const rmRow = (r) => row(new ButtonBuilder().setCustomId(`ra_rm~${r.id}`).setEmoji("🗑️").setStyle(ButtonStyle.Secondary));

// ---------- La petite fiche ----------
const label = (l, d) => (d ? new LabelBuilder().setLabel(l).setDescription(d) : new LabelBuilder().setLabel(l));
const text = (id, placeholder, max) => new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(max).setPlaceholder(placeholder);
const users = (id, ph) => new UserSelectMenuBuilder().setCustomId(id).setRequired(true).setMinValues(1).setMaxValues(1).setPlaceholder(ph);
function modal() {
  const d0 = workDay();
  const days = [0, 1, 2].map((k) => appSync.addDays(d0, -k));
  const names = ["Aujourd'hui", "Hier", "Avant-hier"];
  return new ModalBuilder().setCustomId("ra_new").setTitle("🔄 Réatrib / Ventes").addLabelComponents(
    label("Vendu par", "Le chatteur qui a la vente dans Whysper").setUserSelectMenuComponent(users("from", "🔎 Tape son nom")),
    label("À réattribuer à", "Celui qui doit avoir la vente").setUserSelectMenuComponent(users("to", "🔎 Tape son nom")),
    label("Montant", "En euros, comme dans Whysper (ex : 100). Plusieurs ventes au même fan : le total").setTextInputComponent(text("amount", "ex : 100", 10)),
    label("Fan / acheteur", "Son nom comme dans Whysper").setTextInputComponent(text("fan", "ex : Jean", 80)),
    label("Jour de la vente", "Jour de shift : avant 2 h du matin, c'est encore la veille").setStringSelectMenuComponent(
      new StringSelectMenuBuilder().setCustomId("day").setRequired(true).setMinValues(1).setMaxValues(1).addOptions(
        days.map((d, k) => ({ label: `${names[k]} · ${dayShort(d)}`, value: d, emoji: "📅", default: k === 0 }))
      )
    )
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

// La fiche envoyée : la réattribution part dans le salon réatrib et attend l'import dans l'app
async function submit(i) {
  const from = field(i, "getSelectedUsers", "from")?.first?.();
  const to = field(i, "getSelectedUsers", "to")?.first?.();
  const amount = parseAmount(field(i, "getTextInputValue", "amount"));
  const fan = String(field(i, "getTextInputValue", "fan") || "").replace(/\s+/g, " ").trim();
  const date = (field(i, "getStringSelectValues", "day") || [])[0] || workDay();
  await i.deferReply({ flags: EPHEMERAL });
  const errors = [
    !(from && to) && "choisis les deux chatteurs.",
    (from?.bot || to?.bot) && "choisis des chatteurs, pas un bot.",
    from && to && from.id === to.id && "les deux chatteurs sont le même.",
    !(Number.isFinite(amount) && amount > 0 && amount <= 100000) && "écris le montant (ex : 100).",
    !fan && "écris le nom du fan.",
  ].filter(Boolean);
  if (errors.length) return done(i, `⚠️ Rien n'est envoyé : ${errors.join(" ")}`, 30000);
  const of = (u) => appSync.chatterOf(u.id, [ctx.nameOf?.(u.id)].filter(Boolean), false).catch(() => null);
  const [fc, tc] = await Promise.all([of(from), of(to)]);
  const r = {
    id: `${date.slice(0, 7)}-${appSync.newId()}`, month: date.slice(0, 7), date, at: Date.now(), by: i.user.id,
    fromUid: from.id, fromId: fc?.id || null, fromName: fc?.name || ctx.nameOf?.(from.id) || from.username,
    toUid: to.id, toId: tc?.id || null, toName: tc?.name || ctx.nameOf?.(to.id) || to.username,
    amount, currency: "EUR", fan, status: "pending",
  };
  let where = "";
  try {
    const ch = await ctx.client.channels.fetch(REATTRIB_CHANNEL_ID);
    const msg = await ch.send({ content: lineOf(r), components: [rmRow(r)], allowedMentions: { users: [r.fromUid, r.toUid] } });
    r.msg = { channelId: ch.id, id: msg.id };
    where = ` dans <#${ch.id}>`;
  } catch (e) {
    console.error("Réatrib (salon) :", e.message);
    where = ` ⚠️ Message pas envoyé dans le salon réatrib : ${String(e.message).slice(0, 150)}`;
  }
  await appSync.addReattrib(r);
  const miss = [!fc && r.fromName, !tc && r.toName].filter(Boolean);
  return showView(i, {
    content: [
      `✅ Envoyé${where} : ventes de <@${r.fromUid}> → <@${r.toUid}> · **${money(amount, "EUR")}** · fan ${fan} (${dayShort(date)})`,
      wysper.enabled()
        ? "-# Le bot la fait tout seul dès que la vente est retrouvée dans Wysper (en général dans la minute)."
        : "-# L'app la fera toute seule au prochain import Whysper (et te le dira dans l'aperçu).",
      miss.length ? `-# ⚠️ Pas relié à un chatteur de l'app : ${miss.join(", ")}. Relie son compte Discord dans sa fiche, sinon l'app cherchera par son nom.` : "",
    ].filter(Boolean).join("\n"),
    components: [row(button("ra_add", "Nouvelle réatrib", "🔄", ButtonStyle.Primary))],
  });
}

// Annule une réattribution (retirée de l'app) ; déjà faite, la vente reste où l'import l'a mise
async function cancel(r, by) {
  await appSync.delReattrib(r.id);
  if (r.msg)
    await ctx.client.channels
      .fetch(r.msg.channelId)
      .then((ch) => ch.messages.edit(r.msg.id, { content: `${lineOf(r).split("\n").map((l) => `~~${l}~~`).join("\n")}\n-# Annulée par <@${by}>`, components: [], allowedMentions: { parse: [] } }))
      .catch((e) => console.warn("Réatrib annulée (message) :", e.message));
  return r.status === "applied"
    ? `🗑️ Annulée. ⚠️ L'app l'avait déjà faite : la vente reste chez ${who(r.toUid, r.toName)}, change-la à la main dans Ventes/Import si besoin.`
    : `🗑️ Annulée : l'app ne la fera pas à l'import.`;
}
const byId = async (id) => (await appSync.reattribsIn(id.slice(0, 7))).find((x) => x.id === id);
async function rmAsk(i, rid) {
  await i.deferReply({ flags: EPHEMERAL });
  const r = await byId(rid);
  if (!r) return done(i, "Cette réattribution est déjà annulée.", 8000);
  return showView(i, {
    content: `🗑️ Annuler : ventes de ${who(r.fromUid, r.fromName)} → ${who(r.toUid, r.toName)} · **${money(r.amount, curOf(r))}** · fan ${r.fan} ?${r.status === "applied" ? "\n-# ⚠️ Déjà faite dans l'app : la vente ne revient pas toute seule." : ""}`,
    components: [row(button(`ra_rmok~${r.id}`, "Oui, annuler", "🗑️", ButtonStyle.Danger), button("ra_rmno", "Non", null, ButtonStyle.Secondary))],
    allowedMentions: { parse: [] },
  });
}

// Les réattributions que l'app vient de faire : « ✅ Fait dans l'app » sous leur message (toutes les 2 min)
async function syncApplied() {
  if (!appSync.enabled() || !ctx.client) return 0;
  let n = 0;
  for (const r of await appSync.reattribsToShow()) {
    if (r.msg) {
      const ch = await ctx.client.channels.fetch(r.msg.channelId).catch(() => null);
      await ch?.messages.edit(r.msg.id, { content: lineOf(r), allowedMentions: { parse: [] } }).catch((e) => console.warn("Réatrib (message) :", e.message));
    }
    await appSync.markReattribShown(r.id);
    n++;
  }
  return n;
}

// ---------- Interactions ra_… ----------
async function handle(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const id = i.customId;
  if (id === "ra_new") return submit(i);
  if (id === "ra_add") return i.showModal(modal());
  if (id.startsWith("ra_rm~")) return rmAsk(i, id.slice(6));
  if (id === "ra_rmno") return done(i, "D'accord, rien n'est annulé.", 4000);
  if (id.startsWith("ra_rmok~")) {
    await i.deferUpdate();
    const r = await byId(id.slice(8));
    return done(i, r ? await cancel(r, i.user.id) : "Cette réattribution est déjà annulée.", 15000);
  }
  return reply(i, { content: "Ce bouton a expiré : reclique sur 🛠️ Admin › 🔄 Réatrib/Ventes." });
}

module.exports = { ctx, open, handle, modal, lineOf, syncApplied, REATTRIB_CHANNEL_ID };
