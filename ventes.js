// ================== 💰 VENTES TAPÉES À LA MAIN ==================
// Pour les plateformes sans import ni Wysper (Twizz, Uncove…) : 🛠️ Admin › 💰 Ventes ouvre une petite fiche
// (le chatteur qui a vendu, la modèle et la plateforme, le montant, net ou brut, le jour) et la vente s'ajoute
// tout de suite dans l'app, sur la ligne de ce chatteur dans Ventes/Import (jour, shift, modèle, plateforme),
// comme si elle était tapée là ; Paies, Tableau de bord et Revenu perso suivent.
// Le shift est celui où il travaillait ce jour-là (planning, sinon son shift habituel).
// Une ligne déjà là garde sa façon de compter : une vente en brut sur une ligne en net est convertie avec les
// frais de la plateforme (et l'inverse). ↩️ sous la confirmation retire la vente si tu t'es trompé.
const { UserSelectMenuBuilder, StringSelectMenuBuilder, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const { money, workDay } = require("./penalties");
const { parseAmount } = require("./primes");
const { reply, done, showView, row, button, EPHEMERAL } = require("./ui");

// Fourni par index.js : isAdmin(i), client, nameOf(uid)
const ctx = {};

const num = (v) => Number(v) || 0;
const r2 = (v) => Math.round(v * 100) / 100;
const ekey = (slot, c, m, p) => `${slot || "x"}_${c}_${m}_${p}`; // même clé que l'app
const SLOT_L = { nuit: "Nuit", matin: "Matin", aprem: "Aprem", soir: "Soir" };
const DAY_ORDER = ["nuit", "matin", "aprem", "soir"]; // dans une journée de l'app (la nuit commence à 2 h)
const slotOfHour = (h) => (h < 2 ? "soir" : h < 8 ? "nuit" : h < 14 ? "matin" : h < 20 ? "aprem" : "soir");
const dayShort = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
// plateformes qui arrivent par import ou par Wysper : pas ici (comme « manualPlat » dans l'app)
const CRM = [/only ?fans|^of$/i, /telegram|^tg$/i];
const manual = (name) => !CRM.some((re) => re.test(String(name || "")));

// ---------- La petite fiche ----------
const label = (l, d) => (d ? new LabelBuilder().setLabel(l).setDescription(d) : new LabelBuilder().setLabel(l));
const select = (id, options) => new StringSelectMenuBuilder().setCustomId(id).setRequired(true).setMinValues(1).setMaxValues(1).addOptions(options);
async function accounts() {
  const cat = await appSync.appCatalog();
  return cat.accounts.filter((a) => manual(a.platform)).slice(0, 25).map((a) => ({ ...a, net: cat.platforms[a.pid]?.input === "net" }));
}
async function modal() {
  const accts = await accounts();
  if (!accts.length) return null;
  const d0 = workDay();
  const days = [0, 1, 2].map((k) => appSync.addDays(d0, -k));
  const names = ["Aujourd'hui", "Hier", "Avant-hier"];
  return new ModalBuilder().setCustomId("vt_new").setTitle("💰 Ventes").addLabelComponents(
    label("Vendu par", "Le chatteur qui a fait la vente").setUserSelectMenuComponent(
      new UserSelectMenuBuilder().setCustomId("who").setRequired(true).setMinValues(1).setMaxValues(1).setPlaceholder("🔎 Tape son nom")
    ),
    label("Modèle et plateforme").setStringSelectMenuComponent(
      select("acct", accts.map((a) => ({ label: `${a.model} · ${a.platform}`.slice(0, 100), value: a.key, ...(a.net ? { description: "Tapée en net dans l'app" } : {}) }))).setPlaceholder("Choisis le compte")
    ),
    label("Montant", "Ex : 45 ou 45,50 (en € ; en $ pour un compte en dollars)").setTextInputComponent(
      new TextInputBuilder().setCustomId("amount").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12).setPlaceholder("ex : 45,50")
    ),
    label("Net ou brut").setStringSelectMenuComponent(
      select("inp", [
        { label: "Net", value: "net", description: "Ce que la plateforme verse, après ses frais", emoji: "💶" },
        { label: "Brut", value: "gross", description: "Le prix payé par le fan, avant les frais", emoji: "🧾" },
      ]).setPlaceholder("Le montant est en net ou en brut ?")
    ),
    label("Jour", "Jour de shift : avant 2 h du matin, c'est encore la veille").setStringSelectMenuComponent(
      select("day", days.map((d, k) => ({ label: `${names[k]} · ${dayShort(d)}`, value: d, emoji: "📅", default: k === 0 })))
    )
  );
}
async function open(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  if (!appSync.enabled()) return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  const m = await modal().catch((e) => (console.error("Ventes (fiche) :", e.message), null));
  if (!m) return reply(i, { content: "⚠️ Aucun compte Twizz, Uncove… dans l'app : ajoute la plateforme à la modèle dans Équipe." });
  return i.showModal(m);
}
const field = (i, fn, id) => {
  try {
    return i.fields[fn](id);
  } catch {
    return null;
  }
};

