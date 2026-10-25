// ================== 👤 LA FICHE D'UN CHATTEUR ==================
// Sous le panneau du shift, la barre « 🔎 Modifs chatteurs » : on tape un nom, sa fiche s'ouvre, une fenêtre déjà
// remplie avec ce qu'il a ce jour-là : ses modèles, son ou ses shifts et son compte Discord (pas de box : elles se
// donnent shift par shift, ✏️ Modif par shift). Tout est enregistré d'un coup dans le planning de l'app, pour ce jour-là
// ou comme shift habituel.
// ➕ Ajouter un chatteur : la même fenêtre pour en créer un (Équipe dans l'app, et le planning déjà fait suit) ; elle
// s'ouvre aussi quand on cherche quelqu'un qui n'est pas encore dans l'app (son nom et son compte déjà remplis).
// Discord ne remplit pas une fenêtre déjà ouverte : le chatteur se choisit dans la barre, avant d'ouvrir sa fiche.
// Custom ids : cf_save~date~créneau~chatterId (sa fiche), cf_new~date~créneau (nouveau chatteur).
const { ModalBuilder, LabelBuilder, UserSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const appSync = require("./app-sync");
const planning = require("./planning");
const planEdit = require("./planedit");
const chatters = require("./chatters");
const { reply, done, EPHEMERAL } = require("./ui");
const { SLOTS, withEmoji, boxList, boxLabel, dayLabel } = planning;
const { tag, running, slotOf, midsOf } = planEdit.helpers;

const ctx = {}; // isAdmin(i), refresh(date)
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const label = (l, d) => (d ? new LabelBuilder().setLabel(l).setDescription(d) : new LabelBuilder().setLabel(l));
const shortDay = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const sameSet = (a, b) => [...(a || [])].sort().join() === [...(b || [])].sort().join();
const disabled = (i) =>
  !ctx.isAdmin(i) ? "⛔ Réservé aux admins." : !appSync.enabled() ? "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." : "";

// ---------- Les cases ----------
const acctsPick = (cat, chosen) => {
  const list = cat.accounts.slice(0, 25);
  return new StringSelectMenuBuilder().setCustomId("acc").setRequired(true).setMinValues(1).setMaxValues(Math.max(1, list.length))
    .addOptions(list.map((a) => ({ label: `${withEmoji(a.model)} · ${a.platform}`.slice(0, 100), value: a.key, default: chosen.includes(a.key) })));
};
const slotsPick = (chosen, min) =>
  new StringSelectMenuBuilder().setCustomId("slots").setRequired(min > 0).setMinValues(min).setMaxValues(2)
    .addOptions(SLOTS.map((s) => ({ label: `${s.l} · ${s.h}`, value: s.k, emoji: s.emoji, default: chosen.includes(s.k) })));
const userPick = (uid) => {
  const m = new UserSelectMenuBuilder().setCustomId("uid").setRequired(false).setMinValues(0).setMaxValues(1).setPlaceholder("🔎 Tape son nom");
  return uid ? m.setDefaultUsers(uid) : m;
};

// Le jour lu à temps pour ouvrir la fenêtre (Discord laisse 3 s), sinon le dernier lu
async function quickDay(date) {
  const d = await Promise.race([planEdit.actions.load(date).catch(() => null), new Promise((r) => setTimeout(() => r(null), 2000))]);
  return d || planEdit.actions.peek(date);
}

// ---------- Ouvrir ----------
// Sa fiche : ce qu'il a ce jour-là (le shift du panneau d'abord), sinon son shift habituel
async function openFiche(i, { date, slot, cid, uid }) {
  const no = disabled(i);
  if (no) return reply(i, { content: no });
  const d = await quickDay(date);
  const c = d?.byId[cid];
  if (!c) return reply(i, { content: d ? "⚠️ Ce chatteur n'est plus dans l'app." : "⏳ L'app répond lentement : réessaie dans un instant." });
  const mine = d.plan.filter((s) => s.chatterId === cid);
  const main = mine.find((s) => s.slot === slot) || mine[0];
  const accts = main ? [...(main.accts || [])] : [...(c.shift?.accts || [])];
  const slots = mine.length ? [...new Set(mine.map((s) => s.slot))] : [slot];
  const m = new ModalBuilder()
    .setCustomId(`cf_save~${date}~${slot}~${cid}`)
    .setTitle(`👤 ${c.name} · ${shortDay(date)}`.slice(0, 45))
    .addLabelComponents(
      label("Modèle(s)").setStringSelectMenuComponent(acctsPick(d.cat, accts)),
      label("Shift(s)", "Deux = double shift · aucun = retiré du planning de ce jour").setStringSelectMenuComponent(slotsPick(slots, 0)),
      label("Compte Discord", !c.discordId && uid ? "Pas encore relié : envoie pour relier ce compte" : undefined).setUserSelectMenuComponent(userPick(c.discordId || uid)),
      label("Pour un soir ou shift habituel ?").setStringSelectMenuComponent(
        new StringSelectMenuBuilder().setCustomId("keep").setRequired(true).setMinValues(1).setMaxValues(1).addOptions(
          { label: "Pour un soir", value: "day", emoji: "📅", description: `Seulement le ${dayLabel(date)}`.slice(0, 100), default: true },
          { label: "Shift habituel", value: "habit", emoji: "🔁", description: "Enregistré dans Équipe, le planning à venir suit" }
        )
      )
    );
  return i.showModal(m);
}
// 🔎 La barre de recherche : sa fiche ; s'il n'est relié à aucun chatteur, celui de l'app qui porte son nom (sa fiche,
// son compte prêt à relier), sinon la fiche d'un nouveau chatteur avec son nom et son compte déjà remplis
async function openFor(i, { date, slot, uid, user, member }) {
  const no = disabled(i);
  if (no) return reply(i, { content: no });
  const list = await Promise.race([appSync.appChatters().catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]);
  if (!list) return reply(i, { content: "⏳ L'app répond lentement : réessaie dans un instant." });
  const names = [member?.displayName, member?.nick, user?.globalName, user?.username].filter(Boolean);
  const c = list.find((x) => x.discordId === uid) || (await appSync.chatterOf(uid, names, false).catch(() => null));
  if (c) return openFiche(i, { date, slot, cid: c.id, uid });
  return openNew(i, { date, slot, uid, name: chatters.cleanName(names[0] || "") });
}
// ➕ Un nouveau chatteur : son nom, son compte, ses modèles et son shift habituels, ses box ce jour-là
async function openNew(i, { date, slot, uid, name: name0 }) {
  const no = disabled(i);
  if (no) return reply(i, { content: no });
  const cat = await Promise.race([appSync.appCatalog().catch(() => null), new Promise((r) => setTimeout(() => r(null), 2200))]);
  if (!cat) return reply(i, { content: "⏳ L'app répond lentement : réessaie dans un instant." });
  if (!cat.accounts.length) return reply(i, { content: "⚠️ Aucune modèle dans l'app." });
  const name = new TextInputBuilder().setCustomId("name").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60).setPlaceholder("Prénom ou pseudo, comme dans l'app");
  if (name0) name.setValue(name0);
  const m = new ModalBuilder()
    .setCustomId(`cf_new~${date}~${slot}`)
    .setTitle("➕ Nouveau chatteur")
    .addLabelComponents(
      label("Nom").setTextInputComponent(name),
      label("Compte Discord", "Pour qu'il puisse clock in").setUserSelectMenuComponent(userPick(uid)),
      label("Modèle(s)").setStringSelectMenuComponent(acctsPick(cat, [])),
      label("Shift habituel", "Deux = double shift ; le planning déjà fait suit").setStringSelectMenuComponent(slotsPick([slot], 1))
    );
  return i.showModal(m);
}

