// ================== FENÊTRES RAPIDES : REMPLACER, DÉPLACER, RENFORT ==================
// Au lieu des menus éphémères : une fenêtre Discord où l'on tape le nom du chatteur (menu des membres, avec
// recherche) et où l'on écrit ses box. Discord empile les cases les unes sous les autres (5 au plus).
// 🔁 Remplacer : qui part → qui le remplace (il reprend ses comptes et ses box), ou ses box retirées ; coupure ou non.
// 🔀 Déplacer / 💪🏼 Renfort : un chatteur, sa modèle, ses box, le shift.
// Custom ids : qm_rep~date~slot~flags (fenêtre envoyée), qm_chg~date~slot~mode ; slot « - » : trouvé d'après le chatteur,
// date « - » aussi (son shift en cours, depuis le message « a quitté » du vocal).
const { ModalBuilder, LabelBuilder, UserSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const appSync = require("./app-sync");
const planning = require("./planning");
const planEdit = require("./planedit");
const { findChatter, parseLine } = require("./shiftmodal");
const { reply, done, EPHEMERAL } = require("./ui");
const { SLOTS, withEmoji, boxList, boxLabel, dayLabel } = planning;
const { tag, running, isNow, slotOf, midsOf } = planEdit.helpers;

const ctx = {}; // isAdmin(i), refresh(date)
const label = (l, d) => (d ? new LabelBuilder().setLabel(l).setDescription(d) : new LabelBuilder().setLabel(l));
const userPick = (id, uid) => {
  const m = new UserSelectMenuBuilder().setCustomId(id).setRequired(false).setMinValues(0).setMaxValues(1).setPlaceholder("🔎 Tape son nom");
  return uid ? m.setDefaultUsers(uid) : m;
};
const choice = (id, opts) =>
  new StringSelectMenuBuilder().setCustomId(id).setRequired(true).setMinValues(1).setMaxValues(1)
    .addOptions(opts.map(([value, l, def, description]) => ({ label: l.slice(0, 100), value, ...(description ? { description: description.slice(0, 100) } : {}), default: !!def })));
const text = (id, placeholder, value) => {
  const t = new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(60).setPlaceholder(placeholder);
  return value ? t.setValue(value) : t;
};
const shortDay = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
// shift du jour en cours (ou qui commence dans les 15 min), sinon rien
const liveSlot = (date) => SLOTS.find((s) => isNow(date, s.k) || (running(date, s.k) && Date.now() >= appSync.parisMs(date, appSync.START_OF[s.k]) - 15 * 60e3))?.k;

// ---------- Ouvrir ----------
// out : compte Discord de celui qui part (pré-rempli) ; noted : sa coupure est déjà notée
function openReplace(i, { date, slot, out, outName, noted = false }) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  if (!appSync.enabled()) return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  const sl = slot && slotOf(slot);
  const m = new ModalBuilder()
    .setCustomId(`qm_rep~${date}~${slot || "-"}~${noted ? "n" : ""}`)
    .setTitle(`🔁 Remplacer${sl ? ` · ${sl.l}` : ""}${date !== "-" ? ` · ${shortDay(date)}` : ""}`.slice(0, 45))
    .addLabelComponents(
      label("Qui part ?").setUserSelectMenuComponent(userPick("out", out)),
      label("Qui le remplace ?", "Il reprend ses comptes et ses box").setUserSelectMenuComponent(userPick("inn")),
      label("Ses box").setStringSelectMenuComponent(choice("fate", [
        ["take", "🔁 Le remplaçant les reprend", true],
        ["free", "🧺 Personne : elles sont retirées", false, "Pas besoin de choisir qui le remplace"],
      ])),
      ...(noted
        ? []
        : [label("Coupure ?").setStringSelectMenuComponent(choice("cut", [
            ["no", "Non, il part", true],
            ["yes", "⚡ Oui, une coupure", false, "Notée au pointage ; il reprend ses box à son retour"],
          ]))]),
      label("Pas sur Discord ?", "Tape les prénoms : qui part > qui le remplace").setTextInputComponent(text("names", "ex : Kelly > Jean", !out && outName ? `${outName} > ` : ""))
    );
  return i.showModal(m);
}
// mode : mv (déplacer, box), ren (renfort) ou any (👤 un autre chatteur, depuis le menu du panneau) ; uid : son compte Discord (pré-rempli)
async function openChange(i, { date, slot, mode = "mv", uid, name }) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  if (!appSync.enabled()) return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  // la fenêtre doit s'ouvrir dans les 3 s : les modèles viennent du cache (relu au plus 1,5 s sinon)
  const cat = await Promise.race([appSync.appCatalog().catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]);
  const accts = (cat?.accounts || []).map((a) => [a.key, `${withEmoji(a.model)} · ${a.platform}`]).slice(0, 24);
  const cur = slot || liveSlot(date) || "soir";
  const m = new ModalBuilder()
    .setCustomId(`qm_chg~${date}~${cur}~${mode}`)
    .setTitle(`${mode === "ren" ? "💪🏼 Renfort" : mode === "any" ? "👤 Un autre chatteur" : "🔀 Déplacer / box"} · ${shortDay(date)}`.slice(0, 45))
    .addLabelComponents(
      label("Chatteur").setUserSelectMenuComponent(userPick("who", uid)),
      label("Modèle").setStringSelectMenuComponent(choice("acc", [["keep", mode === "ren" ? "Sa modèle habituelle" : "Garder sa modèle", true], ...accts])),
      label("Box", "1 2 · all · 0 = aucune · vide = sans changement").setTextInputComponent(text("box", "ex : 3 4")),
      label("Shift").setStringSelectMenuComponent(choice("slot", SLOTS.map((s) => [s.k, `${s.emoji} ${s.l} · ${s.h}`, s.k === cur]))),
      label("Pas sur Discord ?", "Tape son prénom").setTextInputComponent(text("name", "ex : Kelly", !uid && name ? name : ""))
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
// Le chatteur choisi dans un menu des membres de la fenêtre : { c } ou { error } ou null (rien choisi)
async function fromUser(i, id, chatters) {
  const u = field(i, "getSelectedUsers", id)?.first?.();
  if (!u) return null;
  if (u.bot) return { error: "Choisis un chatteur, pas un bot." };
  const m = field(i, "getSelectedMembers", id)?.get?.(u.id);
  const names = [m?.displayName, m?.nick, u.globalName, u.username].filter(Boolean);
  const c = chatters.find((x) => x.discordId === u.id) || (await appSync.chatterOf(u.id, names, false).catch(() => null));
  return c ? { c } : { error: `**${names[0] || "Ce membre"}** n'est relié à aucun chatteur de l'app (Équipe › Comptes Discord) : tape son prénom dans la dernière case.` };
}
const fromName = (name, chatters) => (String(name || "").trim() ? findChatter(String(name).trim(), chatters) : null);
const sel = (i, id, def) => field(i, "getStringSelectValues", id)?.[0] || def;
// « 3 4 », « all », « VIP », « 0 » (aucune) ; vide : null (sans changement) ; { error } si une box n'existe pas
function boxesOf(t) {
  const s = String(t || "").trim();
  if (!s) return null;
  if (/^(0|aucune?|non|rien|-)$/i.test(s)) return [];
  const { boxes, name } = parseLine(`x ${s}`);
  const bad = boxes.filter((b) => planning.isNum(b) && (Number(b) < 1 || Number(b) > 15));
  if (name !== "x" || bad.length || !boxes.length) return { error: `Box « ${s} » : écris des numéros de 1 à 15 (ex : 3 4), all, VIP, ou 0 pour aucune.` };
  return planning.soloAll(boxList(boxes));
}

// ---------- Remplacer ----------
async function saveReplace(i, date, slot0, flags) {
  await i.deferReply({ flags: EPHEMERAL });
  const noted = flags.includes("n");
  const chatters = await appSync.appChatters(true);
  const [left, right] = String(field(i, "getTextInputValue", "names") || "").split(/\s*(?:>|->|→|=>)\s*/);
  let out = await fromUser(i, "out", chatters);
  let inn = await fromUser(i, "inn", chatters);
  // un seul prénom tapé : celui qui manque (qui part d'abord)
  if (right !== undefined) {
    out = out || fromName(left, chatters);
    inn = inn || fromName(right, chatters);
  } else if (left) {
    if (!out) out = fromName(left, chatters);
    else if (!inn) inn = fromName(left, chatters);
  }
  const fate = sel(i, "fate", "take");
  const cut = noted || sel(i, "cut", "no") === "yes";
  const errors = [out?.error, inn?.error].filter(Boolean);
  if (!out && !errors.length) errors.push("Choisis qui part.");
  if (fate === "take" && !inn && !errors.length) errors.push("Choisis qui le remplace (ou « 🧺 Personne : elles sont retirées »).");
  if (errors.length) return done(i, `⚠️ Rien n'est changé : ${errors.join(" ")}`, 60000);
  if (date === "-") {
    const p = await appSync.plannedSlotAt(out.c.discordId || "", [out.c.name], Date.now()).catch(() => null);
    if (!p) return done(i, `⚠️ ${tag(out.c)} n'est au planning d'aucun shift en cours.`, 60000);
    [date, slot0] = [p.date, p.slot];
  }
  const d = await planEdit.actions.load(date);
  // son shift : celui du bouton, sinon celui en cours, sinon le premier où il est ce jour-là
  const mine = d.plan.filter((s) => s.chatterId === out.c.id);
  const e = mine.find((s) => s.slot === slot0) || mine.find((s) => s.slot === liveSlot(date)) || (slot0 === "-" ? mine[0] : null);
  if (!e) return done(i, `⚠️ ${tag(out.c)} n'est pas au planning${slot0 !== "-" ? ` du ${slotOf(slot0).emoji} ${slotOf(slot0).l}` : ""} ce ${dayLabel(date)}.`, 60000);
  const st = { date, slot: e.slot, out: e.sid, inn: inn?.c.id, fate: "keep", cut: cut && !noted, cutNoted: noted };
  let res;
  if (fate === "free") {
    if (cut && !noted) await appSync.markCoupure({ cid: out.c.id, slot: e.slot, date }).catch((err) => console.error("Coupure :", err.message));
    res = await planEdit.actions.freeBoxes({ ...st, cutNoted: cut });
    if (cut && !noted && res.startsWith("✅")) res += " ⚡ Coupure notée au pointage.";
  } else res = await planEdit.actions.replace(st);
  ctx.refresh?.(date);
  return done(i, res, 60000);
}

// ---------- Déplacer / box / renfort ----------
async function saveChange(i, date, slot0, mode) {
  await i.deferReply({ flags: EPHEMERAL });
  const chatters = await appSync.appChatters(true);
  const who = (await fromUser(i, "who", chatters)) || fromName(field(i, "getTextInputValue", "name"), chatters);
  if (!who) return done(i, "⚠️ Rien n'est changé : choisis le chatteur (ou tape son prénom).", 60000);
  if (who.error) return done(i, `⚠️ Rien n'est changé : ${who.error}`, 60000);
  const c = who.c;
  const slot = sel(i, "slot", slot0);
  const acc = sel(i, "acc", "keep");
  const bx = boxesOf(field(i, "getTextInputValue", "box"));
  if (bx?.error) return done(i, `⚠️ Rien n'est changé : ${bx.error}`, 60000);
  const d = await planEdit.actions.load(date);
  if (d.off.has(c.id)) return done(i, `⛔ ${tag(c)} est en day off ce ${dayLabel(date)}.`, 60000);
  const sl = slotOf(slot);
  const e = d.plan.find((s) => s.chatterId === c.id && s.slot === slot);
  const was = e ? [...(e.accts || [])] : [];
  // ses comptes : la modèle choisie remplace les autres ; « garder » : les siens (ou son habituel s'il arrive)
  let accts = acc === "keep" ? (e ? was : (c.shift?.accts || []).slice(0, 1)) : [acc];
  if (!accts.length) return done(i, `⚠️ ${tag(c)} n'a pas de modèle habituelle : choisis sa modèle.`, 60000);
  const mid = acc === "keep" ? midsOf(accts)[0] : acc.split("|")[0];
  const gone = midsOf(was).filter((m) => !midsOf(accts).includes(m));
  const sid = e?.sid || appSync.newId();
  const patch = {};
  const taken = bx && bx.length ? planEdit.takeBoxes(d, slot, mid, bx, [sid], patch) : [];
  const boxes = { ...Object.fromEntries(gone.filter((m) => e?.boxes?.[m]).map((m) => [m, null])), ...(bx ? { [mid]: bx.length ? bx : null } : {}) };
  if (e) {
    const p = {};
    if (JSON.stringify([...accts].sort()) !== JSON.stringify([...was].sort())) p.accts = accts;
    if (Object.keys(boxes).length) p.boxes = boxes;
    if (Object.keys(p).length) planEdit.addPatch(patch, sid, { ...p, ...(e.held && p.boxes ? { held: null } : {}) });
  } else {
    const b = Object.fromEntries(Object.entries(boxes).filter(([, v]) => v));
    planEdit.addPatch(patch, sid, { slot, chatterId: c.id, accts, ...(Object.keys(b).length ? { boxes: b } : {}) });
  }
  if (!Object.keys(patch).length) return done(i, `Rien n'a changé pour ${tag(c)}.`, 30000);
  // shift en cours ou qui commence bientôt : la ligne part dans le salon box (comme un changement de l'app)
  await appSync.writePlan(date, patch, null, { loud: running(date, slot) });
  ctx.refresh?.(date);
  const cat = d.cat;
  const where = `${sl.emoji} ${sl.l} (${dayLabel(date)})`;
  const what = `${withEmoji(cat.models[mid]?.name || mid)}${bx && bx.length ? ` · ${boxLabel(bx)}` : bx ? " · sans box" : ""}`;
  const head = !e ? `💪🏼 ${tag(c)} ${mode === "ren" ? "en renfort" : "ajouté"} sur ${where} · ${what}` : gone.length ? `🔀 ${tag(c)} passe sur ${what} · ${where}` : `📦 ${tag(c)} · ${what} · ${where}`;
  return done(i, `✅ ${head}.${taken.length ? ` ↪️ ${taken.join(", ")}.` : ""}${running(date, slot) ? "\n📣 Annoncé dans le salon box." : ""}`, 60000);
}

async function handle(i) {
  const [id, date, slot, extra = ""] = i.customId.split("~");
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  if (!appSync.enabled()) return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  if (id === "qm_rep") return saveReplace(i, date, slot, extra);
  if (id === "qm_chg") return saveChange(i, date, slot, extra || "mv");
  return reply(i, { content: "Cette fenêtre a expiré." });
}

module.exports = { ctx, handle, openReplace, openChange, boxesOf };
