// ================== ✏️ MODIFIER UN SHIFT D'UN COUP ==================
// Une fenêtre avec une case par modèle ; dans chaque case, un chatteur par ligne suivi de ses box :
//   Jean 1 2
//   Jojo 3
//   Momo
// On change quelqu'un de modèle en déplaçant sa ligne dans une autre case, on le retire du shift en effaçant
// sa ligne, on ajoute quelqu'un en tapant son prénom (le début suffit). Tout est enregistré d'un coup dans le
// planning de l'app (plan/<date>), qui reste la vue complète. Une box n'est qu'à un seul chatteur.
const { ModalBuilder, TextInputBuilder, TextInputStyle, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const planning = require("./planning");
const { reply, row, button, EPHEMERAL } = require("./ui");
const { SLOTS, boxList, withEmoji, dayLabel } = planning;

// Fourni par index.js : isAdmin(i), refresh(date)
const ctx = {};
// Le texte envoyé, gardé pour le corriger après une erreur : userId -> { date, slot, texts: { mid: texte } }
const drafts = new Map();

const slotOf = (k) => SLOTS.find((s) => s.k === k);
const midsOf = (accts) => [...new Set((accts || []).map((k) => k.split("|")[0]).filter(Boolean))];
const plS = (n) => (n > 1 ? "s" : "");
// « Jean (Aprem) 🍑 » -> « jean »
const norm = (s) =>
  String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const shortDay = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const same = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);
// Box écrites dans la fenêtre : « 1 2 », « all »
const boxText = (l) => (l.includes("all") ? "all" : l.join(" "));
const boxWords = (l) => (!l.length ? "sans box" : l.includes("all") ? "All Inbox" : `Box ${l.join(" & ")}`);
const rank = (l) => (!l.length ? 99 : l[0] === "all" ? 0 : Number(l[0]));

// Le shift tel qu'il est maintenant, et les modèles de la fenêtre (5 cases au plus : celles du shift d'abord)
async function loadShift(date, slot) {
  const [day, cat] = await Promise.all([appSync.planningDay(date), appSync.appCatalog()]);
  const byId = Object.fromEntries(day.chatters.map((c) => [c.id, c]));
  const here = day.plan.filter((s) => s.slot === slot && byId[s.chatterId]);
  const mName = (mid) => cat.models[mid]?.name || mid;
  const alpha = (a, b) => mName(a).localeCompare(mName(b), "fr");
  const onShift = [...new Set(here.flatMap((s) => midsOf(s.accts)))].filter((m) => cat.models[m]).sort(alpha);
  const others = Object.keys(cat.models).filter((m) => cat.models[m].active !== false && !onShift.includes(m)).sort(alpha);
  const mids = [...onShift, ...others].slice(0, 5).sort(alpha);
  return { day, cat, byId, here, mids, mName, off: new Set(day.offs) };
}
// Box d'un chatteur sur une modèle (toutes ses lignes de ce shift)
const boxesOf = (entries, mid) => boxList(entries.flatMap((s) => boxList(s.boxes?.[mid])));

// ---------- La fenêtre ----------
function modalOf(D, date, slot, texts) {
  const sl = slotOf(slot);
  const m = new ModalBuilder().setCustomId(`pm_save~${date}~${slot}`).setTitle(`${sl.emoji} ${sl.l} · ${shortDay(date)}`.slice(0, 45));
  for (const mid of D.mids) {
    const on = D.here.filter((s) => midsOf(s.accts).includes(mid));
    const people = [...new Set(on.map((s) => s.chatterId))]
      .map((cid) => ({ c: D.byId[cid], l: boxesOf(on.filter((s) => s.chatterId === cid), mid) }))
      .sort((a, b) => rank(a.l) - rank(b.l) || a.c.name.localeCompare(b.c.name, "fr"));
    const plats = [...new Set(on.flatMap((s) => (s.accts || []).filter((k) => k.startsWith(mid + "|")).map((k) => D.cat.platName(k.split("|")[1]))))];
    const n = Number(D.day.nbox?.[`${slot}|${mid}`]) || 0;
    const label = [withEmoji(D.mName(mid)).toLocaleUpperCase("fr"), plats.join(" + "), n ? `${n} box` : ""].filter(Boolean).join(" · ");
    const value = texts ? texts[mid] ?? "" : people.map((p) => [p.c.name, boxText(p.l)].filter(Boolean).join(" ")).join("\n");
    const input = new TextInputBuilder()
      .setCustomId(`m~${mid}`)
      .setLabel(label.slice(0, 45))
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(1500)
      .setPlaceholder("Un chatteur par ligne, puis ses box : Jean 1 2");
    if (value) input.setValue(value.slice(0, 1500));
    m.addComponents(row(input));
  }
  return m;
}
// Ouvre la fenêtre (Discord laisse 3 s : une seule lecture du planning)
async function openModal(i, date, slot, texts) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  if (!appSync.enabled()) return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  if (!slotOf(slot) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply(i, { content: "Ce bouton a expiré." });
  const D = await loadShift(date, slot);
  if (!D.mids.length) return reply(i, { content: "⚠️ Aucune modèle active dans l'app." });
  return i.showModal(modalOf(D, date, slot, texts));
}

