// ================== PLANNING DE L'APP -> DISCORD ==================
// Mise en forme d'une journée du planning de l'app : un seul message, l'en-tête en texte puis un bloc
// de couleur par shift, une ligne par modèle avec ses chatteurs et leurs box (comme Planning › Jour dans l'app).
const SLOTS = [
  { k: "matin", shift: "MATIN", l: "Matin", h: "08h → 14h", emoji: "🌞", color: 0xe0ae4e },
  { k: "aprem", shift: "APREM", l: "Aprem", h: "14h → 20h", emoji: "☀️", color: 0xe8875c },
  { k: "soir", shift: "SOIR", l: "Soir", h: "20h → 02h", emoji: "🌆", color: 0xa98be8 },
  { k: "nuit", shift: "NUIT", l: "Nuit", h: "02h → 08h", emoji: "🌙", color: 0x79a3e3 },
];

const BOX_ORDER = ["all", ...Array.from({ length: 15 }, (_, k) => String(k + 1))];
const boxList = (v) =>
  [...new Set((Array.isArray(v) ? v : v ? [v] : []).map(String).filter((x) => BOX_ORDER.includes(x)))]
    .sort((a, b) => BOX_ORDER.indexOf(a) - BOX_ORDER.indexOf(b));
// Box en court : « B1·2 », « All »
const boxesS = (l) => (!l.length ? "" : l.includes("all") ? "All" : "B" + l.join("·"));
const boxIdx = (l) => (l.length ? BOX_ORDER.indexOf(l[0]) : 99);

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// Repère de chaque modèle, juste après son prénom (modifiable avec MODEL_EMOJIS="anna=🍑,axelle=🍒,zoe=💎")
const key1 = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const MODEL_EMOJIS = Object.fromEntries(
  (process.env.MODEL_EMOJIS || "anna=🍑,axelle=🍒,zoe=💎")
    .split(",").map((x) => x.split("=").map((y) => y.trim()))
    .filter(([k, e]) => k && e).map(([k, e]) => [key1(k), e])
);
// « Zoé (Uncove) » -> « Zoé 💎 (Uncove) » (rien à faire si l'emoji y est déjà)
function withEmoji(name) {
  const s = String(name || "");
  const m = s.match(/^(\S+)(.*)$/s);
  const e = m && MODEL_EMOJIS[key1(m[1])];
  return !e || s.includes(e) ? s : `${m[1]} ${e}${m[2]}`;
}
// « jeudi 23 octobre »
const dayLabel = (date) =>
  new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const plS = (n) => (n > 1 ? "s" : "");

// Chatteurs d'un shift regroupés par modèle (comme Planning › Jour dans l'app)
function slotGroups(day, slot) {
  const byId = Object.fromEntries(day.chatters.map((c) => [c.id, c]));
  const off = new Set(day.offs);
  const groups = new Map(); // modèle -> chatteur -> { plats, boxes }
  for (const s of day.plan.filter((p) => p.slot === slot && byId[p.chatterId])) {
    const accts = (s.accts || []).length ? s.accts : ["|"];
    for (const a of accts) {
      const [mid, pid] = a.split("|");
      const g = groups.get(mid) || new Map();
      groups.set(mid, g);
      const e = g.get(s.chatterId) || { plats: new Set(), boxes: [] };
      g.set(s.chatterId, e);
      if (pid) e.plats.add(day.platName(pid));
      e.boxes = boxList([...e.boxes, ...boxList(s.boxes?.[mid])]);
    }
  }
  const mName = (mid) => (mid ? day.models[mid]?.name || mid : "Sans modèle");
  const out = [...groups.keys()]
    .sort((a, b) => (!a) - (!b) || mName(a).localeCompare(mName(b), "fr"))
    .map((mid) => {
      const g = groups.get(mid);
      const plats = [...new Set([...g.values()].flatMap((e) => [...e.plats]))];
      const samePlat = [...g.values()].every((e) => e.plats.size === plats.length);
      const people = [...g.keys()]
        .sort((a, b) => boxIdx(g.get(a).boxes) - boxIdx(g.get(b).boxes) || byId[a].name.localeCompare(byId[b].name, "fr"))
        .map((id) => ({
          id, c: byId[id], boxes: g.get(id).boxes, plats: [...g.get(id).plats],
          off: off.has(id), cut: day.marks?.[`${slot}_${id}`]?.status === "coupure",
        }));
      return { mid, name: withEmoji(mName(mid)), plats, samePlat, people };
    });
  const count = new Set(day.plan.filter((p) => p.slot === slot && byId[p.chatterId] && !off.has(p.chatterId)).map((p) => p.chatterId)).size;
  return { groups: out, count };
}
const whoOf = (c) => (c.discordId ? `<@${c.discordId}>` : `**${c.name}**`);
const tagOf = (p) => (p.off ? " 🏖️" : p.cut ? " ✂️" : "");