// ---------- Lire la fenêtre ----------
const field = (i, fn, id) => {
  try {
    return i.fields[fn](id);
  } catch {
    return null;
  }
};
const vals = (i, id) => field(i, "getStringSelectValues", id) || [];
const where = (slots) => slots.map((k) => `${slotOf(k).emoji} ${slotOf(k).l}`).join(" + ");
const whatOf = (d, mids, bx) => mids.map((m) => `**${(d.cat.models[m]?.name ? withEmoji(d.cat.models[m].name) : m).toLocaleUpperCase("fr")}**${bx?.[m]?.length ? ` · ${boxLabel(bx[m])}` : ""}`).join(" · ");

// ---------- Enregistrer sa fiche ----------
async function saveFiche(i, date, slot0, cid) {
  await i.deferReply({ flags: EPHEMERAL });
  const accts = vals(i, "acc").filter((x) => x.includes("|"));
  const slots = appSync.habSlots({ slots: vals(i, "slots") });
  const keep = (vals(i, "keep")[0] || "day") === "habit";
  const u = field(i, "getSelectedUsers", "uid")?.first?.();
  let d = await planEdit.actions.load(date);
  const c = d.byId[cid];
  if (!c) return done(i, "⚠️ Ce chatteur n'est plus dans l'app.", 60000);
  const mids = midsOf(accts);
  if (!accts.length && slots.length) return done(i, "⚠️ Rien n'est changé : choisis au moins une modèle.", 60000);
  if (slots.length && d.off.has(cid)) return done(i, `⛔ Rien n'est changé : ${tag(c)} est en day off ce ${dayLabel(date)}.`, 60000);
  if (u?.bot) return done(i, "⚠️ Rien n'est changé : choisis un chatteur, pas un bot.", 60000);
  const lines = [];
  // son compte Discord et son shift habituel : comme ➕ Nouveau chatteur / ✏️ Modifier (Équipe dans l'app)
  const uid = u && u.id !== c.discordId ? u.id : null;
  if (keep || uid) {
    if (u) chatters.ctx.remember?.(u, field(i, "getSelectedMembers", "uid")?.get?.(u.id));
    const orig = chatters.draftOf(c);
    const r = await chatters.save({ cid, orig, d: { ...orig, ...(uid ? { uid } : {}), ...(keep ? { slots, accts } : {}), apply: keep } });
    if (!r.ok) return done(i, r.note, 60000);
    if (uid) lines.push(`🔗 <@${uid}> relié à **${c.name}**.`);
    if (keep) lines.push(`🔁 Shift habituel enregistré (Équipe) : ${where(slots)} · ${whatOf(d, mids)}${r.days ? ` · 📅 planning à venir mis à jour (${r.days} jour${r.days > 1 ? "s" : ""})` : ""}.`);
    if (keep) d = await planEdit.actions.load(date);
  }
  // ce jour-là : ses shifts et ses modèles ; ses box restent (celles d'une modèle qu'il n'a plus partent), elles se
  // donnent shift par shift dans ✏️ Modif par shift
  const mine = d.plan.filter((s) => s.chatterId === cid);
  const main = slots.includes(slot0) ? slot0 : slots[0];
  const patch = {};
  const kept = new Set();
  for (const s of mine) {
    if (!slots.includes(s.slot) || kept.has(s.slot)) patch[s.sid] = null;
    else kept.add(s.slot);
  }
  for (const sl of slots) {
    const e = mine.find((s) => s.slot === sl && patch[s.sid] !== null);
    if (!e) {
      planEdit.addPatch(patch, appSync.newId(), { slot: sl, chatterId: cid, accts });
      continue;
    }
    const gone = midsOf(e.accts).filter((m) => !mids.includes(m) && e.boxes?.[m]);
    const p = {};
    if (!sameSet(e.accts, accts)) p.accts = accts;
    if (gone.length) p.boxes = Object.fromEntries(gone.map((m) => [m, null]));
    if (Object.keys(p).length) planEdit.addPatch(patch, e.sid, p);
  }
  const cur = mine.find((s) => s.slot === main && patch[s.sid] !== null);
  const shown = Object.fromEntries(mids.map((m) => [m, boxList(cur?.boxes?.[m])]));
  const touched = [...new Set([...slots, ...mine.map((s) => s.slot)])];
  const loud = touched.some((sl) => running(date, sl));
  if (Object.keys(patch).length) {
    await appSync.writePlan(date, patch, {}, { loud });
    ctx.refresh?.(date);
    lines.unshift(slots.length ? `✅ ${tag(c)} · ${where(slots)} · ${whatOf(d, mids, shown)} · ${dayLabel(date)}` : `➖ ${tag(c)} n'est plus au planning du ${dayLabel(date)}.`);
    if (loud) lines.push("📣 Annoncé dans le salon clocking.");
  } else if (!lines.length) lines.push(`Rien n'a changé pour ${tag(c)}.`);
  return done(i, lines.join("\n"), 60000);
}