// ---------- Lecture du texte ----------
// « Jean 1 2 », « Jean : 1.2 », « Jean box 1 & 2 », « Jean 1-3 », « Jean all » -> { name: "Jean", boxes: [...] }
function parseLine(line) {
  const t = String(line)
    .replace(/^[\s\-•*·>]+/, "")
    .replace(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/g, (m, a, b) => (+a < +b && +b - +a < 15 ? Array.from({ length: +b - +a + 1 }, (_, k) => +a + k).join(" ") : m))
    .replace(/(\d)\.(?=\d)/g, "$1 ")
    .replace(/[,;&+/|:=·]/g, " ");
  const toks = t.split(/\s+/).filter(Boolean);
  const boxes = [];
  while (toks.length > 1) {
    const w = norm(toks[toks.length - 1]).replace(/ /g, "");
    const m = w.match(/^(?:box|b)?(\d{1,3})$/);
    if (m) boxes.unshift(String(Number(m[1])));
    else if (["all", "inbox", "allinbox"].includes(w)) boxes.unshift("all");
    else if (!["", "box", "boxes", "b", "et", "and"].includes(w)) break;
    toks.pop();
  }
  return { name: toks.join(" ").replace(/[-–>]+$/, "").trim(), boxes: [...new Set(boxes)] };
}
// Le chatteur de l'app pour un prénom tapé : exact, sinon le début du prénom (ou d'un de ses mots), sinon erreur
function findChatter(name, chatters) {
  const n = norm(name);
  const men = String(name).match(/<@!?(\d+)>/);
  if (men) {
    const c = chatters.find((x) => x.discordId === men[1]);
    return c ? { c } : { error: `${name} n'est relié à aucun chatteur de l'app` };
  }
  if (!n) return { error: "une ligne sans prénom" };
  const pool = chatters.filter((c) => c.active);
  const tries = [
    (c) => norm(c.name) === n,
    (c) => norm(c.name).startsWith(n),
    (c) => norm(c.name).split(" ").some((w) => w.startsWith(n)),
  ];
  for (const f of tries) {
    const hits = pool.filter(f);
    if (hits.length === 1) return { c: hits[0] };
    if (hits.length > 1) return { error: `« ${name} » : ${hits.slice(0, 4).map((c) => c.name).join(" ou ")} ? Écris son prénom en entier` };
  }
  return chatters.some((c) => norm(c.name) === n)
    ? { error: `« ${name} » est inactif dans l'app` }
    : { error: `« ${name} » : aucun chatteur à ce nom dans l'app` };
}

