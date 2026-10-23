// ================== PLANNING DE L'APP -> DISCORD ==================
// Mise en forme d'une journée du planning de l'app : un embed d'en-tête puis un embed par shift,
// les chatteurs rangés par modèle avec leurs box (comme Planning › Jour dans l'app).
const SLOTS = [
  { k: "matin", shift: "MATIN", l: "Matin", h: "08h → 14h", emoji: "🌞", color: 0xe0ae4e },
  { k: "aprem", shift: "APREM", l: "Aprem", h: "14h → 20h", emoji: "☀️", color: 0xe8875c },
  { k: "soir", shift: "SOIR", l: "Soir", h: "20h → 02h", emoji: "🌆", color: 0xa98be8 },
  { k: "nuit", shift: "NUIT", l: "Nuit", h: "02h → 08h", emoji: "🌙", color: 0x79a3e3 },
];
const ACCENT = 0x5bae8c;

const BOX_ORDER = ["all", ...Array.from({ length: 15 }, (_, k) => String(k + 1))];
const boxList = (v) =>
  [...new Set((Array.isArray(v) ? v : v ? [v] : []).map(String).filter((x) => BOX_ORDER.includes(x)))]
    .sort((a, b) => BOX_ORDER.indexOf(a) - BOX_ORDER.indexOf(b));
const boxesL = (l) => (!l.length ? "" : l.includes("all") ? "All Inbox" : "Box " + l.join(", "));
const boxIdx = (l) => (l.length ? BOX_ORDER.indexOf(l[0]) : 99);

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// « jeudi 23 octobre »
const dayLabel = (date) =>
  new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const plS = (n) => (n > 1 ? "s" : "");

// Lignes d'un shift : « **Anna** · Telegram » puis « > @Cruz · `Box 1, 2` » pour chaque chatteur
function slotLines(day, slot) {
  const byId = Object.fromEntries(day.chatters.map((c) => [c.id, c]));
  const off = new Set(day.offs);
  const who = (id) => (byId[id].discordId ? `<@${byId[id].discordId}>` : `**${byId[id].name}**`);
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
  const lines = [];
  for (const mid of [...groups.keys()].sort((a, b) => (!a) - (!b) || mName(a).localeCompare(mName(b), "fr"))) {
    const g = groups.get(mid);
    const plats = [...new Set([...g.values()].flatMap((e) => [...e.plats]))];
    const samePlat = [...g.values()].every((e) => e.plats.size === plats.length);
    lines.push(`**${mName(mid)}**${samePlat && plats.length ? ` · ${plats.join(" + ")}` : ""}`);
    const ids = [...g.keys()].sort((a, b) => boxIdx(g.get(a).boxes) - boxIdx(g.get(b).boxes) || byId[a].name.localeCompare(byId[b].name, "fr"));
    for (const id of ids) {
      const e = g.get(id);
      const bits = [who(id)];
      if (e.boxes.length) bits.push(`\`${boxesL(e.boxes)}\``);
      if (!samePlat && e.plats.size) bits.push([...e.plats].join(" + "));
      if (off.has(id)) bits.push("🏖️ day off");
      lines.push(`> ${bits.join(" · ")}`);
    }
  }
  const count = new Set(day.plan.filter((p) => p.slot === slot && byId[p.chatterId] && !off.has(p.chatterId)).map((p) => p.chatterId)).size;
  return { lines, count };
}

// Embeds Discord (objets simples, acceptés tels quels par channel.send)
function planningEmbeds(day) {
  const byId = Object.fromEntries(day.chatters.map((c) => [c.id, c]));
  const plan = day.plan.filter((p) => byId[p.chatterId]);
  const offs = day.offs.filter((id) => byId[id]);
  const people = new Set(plan.map((p) => p.chatterId).filter((id) => !offs.includes(id)));
  const who = (id) => (byId[id].discordId ? `<@${byId[id].discordId}>` : byId[id].name);
  const head = [
    plan.length ? `**${people.size}** chatteur${plS(people.size)} au planning` : "_Rien de prévu ce jour-là dans l'app._",
  ];
  if (offs.length) head.push(`🏖️ Day off : ${offs.map(who).join(", ")}`);
  const embeds = [{ title: `📅 Planning du ${dayLabel(day.date)}`, description: head.join("\n"), color: ACCENT }];
  if (!plan.length) return { embeds, count: 0 };
  for (const sl of SLOTS) {
    const { lines, count } = slotLines(day, sl.k);
    let description = lines.length ? lines.join("\n") : "_Personne de prévu_";
    if (description.length > 4000) description = description.slice(0, 3990) + "\n…";
    embeds.push({
      title: `${sl.emoji} ${sl.l} · ${sl.h}`,
      description,
      color: sl.color,
      ...(count ? { footer: { text: `${count} chatteur${plS(count)}` } } : {}),
    });
  }
  return { embeds, count: people.size };
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

module.exports = { SLOTS, planningEmbeds, slotLines, chunkEmbeds, dayLabel, boxList, boxesL, cap };