// Le shift de la vente : prévu au planning ce jour-là (aujourd'hui : celui en cours ou le dernier commencé),
// sinon son shift habituel, sinon l'heure qu'il est (aujourd'hui) ou « hors planning » (un autre jour)
async function slotFor(c, date, t = Date.now(), acct = null) {
  const today = date === workDay(t);
  const started = (s) => appSync.parisMs(date, appSync.START_OF[s]) <= t;
  const pick = (l) => {
    const s = [...new Set(l)].filter((k) => DAY_ORDER.includes(k)).sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
    if (!s.length) return null;
    if (!today || s.length === 1) return s[0];
    return s.filter(started).at(-1) || s[0];
  };
  if (today) {
    const hit = await appSync.plannedSlotAt(c.discordId, [], t).catch(() => null);
    if (hit?.date === date) return { slot: hit.slot, how: "plan" };
  }
  const planned = pick((await appSync.planOf(date).catch(() => [])).filter((s) => s.chatterId === c.id).map((s) => s.slot));
  if (planned) return { slot: planned, how: "plan" };
  // pas au planning ce jour-là mais déjà une ligne pour ce compte (tapée dans l'app ou vente d'avant) : on la complète
  if (acct) {
    const day = await appSync.getDoc("days", date).catch(() => null);
    const had = pick(Object.values(day?.entries || {}).filter((e) => e && e.chatterId === c.id && e.modelId === acct.mid && e.platformId === acct.pid).map((e) => e.slot || ""));
    if (had) return { slot: had, how: "line" };
  }
  const hab = pick(appSync.habSlots(c.shift));
  if (hab) return { slot: hab, how: "habit" };
  return today ? { slot: slotOfHour(appSync.parisParts(t).h), how: "hour" } : { slot: "", how: "none" };
}

// Ajoute la vente sur sa ligne de l'app (jour, shift, chatteur, modèle, plateforme)
async function addSale({ c, mid, pid, amount, inp, date, slot }) {
  const cat = await appSync.appCatalog();
  const plat = cat.platforms[pid] || {};
  const [day, cdoc] = await Promise.all([appSync.getDoc("days", date), appSync.getDoc("chatters", c.id).catch(() => null)]);
  const key = ekey(slot, c.id, mid, pid);
  const prev = day?.entries?.[key] || null;
  const fee = num(prev?.fee ?? plat.fee ?? 20);
  const k = fee > 0 && fee < 100 ? 1 - fee / 100 : 1;
  // la ligne garde sa façon de compter (net ou brut) : le montant est converti avec les frais si besoin
  const lineNet = prev ? prev.inp === "net" : inp === "net";
  const add = r2(lineNet === (inp === "net") ? amount : lineNet ? amount * k : amount / k);
  const e = prev
    ? { ...prev, sales: r2(num(prev.sales) + add), at: Date.now() }
    : {
        slot, chatterId: c.id, modelId: mid, platformId: pid, sales: add, tips: 0,
        rate: num(cdoc?.rate ?? 10), fee: num(plat.fee ?? 20), cur: plat.currency === "USD" ? "USD" : "EUR", at: Date.now(),
        ...(inp === "net" ? { inp: "net" } : {}),
      };
  // ligne importée corrigée : l'ajout va dans sa part « adj », comme une correction tapée dans l'app
  if (prev?.parts) e.parts = { ...prev.parts, adj: [r2(num(prev.parts.adj?.[0]) + add), num(prev.parts.adj?.[1])] };
  await appSync.mergeDoc("days", date, { entries: { [key]: e } }, { date, entries: {} });
  return { key, prev, e, add, lineNet, fee, plat };
}
// ↩️ Annuler cette vente : on retire ce qui a été ajouté (la ligne disparaît si elle n'existait pas avant)
const undos = new Map(); // jeton -> { date, key, add, created, at }
async function undo(u) {
  const day = await appSync.getDoc("days", u.date);
  const e = day?.entries?.[u.key];
  if (!e) return "Cette ligne n'existe plus dans l'app : rien à retirer.";
  const sales = r2(num(e.sales) - u.add);
  const gone = u.created && sales <= 0.004 && !num(e.tips);
  const ne = gone ? null : { ...e, sales: Math.max(0, sales), at: Date.now() };
  if (ne && e.parts) ne.parts = { ...e.parts, adj: [r2(num(e.parts.adj?.[0]) - u.add), num(e.parts.adj?.[1])] };
  await appSync.mergeDoc("days", u.date, { entries: { [u.key]: ne } }, { date: u.date, entries: {} });
  return gone ? "↩️ Vente retirée : la ligne n'est plus dans l'app." : `↩️ Vente retirée : la ligne est revenue à ${money(ne.sales, e.cur === "USD" ? "USD" : "EUR")}${e.inp === "net" ? " net" : ""}.`;
}