// ---------- Enregistrement ----------
// texts : { mid: texte } -> le planning de ce shift pour ces modèles ; renvoie { errors } ou { lines }
async function applyTexts(date, slot, texts) {
  const D = await loadShift(date, slot);
  const mids = Object.keys(texts).filter((m) => D.cat.models[m]);
  const ml = (mid) => withEmoji(D.mName(mid));
  const chatters = Object.values(D.byId);
  const want = new Map(); // chatteur -> Map(modèle -> box)
  const owner = {};
  const errors = [];
  for (const mid of mids)
    for (const raw of String(texts[mid] || "").split("\n")) {
      if (!raw.trim()) continue;
      const { name, boxes } = parseLine(raw);
      const r = findChatter(name, chatters);
      if (r.error) {
        errors.push(`${ml(mid)} · ${r.error}`);
        continue;
      }
      const bad = boxes.filter((b) => b !== "all" && !(Number(b) >= 1 && Number(b) <= 15));
      if (bad.length) errors.push(`${ml(mid)} · ${r.c.name} : Box ${bad.join(", ")} n'existe pas (de 1 à 15, ou all)`);
      const m = want.get(r.c.id) || new Map();
      want.set(r.c.id, m);
      let l = boxList([...(m.get(mid) || []), ...boxes]);
      if (l.includes("all")) l = ["all"];
      m.set(mid, l);
      for (const b of l.filter((x) => x !== "all")) {
        const k = `${mid}|${b}`;
        if (owner[k] && owner[k] !== r.c.id) errors.push(`${ml(mid)} · Box ${b} écrite pour ${D.byId[owner[k]].name} et pour ${r.c.name} : une box = un chatteur`);
        owner[k] = r.c.id;
      }
    }
  if (errors.length) return { errors: [...new Set(errors)] };

  // compte (plateforme) d'une modèle pour un chatteur : le sien, son habituel, celui du shift, sinon le premier de l'app
  const acctFor = (c, mid) => {
    const pre = (k) => k.startsWith(mid + "|");
    const counts = {};
    D.here.flatMap((s) => s.accts || []).filter(pre).forEach((k) => (counts[k] = (counts[k] || 0) + 1));
    return (c.shift?.accts || []).find(pre) || Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || D.cat.accounts.find((a) => a.mid === mid)?.key || null;
  };
  const patch = {};
  const added = [], removed = [], moved = [], boxed = [], warn = [];
  const inWin = new Set(mids);
  for (const cid of new Set([...D.here.map((s) => s.chatterId), ...want.keys()])) {
    const c = D.byId[cid];
    const entries = D.here.filter((s) => s.chatterId === cid);
    const w = want.get(cid) || new Map();
    const oldAccts = [...new Set(entries.flatMap((s) => s.accts || []))];
    const before = midsOf(oldAccts).filter((m) => inWin.has(m));
    // comptes des modèles hors de la fenêtre : gardés tels quels
    const accts = oldAccts.filter((k) => !inWin.has(k.split("|")[0]));
    for (const mid of w.keys()) {
      const mine = oldAccts.filter((k) => k.startsWith(mid + "|"));
      const a = mine.length ? mine : [acctFor(c, mid)].filter(Boolean);
      if (!a.length) errors.push(`${ml(mid)} n'a aucun compte (plateforme) dans l'app`);
      accts.push(...a);
    }
    const after = [...w.keys()];
    if (!accts.length) {
      entries.forEach((s) => (patch[s.sid] = null));
      if (entries.length) removed.push(c.name);
      continue;
    }
    // box : celles écrites pour les modèles de la fenêtre, les autres restent
    const boxes = {};
    let changed = false;
    for (const mid of new Set([...mids, ...midsOf(oldAccts)])) {
      const old = boxesOf(entries, mid);
      const now = inWin.has(mid) ? w.get(mid) || [] : old;
      if (!same(old, now)) changed = true;
      if (inWin.has(mid) ? now.length || old.length : now.length) boxes[mid] = now.length ? now : null;
      if (inWin.has(mid) && w.has(mid) && !same(old, now)) boxed.push(`${c.name} ${now.length ? boxWords(now) : "sans box"}${after.length > 1 ? ` (${D.mName(mid)})` : ""}`);
    }
    if (!entries.length) {
      patch[appSync.newId()] = { slot, chatterId: cid, accts, boxes: Object.fromEntries(Object.entries(boxes).filter(([, v]) => v)) };
      added.push(`${c.name} (${after.map(ml).join(", ")})`);
      if (D.off.has(cid)) warn.push(`🏖️ ${c.name} est en day off ce jour-là.`);
      continue;
    }
    const [e, ...dup] = entries;
    dup.forEach((s) => (patch[s.sid] = null));
    const p = {};
    if (dup.length || !same([...(e.accts || [])].sort(), [...new Set(accts)].sort())) p.accts = [...new Set(accts)];
    if (changed || dup.length) {
      p.boxes = boxes;
      if (entries.some((s) => s.held)) p.held = null;
    }
    if (Object.keys(p).length) patch[e.sid] = p;
    const gone = before.filter((m) => !after.includes(m)), come = after.filter((m) => !before.includes(m));
    if (gone.length || come.length)
      moved.push(`${c.name} : ${gone.length ? gone.map(ml).join(", ") : "—"} → ${come.length ? come.map(ml).join(", ") : "—"}`);
  }
  if (errors.length) return { errors: [...new Set(errors)] };
  // nombre de box de chaque modèle : la plus haute écrite
  const nbox = {};
  for (const mid of mids) {
    const top = Math.max(0, ...[...want.values()].flatMap((m) => (m.get(mid) || []).filter((b) => b !== "all").map(Number)));
    if (top && top !== Number(D.day.nbox?.[`${slot}|${mid}`])) nbox[`${slot}|${mid}`] = top;
  }
  if (!Object.keys(patch).length && !Object.keys(nbox).length) return { lines: ["Rien n'a changé."] };
  // shift en cours (ou qui commence dans les 2 h) : les changements sont annoncés dans le salon clocking
  const start = appSync.parisMs(date, appSync.START_OF[slot]);
  const live = Object.keys(patch).length > 0 && Date.now() >= start - 2 * 3600e3 && Date.now() < start + 6 * 3600e3;
  await appSync.writePlan(date, patch, nbox, { loud: live });
  ctx.refresh?.(date);
  const sl = slotOf(slot);
  const n = Object.keys(nbox).map((k) => `${D.mName(k.split("|")[1])} ${nbox[k]} box`);
  return {
    lines: [
      `✅ **${sl.emoji} ${sl.l} · ${dayLabel(date)}** enregistré.`,
      added.length ? `➕ Ajouté${plS(added.length)} : ${added.join(" · ")}` : "",
      moved.length ? `🔀 ${moved.join(" · ")}` : "",
      removed.length ? `➖ Retiré${plS(removed.length)} du shift : ${removed.join(", ")}` : "",
      boxed.length ? `📦 ${boxed.join(" · ")}` : "",
      n.length ? `📦 ${n.join(" · ")}` : "",
      ...warn,
      live ? "📣 Annoncé dans le salon clocking." : "",
    ].filter(Boolean),
  };
}