// Lignes d'un shift, une par modèle : « **Anna 🍑** Telegram · @Cruz **B1·2** · @Tina **B3** »
// (box en gras : plus lisibles que du code, qui s'affiche en petit sur Discord)
function slotLines(day, slot) {
  const { groups, count } = slotGroups(day, slot);
  const lines = groups.map((g) => {
    const people = g.people.map((p) =>
      [whoOf(p.c), p.boxes.length ? `**${boxesS(p.boxes)}**` : "", !g.samePlat && p.plats.length ? `(${p.plats.join(" + ")})` : ""].filter(Boolean).join(" ") + tagOf(p)
    );
    return `**${g.name}**${g.samePlat && g.plats.length ? ` ${g.plats.join(" + ")}` : ""} · ${people.join(" · ")}`;
  });
  return { lines, count };
}

// Box en grands chiffres (emoji) : 1️⃣·2️⃣, 🔟, 1️⃣2️⃣ (box 12), 📥 All
const keycap = (b) => (b === "10" ? "🔟" : [...String(b)].map((ch) => `${ch}\uFE0F\u20E3`).join(""));
const boxesE = (l) => (!l.length ? "" : l.includes("all") ? "📥 **All**" : l.map(keycap).join("·"));
// Message de début de shift : un chatteur par ligne, ses box en gros devant le nom, regroupés par modèle
function rosterLines(day, slot) {
  const { groups, count } = slotGroups(day, slot);
  const lines = [];
  for (const g of groups) {
    lines.push(`**${g.name}**${g.samePlat && g.plats.length ? ` · ${g.plats.join(" + ")}` : ""}`);
    for (const p of g.people)
      lines.push(`${boxesE(p.boxes) || "▫️"} ${whoOf(p.c)}${!g.samePlat && p.plats.length ? ` (${p.plats.join(" + ")})` : ""}${tagOf(p)}`);
  }
  return { lines, count };
}
// Repère d'un modèle (🍑) ou son nom s'il n'en a pas
const modelMark = (name) => {
  const w = withEmoji(name);
  return w === name ? `**${name}**` : w.slice(String(name).split(/\s/)[0].length).trim().split(/\s/)[0];
};

// Un message : l'en-tête en texte, puis un bloc de couleur par shift (objets simples, acceptés tels quels par channel.send)
function planningEmbeds(day) {
  const byId = Object.fromEntries(day.chatters.map((c) => [c.id, c]));
  const plan = day.plan.filter((p) => byId[p.chatterId]);
  const offs = day.offs.filter((id) => byId[id]);
  const people = new Set(plan.map((p) => p.chatterId).filter((id) => !offs.includes(id)));
  const who = (id) => (byId[id].discordId ? `<@${byId[id].discordId}>` : byId[id].name);
  const head = [
    `📅 **Planning du ${dayLabel(day.date)}**` +
      (plan.length ? ` · **${people.size}** chatteur${plS(people.size)}` : "\n_Rien de prévu ce jour-là dans l'app._"),
  ];
  if (offs.length) head.push(`🏖️ Day off : ${offs.map(who).join(", ")}`);
  const content = head.join("\n");
  if (!plan.length) return { content, embeds: [], count: 0 };
  const embeds = SLOTS.map((sl) => {
    const { lines, count } = slotLines(day, sl.k);
    let description = lines.length ? lines.join("\n") : "_Personne de prévu_";
    if (description.length > 4000) description = description.slice(0, 3990) + "\n…";
    return { title: `${sl.emoji} ${sl.l} · ${sl.h}${count ? ` · ${count}` : ""}`, description, color: sl.color };
  });
  return { content, embeds, count: people.size };
}

// Regroupe les embeds en messages de 6000 caractères max (limite Discord)
const embedSize = (e) => (e.title || "").length + (e.description || "").length + (e.footer?.text || "").length;
function chunkEmbeds(embeds) {
  const out = [];
  let cur = [], size = 0;
  for (const e of embeds) {
    if (cur.length && (size + embedSize(e) > 5800 || cur.length === 10)) { out.push(cur); cur = []; size = 0; }
    cur.push(e);
    size += embedSize(e);
  }
  if (cur.length) out.push(cur);
  return out;
}

module.exports = { SLOTS, planningEmbeds, slotLines, rosterLines, slotGroups, chunkEmbeds, dayLabel, boxList, boxesS, boxesE, modelMark, cap, withEmoji };