// La fiche envoyée : la vente part dans l'app
async function submit(i) {
  const who = field(i, "getSelectedUsers", "who")?.first?.();
  const acct = (field(i, "getStringSelectValues", "acct") || [])[0] || "";
  const inp = (field(i, "getStringSelectValues", "inp") || [])[0] === "net" ? "net" : (field(i, "getStringSelectValues", "inp") || [])[0] === "gross" ? "gross" : "";
  const amount = parseAmount(field(i, "getTextInputValue", "amount"));
  const pickedDay = (field(i, "getStringSelectValues", "day") || [])[0];
  const date = /^\d{4}-\d{2}-\d{2}$/.test(pickedDay || "") ? pickedDay : workDay();
  await i.deferReply({ flags: EPHEMERAL });
  const [mid, pid] = acct.split("|");
  const errors = [
    !who && "choisis le chatteur.",
    who?.bot && "choisis un chatteur, pas un bot.",
    !(mid && pid) && "choisis la modèle et la plateforme.",
    !inp && "dis si le montant est en net ou en brut.",
    !(Number.isFinite(amount) && amount > 0 && amount <= 100000) && "écris le montant (ex : 45,50).",
  ].filter(Boolean);
  if (errors.length) return done(i, `⚠️ Rien n'est ajouté : ${errors.join(" ")}`, 30000);
  const c = await appSync.chatterOf(who.id, [ctx.nameOf?.(who.id)].filter(Boolean), false).catch(() => null);
  if (!c)
    return done(i, `⚠️ Rien n'est ajouté : <@${who.id}> n'est relié à aucun chatteur de l'app. Relie son compte Discord dans sa fiche (👤 sous le panneau, ou Équipe › Comptes Discord dans l'app).`, 30000);
  const { slot, how } = await slotFor(c, date, Date.now(), { mid, pid });
  const r = await addSale({ c, mid, pid, amount, inp, date, slot });
  const cat = await appSync.appCatalog();
  const acc = cat.accounts.find((a) => a.key === acct);
  const cur = r.e.cur === "USD" ? "USD" : "EUR";
  const mode = (net) => (net ? "net" : "brut");
  const tok = appSync.newId();
  undos.set(tok, { date, key: r.key, add: r.add, created: !r.prev, at: Date.now() });
  for (const [k, u] of undos) if (Date.now() - u.at > 24 * 3600e3) undos.delete(k);
  const where = slot ? `${SLOT_L[slot]} du ${dayShort(date)}` : `hors planning, ${dayShort(date)}`;
  return showView(i, {
    content: [
      `✅ Vente ajoutée dans l'app : <@${who.id}> · ${acc ? `${acc.model} · ${acc.platform}` : acct} · **${money(amount, cur)} ${mode(inp === "net")}** · ${where}`,
      r.add !== amount || r.lineNet !== (inp === "net")
        ? `-# Sa ligne est comptée en ${mode(r.lineNet)} : ajouté ${money(r.add, cur)} ${mode(r.lineNet)} (frais ${acc?.platform || "de la plateforme"} ${r.fee} %).`
        : "",
      `-# Ventes/Import › ${dayShort(date)} : sa ligne ${acc ? `${acc.model} · ${acc.platform} ` : ""}${slot ? `(${SLOT_L[slot]}) ` : ""}est à **${money(r.e.sales, cur)} ${mode(r.lineNet)}**${r.prev ? "" : " (nouvelle ligne)"}.`,
      how === "habit" ? `-# Pas au planning ce jour-là : rangée sur son shift habituel. Tu peux la déplacer dans l'app.` : "",
      how === "hour" ? `-# Pas au planning aujourd'hui : rangée sur le shift en cours. Tu peux la déplacer dans l'app.` : "",
      how === "none" ? `-# Pas au planning ce jour-là : rangée en « hors planning ». Tu peux la déplacer dans l'app.` : "",
    ].filter(Boolean).join("\n").replace(/ {2,}/g, " "),
    components: [row(button("vt_add", "Nouvelle vente", "💰", ButtonStyle.Success), button(`vt_undo~${tok}`, "Annuler cette vente", "↩️", ButtonStyle.Secondary))],
    allowedMentions: { parse: [] },
  });
}

// ---------- Interactions vt_… ----------
async function handle(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const id = i.customId;
  if (id === "vt_new") return submit(i);
  if (id === "vt_add") return open(i);
  if (id.startsWith("vt_undo~")) {
    const u = undos.get(id.slice(8));
    if (!u) return done(i, "Trop tard pour l'annuler d'ici : corrige le montant dans l'app (Ventes/Import).", 12000);
    await i.deferUpdate();
    undos.delete(id.slice(8));
    return done(i, await undo(u).catch((e) => `⚠️ Pas retirée : ${String(e.message).slice(0, 150)}. Corrige-la dans l'app.`), 15000);
  }
  return reply(i, { content: "Ce bouton a expiré : reclique sur 🛠️ Admin › 💰 Ventes." });
}

module.exports = { ctx, open, handle, modal, slotFor, addSale, undo };