// ---------- Interactions pm_… ----------
// pm_open~date~slot : la fenêtre ; pm_pick~date (menu des shifts) ; pm_fix~date~slot : la rouvrir avec le texte envoyé ;
// pm_save~date~slot : la fenêtre envoyée
async function handle(i) {
  const [id, date, slot0] = i.customId.split("~");
  const slot = id === "pm_pick" ? i.values?.[0] : slot0;
  if (id === "pm_open" || id === "pm_pick") return openModal(i, date, slot);
  if (id === "pm_fix") {
    const d = drafts.get(i.user.id);
    return openModal(i, date, slot, d && d.date === date && d.slot === slot ? d.texts : null);
  }
  if (id !== "pm_save") return reply(i, { content: "Ce bouton a expiré." });
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const texts = {};
  for (const [k, f] of i.fields.fields || new Map()) if (k.startsWith("m~")) texts[k.slice(2)] = f.value ?? "";
  await i.deferReply({ flags: EPHEMERAL });
  const r = await applyTexts(date, slot, texts);
  if (r.errors) {
    drafts.set(i.user.id, { date, slot, texts });
    return i.editReply({
      content: ["⚠️ **Rien n'est enregistré** :", ...r.errors.slice(0, 15).map((x) => `• ${x}`), "-# Clique sur ✏️ Corriger : tu retrouves ton texte."].join("\n").slice(0, 2000),
      components: [row(button(`pm_fix~${date}~${slot}`, "Corriger", "✏️", ButtonStyle.Primary))],
      allowedMentions: { parse: [] },
    });
  }
  drafts.delete(i.user.id);
  return i.editReply({
    content: r.lines.join("\n").slice(0, 2000),
    components: [row(button(`pm_open~${date}~${slot}`, "Modifier encore", "✏️", ButtonStyle.Secondary))],
    allowedMentions: { parse: [] },
  });
}
// Le bouton qui ouvre la fenêtre (panneau du shift, écran du shift, box du shift)
const openButton = (date, slot, label = "Modifier le shift", style = ButtonStyle.Primary) => button(`pm_open~${date}~${slot}`, label, "✏️", style);

module.exports = { ctx, handle, openButton, parseLine, findChatter, applyTexts };