// ---------- Enregistrer un nouveau chatteur ----------
async function saveNew(i) {
  await i.deferReply({ flags: EPHEMERAL });
  const name = chatters.cleanName(field(i, "getTextInputValue", "name"));
  const u = field(i, "getSelectedUsers", "uid")?.first?.();
  const accts = vals(i, "acc").filter((x) => x.includes("|"));
  const slots = appSync.habSlots({ slots: vals(i, "slots") });
  const cat = await appSync.appCatalog();
  const mids = midsOf(accts);
  const errors = [
    !name && "écris son nom.",
    u?.bot && "choisis un chatteur, pas un bot.",
    !accts.length && "choisis au moins une modèle.",
    !slots.length && "choisis son shift.",
  ].filter(Boolean);
  if (errors.length) return done(i, `⚠️ Rien n'est créé : ${errors.join(" ")}`, 60000);
  const linked = u && (await appSync.appChatters(true)).find((x) => x.discordId === u.id);
  if (linked) return done(i, `⚠️ Rien n'est créé : <@${u.id}> est déjà **${linked.name}** dans l'app. Cherche-le dans 🔎 Modifs chatteurs.`, 60000);
  if (u) chatters.ctx.remember?.(u, field(i, "getSelectedMembers", "uid")?.get?.(u.id));
  const orig = chatters.draftOf(null);
  const r = await chatters.save({ cid: null, orig, d: { ...orig, name, uid: u?.id || "", slots, accts, days: ALL_DAYS, apply: true } });
  if (r.exists && u && !r.exists.discordId) {
    // il était déjà dans l'app sans compte Discord : on relie juste ce compte
    await appSync.linkDiscord(u.id, r.exists.id);
    return done(i, `🔗 **${r.exists.name}** était déjà dans l'app : relié à <@${u.id}>. Le reste (shifts, modèles) se change dans sa fiche : 🔎 Modifs chatteurs.`, 60000);
  }
  if (r.exists) return done(i, `⚠️ Rien n'est créé : **${r.exists.name}** existe déjà dans l'app. Cherche-le dans 🔎 Modifs chatteurs${r.exists.discordId ? "" : " (👤 Pas sur Discord)"}.`, 60000);
  if (!r.ok) return done(i, r.note, 60000);
  return done(i, `➕ **${name}** créé dans l'app (Équipe) : ${where(slots)} · ${whatOf({ cat }, mids)}${u ? ` · relié à <@${u.id}>` : " · pas relié à Discord"}${r.days ? ` · 📅 planning déjà fait mis à jour (${r.days} jour${r.days > 1 ? "s" : ""})` : ""}.\n-# Ses box se donnent shift par shift : ✏️ Modif par shift.`, 60000);
}

async function handle(i) {
  const [id, date, slot, cid] = i.customId.split("~");
  const no = disabled(i);
  if (no) return reply(i, { content: no });
  if (id === "cf_save" && cid) return saveFiche(i, date, slot, cid);
  if (id === "cf_new") return saveNew(i);
  return reply(i, { content: "Cette fenêtre a expiré." });
}

module.exports = { ctx, handle, openFiche, openNew, openFor };
