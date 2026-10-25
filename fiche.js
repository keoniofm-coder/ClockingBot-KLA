// ================== 👤 LA FICHE D'UN CHATTEUR ==================
// Sous le panneau du shift, le menu « 👤 Chatteur » : choisir un chatteur ouvre sa fiche, une fenêtre déjà remplie
// avec ce qu'il a ce jour-là : ses modèles, ses box, son ou ses shifts et son compte Discord. On change ce qu'on veut,
// tout est enregistré d'un coup dans le planning de l'app (et dans son shift habituel si on le demande).
// ➕ Ajouter un chatteur : la même fenêtre pour en créer un (Équipe dans l'app, et le planning déjà fait suit).
// Discord ne remplit pas une fenêtre déjà ouverte : le chatteur se choisit dans le menu, avant d'ouvrir sa fiche.
// Custom ids : cf_save~date~créneau~chatterId (sa fiche), cf_new~date~créneau (nouveau chatteur).
const { ModalBuilder, LabelBuilder, UserSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const appSync = require("./app-sync");
const planning = require("./planning");
const planEdit = require("./planedit");
const chatters = require("./chatters");
const { parseLine } = require("./shiftmodal");
const { boxesOf } = require("./quickmodal");
const { reply, done, EPHEMERAL } = require("./ui");
const { SLOTS, withEmoji, boxList, boxLabel, dayLabel } = planning;
const { tag, running, slotOf, midsOf } = planEdit.helpers;

const ctx = {}; // isAdmin(i), refresh(date)
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const label = (l, d) => (d ? new LabelBuilder().setLabel(l).setDescription(d) : new LabelBuilder().setLabel(l));
const shortDay = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sameSet = (a, b) => [...(a || [])].sort().join() === [...(b || [])].sort().join();
const boxText = (l) => (l.includes("all") ? "all" : l.join(" "));
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
const boxInput = (value) => {
  const t = new TextInputBuilder().setCustomId("box").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(200).setPlaceholder("ex : 1 2");
  return value ? t.setValue(value) : t;
};

// Le jour lu à temps pour ouvrir la fenêtre (Discord laisse 3 s), sinon le dernier lu
async function quickDay(date) {
  const d = await Promise.race([planEdit.actions.load(date).catch(() => null), new Promise((r) => setTimeout(() => r(null), 2000))]);
  return d || planEdit.actions.peek(date);
}

// ---------- Ouvrir ----------
// Sa fiche : ce qu'il a ce jour-là (le shift du panneau d'abord), sinon son shift habituel
async function openFiche(i, { date, slot, cid }) {
  const no = disabled(i);
  if (no) return reply(i, { content: no });
  const d = await quickDay(date);
  const c = d?.byId[cid];
  if (!c) return reply(i, { content: d ? "⚠️ Ce chatteur n'est plus dans l'app." : "⏳ L'app répond lentement : réessaie dans un instant." });
  const mine = d.plan.filter((s) => s.chatterId === cid);
  const main = mine.find((s) => s.slot === slot) || mine[0];
  const accts = main ? [...(main.accts || [])] : [...(c.shift?.accts || [])];
  const mids = midsOf(accts);
  const bx = (m) => boxList(main?.boxes?.[m]);
  const boxes = mids.length === 1 ? boxText(bx(mids[0])) : mids.filter((m) => bx(m).length).map((m) => `${d.cat.models[m]?.name || m} ${boxText(bx(m))}`).join("\n");
  const slots = mine.length ? [...new Set(mine.map((s) => s.slot))] : [slot];
  const m = new ModalBuilder()
    .setCustomId(`cf_save~${date}~${slot}~${cid}`)
    .setTitle(`👤 ${c.name} · ${shortDay(date)}`.slice(0, 45))
    .addLabelComponents(
      label("Modèle(s)").setStringSelectMenuComponent(acctsPick(d.cat, accts)),
      label("Box", "1 2 · all · vide = aucune · deux modèles : une ligne chacune (Anna 1 2)").setTextInputComponent(boxInput(boxes)),
      label(`Shift(s) ce ${dayLabel(date)}`.slice(0, 45), "Deux = double shift · aucun = retiré du planning de ce jour").setStringSelectMenuComponent(slotsPick(slots, 0)),
      label("Compte Discord").setUserSelectMenuComponent(userPick(c.discordId)),
      label("Aussi les jours suivants ?").setStringSelectMenuComponent(
        new StringSelectMenuBuilder().setCustomId("keep").setRequired(true).setMinValues(1).setMaxValues(1).addOptions(
          { label: "Non, seulement ce jour-là", value: "day", emoji: "📅", default: true },
          { label: "Oui : c'est son shift habituel", value: "habit", emoji: "🔁", description: "Modèles et shifts enregistrés dans Équipe, le planning à venir suit" }
        )
      )
    );
  return i.showModal(m);
}
// ➕ Un nouveau chatteur : son nom, son compte, ses modèles et son shift habituels, ses box ce jour-là
async function openNew(i, { date, slot }) {
  const no = disabled(i);
  if (no) return reply(i, { content: no });
  const cat = await Promise.race([appSync.appCatalog().catch(() => null), new Promise((r) => setTimeout(() => r(null), 2200))]);
  if (!cat) return reply(i, { content: "⏳ L'app répond lentement : réessaie dans un instant." });
  if (!cat.accounts.length) return reply(i, { content: "⚠️ Aucune modèle dans l'app." });
  const name = new TextInputBuilder().setCustomId("name").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60).setPlaceholder("Prénom ou pseudo, comme dans l'app");
  const m = new ModalBuilder()
    .setCustomId(`cf_new~${date}~${slot}`)
    .setTitle("➕ Nouveau chatteur")
    .addLabelComponents(
      label("Nom").setTextInputComponent(name),
      label("Compte Discord", "Pour qu'il puisse clock in").setUserSelectMenuComponent(userPick()),
      label("Modèle(s)").setStringSelectMenuComponent(acctsPick(cat, [])),
      label("Shift habituel", "Deux = double shift ; le planning déjà fait suit").setStringSelectMenuComponent(slotsPick([slot], 1)),
      label(`Box ce ${dayLabel(date)}`.slice(0, 45), "S'il travaille ce shift-là : 1 2 · all · vide = aucune").setTextInputComponent(boxInput())
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
// Box écrites pour ses modèles : « 1 2 » (une modèle) ou une ligne par modèle « Anna 1 2 » ; vide = aucune
// -> { mid: [box] } ou { error }
function boxesFor(text, mids, mName) {
  const out = Object.fromEntries(mids.map((m) => [m, []]));
  const lines = String(text || "").split(/\n|\/|;/).map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    const plain = boxesOf(line);
    if (!plain?.error) {
      if (mids.length !== 1) return { error: `« ${line} » : écris la modèle devant ses box (ex : ${mName(mids[0]) || "Anna"} 1 2).` };
      out[mids[0]] = plain || [];
      continue;
    }
    const { name, boxes } = parseLine(line);
    const n = norm(name);
    const mid = n && mids.find((m) => norm(mName(m)).startsWith(n));
    if (!mid) return { error: `« ${line} » : ${name || "?"} n'est pas une de ses modèles (${mids.map(mName).join(", ")}).` };
    const b = boxesOf(boxes.join(" ") || "0");
    if (b?.error) return { error: `« ${line} » : écris des numéros de 1 à 15, all, ou 0 pour aucune.` };
    out[mid] = b || [];
  }
  return { boxes: out };
}
const modelName = (cat) => (m) => cat.models[m]?.name || m;

// Ses box sur un shift : retirées à ceux du même shift et de la même modèle qui les avaient ; nombre de box du
// shift monté si on écrit une box au-delà
function putBoxes(d, slot, sid, e, bx, patch, nbox) {
  const taken = [];
  const boxes = {};
  for (const [m, l] of Object.entries(bx)) {
    if (l.join() === boxList(e?.boxes?.[m]).join()) continue;
    boxes[m] = l.length ? l : null;
    if (l.length) taken.push(...planEdit.takeBoxes(d, slot, m, l, [sid], patch));
    const top = Math.max(0, ...l.filter((b) => b !== "all").map(Number));
    if (top > (Number(d.nbox?.[`${slot}|${m}`]) || 0)) nbox[`${slot}|${m}`] = top;
  }
  return { boxes, taken };
}
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
  const bx = boxesFor(field(i, "getTextInputValue", "box"), mids, modelName(d.cat));
  if (bx.error) return done(i, `⚠️ Rien n'est changé : ${bx.error}`, 60000);
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
  // ce jour-là : ses shifts, ses modèles, ses box (sur le shift du panneau, sinon son premier shift)
  const mine = d.plan.filter((s) => s.chatterId === cid);
  const main = slots.includes(slot0) ? slot0 : slots[0];
  const patch = {}, nbox = {}, taken = [];
  const kept = new Set();
  for (const s of mine) {
    if (!slots.includes(s.slot) || kept.has(s.slot)) patch[s.sid] = null;
    else kept.add(s.slot);
  }
  for (const sl of slots) {
    const e = mine.find((s) => s.slot === sl && patch[s.sid] !== null);
    const sid = e?.sid || appSync.newId();
    const gone = e ? midsOf(e.accts).filter((m) => !mids.includes(m) && e.boxes?.[m]) : [];
    const r = sl === main ? putBoxes(d, sl, sid, e, bx.boxes, patch, nbox) : { boxes: {}, taken: [] };
    taken.push(...r.taken);
    const boxes = { ...Object.fromEntries(gone.map((m) => [m, null])), ...r.boxes };
    if (e) {
      const p = {};
      if (!sameSet(e.accts, accts)) p.accts = accts;
      if (Object.keys(boxes).length) Object.assign(p, { boxes }, e.held ? { held: null } : {});
      if (Object.keys(p).length) planEdit.addPatch(patch, sid, p);
    } else {
      const b = Object.fromEntries(Object.entries(boxes).filter(([, v]) => v));
      planEdit.addPatch(patch, sid, { slot: sl, chatterId: cid, accts, ...(Object.keys(b).length ? { boxes: b } : {}) });
    }
  }
  const touched = [...new Set([...slots, ...mine.map((s) => s.slot)])];
  const loud = touched.some((sl) => running(date, sl));
  if (Object.keys(patch).length || Object.keys(nbox).length) {
    await appSync.writePlan(date, patch, nbox, { loud });
    ctx.refresh?.(date);
    lines.unshift(
      slots.length ? `✅ ${tag(c)} · ${where(slots)} · ${whatOf(d, mids, bx.boxes)} · ${dayLabel(date)}` : `➖ ${tag(c)} n'est plus au planning du ${dayLabel(date)}.`,
      ...(taken.length ? [`↪️ ${taken.join(", ")}.`] : [])
    );
    if (loud) lines.push("📣 Annoncé dans le salon clocking.");
  } else if (!lines.length) lines.push(`Rien n'a changé pour ${tag(c)}.`);
  return done(i, lines.join("\n"), 60000);
}

// ---------- Enregistrer un nouveau chatteur ----------
async function saveNew(i, date, slot0) {
  await i.deferReply({ flags: EPHEMERAL });
  const name = chatters.cleanName(field(i, "getTextInputValue", "name"));
  const u = field(i, "getSelectedUsers", "uid")?.first?.();
  const accts = vals(i, "acc").filter((x) => x.includes("|"));
  const slots = appSync.habSlots({ slots: vals(i, "slots") });
  const cat = await appSync.appCatalog();
  const mids = midsOf(accts);
  const bx = boxesFor(field(i, "getTextInputValue", "box"), mids, modelName(cat));
  const errors = [
    !name && "écris son nom.",
    u?.bot && "choisis un chatteur, pas un bot.",
    !accts.length && "choisis au moins une modèle.",
    !slots.length && "choisis son shift.",
    bx.error,
  ].filter(Boolean);
  if (errors.length) return done(i, `⚠️ Rien n'est créé : ${errors.join(" ")}`, 60000);
  const linked = u && (await appSync.appChatters(true)).find((x) => x.discordId === u.id);
  if (linked) return done(i, `⚠️ Rien n'est créé : <@${u.id}> est déjà **${linked.name}** dans l'app. Ouvre sa fiche dans 👤 Chatteur.`, 60000);
  if (u) chatters.ctx.remember?.(u, field(i, "getSelectedMembers", "uid")?.get?.(u.id));
  const orig = chatters.draftOf(null);
  const r = await chatters.save({ cid: null, orig, d: { ...orig, name, uid: u?.id || "", slots, accts, days: ALL_DAYS, apply: true } });
  if (r.exists) return done(i, `⚠️ Rien n'est créé : **${r.exists.name}** existe déjà dans l'app. Ouvre sa fiche dans 👤 Chatteur.`, 60000);
  if (!r.ok) return done(i, r.note, 60000);
  const lines = [`➕ **${name}** créé dans l'app (Équipe) : ${where(slots)} · ${whatOf({ cat }, mids)}${u ? ` · relié à <@${u.id}>` : " · pas relié à Discord"}${r.days ? ` · 📅 planning déjà fait mis à jour (${r.days} jour${r.days > 1 ? "s" : ""})` : ""}.`];
  // ses box ce jour-là, s'il est au planning du shift (le planning déjà fait vient de le mettre sur son shift)
  const want = Object.values(bx.boxes).some((l) => l.length);
  if (want) {
    const d = await planEdit.actions.load(date);
    const main = slots.includes(slot0) ? slot0 : slots[0];
    const e = d.plan.find((s) => s.chatterId === r.id && s.slot === main);
    if (!e) lines.push(`ℹ️ Il n'est pas au planning du ${slotOf(main).emoji} ${slotOf(main).l} ce ${dayLabel(date)} : box pas mises.`);
    else {
      const patch = {}, nbox = {};
      const p = putBoxes(d, main, e.sid, e, bx.boxes, patch, nbox);
      planEdit.addPatch(patch, e.sid, { boxes: p.boxes });
      const loud = running(date, main);
      await appSync.writePlan(date, patch, nbox, { loud });
      ctx.refresh?.(date);
      lines.push(`📦 ${where([main])} · ${whatOf(d, mids, bx.boxes)}${p.taken.length ? ` · ↪️ ${p.taken.join(", ")}` : ""}${loud ? "\n📣 Annoncé dans le salon clocking." : ""}`);
    }
  }
  return done(i, lines.join("\n"), 60000);
}

async function handle(i) {
  const [id, date, slot, cid] = i.customId.split("~");
  const no = disabled(i);
  if (no) return reply(i, { content: no });
  if (id === "cf_save" && cid) return saveFiche(i, date, slot, cid);
  if (id === "cf_new") return saveNew(i, date, slot);
  return reply(i, { content: "Cette fenêtre a expiré." });
}

module.exports = { ctx, handle, openFiche, openNew, boxesFor };
