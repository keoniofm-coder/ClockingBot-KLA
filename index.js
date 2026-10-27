const {
  Client, GatewayIntentBits, Events, EmbedBuilder, ButtonStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, LabelBuilder, TextDisplayBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, REST, Routes, PermissionFlagsBits,
} = require("discord.js");
const cron = require("node-cron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const appSync = require("./app-sync");
const planning = require("./planning");
const planEdit = require("./planedit");
const dayoff = require("./dayoff");
const voice = require("./voice");
const gestion = require("./gestion");
const chatters = require("./chatters");
const penalties = require("./penalties");
const shiftModal = require("./shiftmodal");
const planWatch = require("./planwatch");
const quickModal = require("./quickmodal");
const fiche = require("./fiche");
const menus = require("./menus");
const { EPHEMERAL, reply, done, row, button, opt, chunk, fit, plS, v2Messages } = require("./ui");
const { withEmoji } = planning;

// ================== CONFIG ==================
const TOKEN = (process.env.DISCORD_TOKEN || "").trim();
const CLIENT_ID = (process.env.CLIENT_ID || "").trim();
const GUILD_ID = (process.env.GUILD_ID || "").trim();
const VENTES_CHANNEL_ID = (process.env.VENTES_CHANNEL_ID || "").trim();
// Salon box (l'ancien salon planning) : un seul message, les box du shift en cours, et 🛠️ Admin
const PLANNING_CHANNEL_ID = (process.env.PLANNING_CHANNEL_ID || "1553946673141518466").trim();
const BOX_CHANNEL_ID = (process.env.BOX_CHANNEL_ID || PLANNING_CHANNEL_ID).trim();
// Modèles qui ont une fiche de fin de shift dans le salon ventes (les autres n'en ont pas)
const FICHE_MODELES = new RegExp(process.env.FICHE_MODELES || "uncove", "i");
// Ancien récap de l'effectif, N minutes après le début de chaque shift : remplacé par le panneau du shift
// (pointage en direct), plus envoyé sauf si EFFECTIF_APRES_MIN est réglé dans Railway
const EFFECTIF_APRES = Math.min(300, Math.max(0, Number(process.env.EFFECTIF_APRES_MIN ?? 0) || 0));
const TZ = "Europe/Paris";

const DATA_DIR = process.env.DATA_DIR || "/data"; // Volume Railway
const DATA_FILE = path.join(DATA_DIR, "data.json");

const SHIFTS = {
  MATIN: { start: 8, label: "08h-14h", emoji: "🌞", color: 0xe0ae4e },
  APREM: { start: 14, label: "14h-20h", emoji: "☀️", color: 0xe8875c },
  SOIR: { start: 20, label: "20h-02h", emoji: "🌆", color: 0xa98be8 },
  NUIT: { start: 2, label: "02h-08h", emoji: "🌙", color: 0x79a3e3 },
};
const SHIFT_ORDER = Object.keys(SHIFTS);

// ================== DATA ==================
const DEFAULT_DATA = {
  modeles: [
    { name: "Amélie (Inflow)", devise: "$" },
    { name: "Zoé (Inflow)", devise: "$" },
    { name: "Zoé (Uncove)", devise: "€" },
  ],
  chatteurs: {}, // userId -> shift
  sessions: {}, // userId -> { shift, clockIn, modeles, app }
  historique: [], // shifts terminés (pour /stats)
  admins: [], // userIds des admins du bot
  membres: {}, // userId -> { name, username } : noms affichés dans les menus et dans l'app
  planningMsgs: {}, // ancien planning du salon (date -> { channelId, ids }) : supprimé au premier message du salon box
  shiftMsgs: {}, // ancien panneau du salon clocking (« date|SHIFT » -> { channelId, ids }) : supprimé au démarrage
  boxMsg: null, // { channelId, id, key: « date|SHIFT », hash } : le message du salon box (en direct)
  boxNotes: [], // [{ channelId, id }] : annonces de box du shift, supprimées avec son message
  effMsgs: {}, // « date|shift » -> { channelId, id, hash } : récap de l'effectif (mis à jour en direct)
  penRecaps: {}, // quinzaine « 2026-10-A » -> { channelId, id, at } : récap des pénalités envoyé
  dayoffBoard: null, // { channelId, messageId, hash } : tableau du salon day off
  gestionPanel: null, // { channelId, messageId, hash } : panneau des admins du salon gestion
  appLinks: {}, // ancien lien /lien_app, recopié dans la fiche du chatteur de l'app au démarrage
};

let data = JSON.parse(JSON.stringify(DEFAULT_DATA));
function loadData() {
  try {
    data = { ...JSON.parse(JSON.stringify(DEFAULT_DATA)), ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
  } catch {
    data = JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}
function saveData() {
  data.savedAt = Date.now();
  writeLocal();
  backupSoon();
}
const writeLocal = () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
};
loadData();
// Copie de data.json dans l'app (docs bot/state), quelques secondes après la dernière écriture : sans volume
// Railway, data.json repart à zéro à chaque redéploiement (clock in en cours, admins, messages suivis…).
// L'historique n'y garde que les 7 derniers jours.
let backupTimer = null;
function backupSoon() {
  if (!appSync.enabled()) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    const since = Date.now() - 7 * 864e5;
    appSync
      .saveBotState({ ...data, historique: data.historique.filter((h) => (h.clockOut || h.clockIn) >= since) })
      .catch((e) => console.error("Copie de la mémoire du bot :", e.message));
  }, 3000);
  backupTimer.unref?.();
}
// Au démarrage : la copie de l'app si elle est plus récente que data.json (data.json perdu au redéploiement)
async function restoreData() {
  if (!appSync.enabled()) return false;
  try {
    const r = await appSync.loadBotState();
    if (!r || !(Number(r.savedAt) > Number(data.savedAt || 0))) return false;
    const key = (h) => `${h.userId}|${h.clockIn}`;
    const seen = new Set(data.historique.map(key));
    const hist = [...data.historique, ...(r.historique || []).filter((h) => !seen.has(key(h)))].sort((a, b) => a.clockIn - b.clockIn);
    data = { ...JSON.parse(JSON.stringify(DEFAULT_DATA)), ...r, historique: hist };
    writeLocal();
    console.log(`Mémoire du bot relue depuis l'app (enregistrée ${new Date(r.savedAt).toISOString()})`);
    return true;
  } catch (e) {
    console.error("Mémoire du bot (app) :", e.message);
    return false;
  }
}

// ================== HELPERS ==================
const fmtTime = (d) =>
  new Date(d).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const fmtDuration = (ms) => {
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
const fmtMoney = (n, devise) =>
  `${n.toLocaleString("fr-FR", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })} ${devise}`;
const modeleOf = (name) => data.modeles.find((m) => m.name === name);
const deviseOf = (name) => modeleOf(name)?.devise || "$";
const needsFiche = (name) => FICHE_MODELES.test(`${name} ${modeleOf(name)?.app || ""}`);
const shiftTxt = (shift) => `${SHIFTS[shift]?.emoji || ""} Shift ${shift} (${SHIFTS[shift]?.label || "?"})`;
const mentions = (ids) => ids.map((u) => `<@${u}>`).join(", ");
const modelesTxt = (names) => names.map(withEmoji).join(", ");
// Shift en cours à l'instant t (heure de Paris)
const shiftAt = (t) => SHIFT_ORDER.find((k) => (appSync.parisParts(t).h - SHIFTS[k].start + 24) % 24 < 6);
const SHIFT_OF_SLOT = Object.fromEntries(Object.entries(appSync.SLOT_OF).map(([k, v]) => [v, k]));
// Shift sur lequel est vraiment un chatteur clock in : celui du clock in, ou le suivant s'il fait un double shift
function liveShift(s, t = Date.now()) {
  const cur = shiftAt(t);
  const covers = cur !== s.shift && (s.app?.extra || []).some((e) => e.key.startsWith(appSync.SLOT_OF[cur] + "_"));
  return covers ? cur : s.shift;
}
// Ce shift est en cours ou commence dans l'heure et demie
const nearShift = (k, t) => {
  const p = appSync.parisParts(t);
  const m = (((p.h * 60 + p.mi - SHIFTS[k].start * 60) % 1440) + 1440) % 1440;
  return m < 360 || m >= 1440 - 90;
};
// « Zoé (Inflow) » -> « zoe inflow »
const kNorm = (s) =>
  String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const namesOf = (i) => [i.member?.displayName || i.member?.nick, i.user.globalName, i.user.username].filter(Boolean);

// Vérifie si l'utilisateur est admin (admin Discord OU admin du bot)
function isAdmin(i) {
  return (
    i.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    data.admins.includes(i.user.id)
  );
}
const ADMIN_PERM = PermissionFlagsBits.Administrator;


// ---------- Noms des membres (menus, listes, onglet Équipe de l'app) ----------
const nameOf = (u) => data.membres[u]?.name || `membre …${String(u).slice(-4)}`;
function remember(user, member) {
  if (!user || user.bot) return;
  const name = member?.displayName || member?.nick || user.globalName || user.username;
  const prev = data.membres[user.id];
  if (prev && prev.name === name && prev.username === user.username) return;
  data.membres[user.id] = { name, username: user.username };
  saveData();
  if (data.chatteurs[user.id]) publishMembers();
}
async function resolveNames() {
  const ids = [...new Set([...Object.keys(data.chatteurs), ...data.admins])].filter((u) => !data.membres[u]);
  if (!ids.length) return;
  const guild = await client.guilds.fetch(GUILD_ID);
  for (const u of ids) {
    try {
      const m = await guild.members.fetch(u);
      data.membres[u] = { name: m.displayName, username: m.user.username };
    } catch {
      const usr = await client.users.fetch(u).catch(() => null);
      if (usr) data.membres[u] = { name: usr.globalName || usr.username, username: usr.username };
    }
  }
  saveData();
}
// La liste des chatteurs du bot, envoyée à l'app pour relier chaque compte Discord à son chatteur
let pubTimer = null;
function publishMembers() {
  if (!appSync.enabled()) return;
  clearTimeout(pubTimer);
  pubTimer = setTimeout(() => {
    const members = Object.fromEntries(
      Object.entries(data.chatteurs).map(([u, shift]) => [u, { name: nameOf(u), username: data.membres[u]?.username || "", shift }])
    );
    appSync.publishMembers(members).catch((e) => console.error("Liste Discord -> app :", e.message));
  }, 1500);
}

// Brouillons en mémoire
const outDraft = new Map(); // userId -> { modeles }
const opening = new Set(); // clock in en cours (évite le double clic)
const picks = new Map(); // `${userId}:${menu}` -> état d'un menu admin
const closing = new Set(); // clock out en cours (évite le double clic)

// GuildVoiceStates : arrivées et départs des vocaux
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

// ================== COMPOSANTS ==================
// Boutons des chatteurs, en bas du message du salon box
const clockInRow = (shift, ...more) =>
  row(button(`btn_clockin_${shift}`, "Clock In", "✅", ButtonStyle.Success), button("btn_clockout", "Clock Out", "🔴", ButtonStyle.Danger), ...more);

// Clock out : confirmation (évite un clic de travers), puis fiche de ventes si une de ses modèles en a une
const ficheModeles = (d) => d.modeles.filter(needsFiche).slice(0, 5);
function clockOutView(uid) {
  const s = data.sessions[uid];
  const d = outDraft.get(uid);
  const fiche = ficheModeles(d);
  return {
    content: [
      `🔴 **Clock out · Shift ${s.shift}**, arrivé à ${fmtTime(s.clockIn)} (${fmtDuration(Date.now() - s.clockIn)})${d.modeles.length ? ` · ${modelesTxt(d.modeles)}` : ""}`,
      fiche.length ? `📝 Fiche de ventes à remplir pour **${modelesTxt(fiche)}**.` : "Tu confirmes la fin de ton shift ?",
    ].join("\n"),
    components: [
      row(
        fiche.length
          ? button("co_go", "Remplir la fiche et terminer", "📝", ButtonStyle.Primary)
          : button("co_go", "Terminer mon shift", "🔴", ButtonStyle.Danger),
        button("co_cancel", "Annuler", null, ButtonStyle.Secondary)
      ),
    ],
  };
}

// Fiche de fin de shift : ventes + tips par modèle (5 champs max dans une fenêtre Discord)
function ficheModal(models) {
  const short = (n) => (withEmoji(n).length > 20 ? withEmoji(n).slice(0, 19) + "…" : withEmoji(n));
  const input = (id, label, ph, required) =>
    row(new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(ph).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(20));
  const rows = [];
  if (models.length <= 2)
    models.forEach((n, k) => {
      const pre = models.length > 1 ? `${short(n)} · ` : "";
      rows.push(input(`v_${k}`, `${pre}Ventes (${deviseOf(n)})`, "ex : 185", true));
      rows.push(input(`t_${k}`, `${pre}Tips (${deviseOf(n)})`, "ex : 20 (vide = 0)", false));
    });
  else models.forEach((n, k) => rows.push(input(`vt_${k}`, `${short(n)} · ventes / tips`, "ex : 185 / 20", true)));
  const title = models.length === 1 ? `Fiche · ${withEmoji(models[0])}` : "Fiche de fin de shift";
  return new ModalBuilder().setCustomId("co_fiche").setTitle(title.slice(0, 45)).addComponents(...rows);
}
// « 1 234,50 € » -> 1234.5 ; vide -> 0 ; invalide -> NaN
function parseAmount(s) {
  const t = String(s || "").replace(/[\s€$]/g, "").replace(",", ".");
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
}

// Une seule ligne : « ✅ @Kelly Clock in 02:01 · 🌙 NUIT · Anna 🍑 (Telegram) · ⏰ 12 min de retard »
function clockLine(kind, uid, s, t, late = 0) {
  const sh = SHIFTS[s.shift] || {};
  return [
    kind === "in" ? `✅ <@${uid}> **Clock in** ${fmtTime(t)}` : `🔴 <@${uid}> **Clock out** ${fmtTime(t)}`,
    `${sh.emoji || ""} ${s.shift}`,
    kind === "out" ? fmtDuration(t - s.clockIn) : "",
    modelesTxt(s.modeles),
    late ? `⏰ ${late} min de retard` : "",
  ].filter(Boolean).join(" · ");
}
// Fiche simplifiée du salon ventes : chatteur, modèle, ventes, tips, total
function ficheEmbed(uid, v) {
  const d = deviseOf(v.modele);
  return new EmbedBuilder()
    .setColor(0xd63a3a)
    .setTitle(`💰 ${withEmoji(v.modele)}`)
    .setDescription(`<@${uid}>`)
    .addFields(
      { name: "Ventes", value: fmtMoney(v.montant, d), inline: true },
      { name: "Tips", value: fmtMoney(v.tips, d), inline: true },
      { name: "Total", value: `**${fmtMoney(v.montant + v.tips, d)}**`, inline: true }
    );
}

// ================== ANNONCES AUTO ==================
const hashOf = (payloads) =>
  crypto.createHash("md5").update(JSON.stringify(payloads.map((p) => ({ ...p, components: (p.components || []).map((c) => c.toJSON()) })))).digest("hex");
const whoOf = (c) => (c.discordId ? `<@${c.discordId}>` : `**${c.name}**`);
const idsOf = (m) => m.ids || (m.id ? [m.id] : []);
async function delAll(channelId, ids) {
  if (!ids.length) return;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  for (const id of ids) await ch?.messages.delete(id).catch(() => {});
}
// Les panneaux de l'ancien salon clocking (avant le salon box unique) : supprimés au démarrage
async function dropClockingPanels() {
  if (!Object.keys(data.shiftMsgs || {}).length) return;
  for (const m of Object.values(data.shiftMsgs)) await delAll(m.channelId, idsOf(m));
  data.shiftMsgs = {};
  saveData();
}

// ---------- Salon box : le seul salon des shifts ----------
// Un seul message : le shift en cours, en grand, par modèle (« 1️⃣ ✅ @Jean », les box libres aussi) et le pointage, en
// direct. 15 min avant chaque shift il est remplacé par celui du shift suivant. 🛠️ Admin (la gestion du shift, pour
// l'admin seul) en haut à droite ; en bas Clock In / Clock Out et ✏️ Modifier le shift (la fenêtre avec toutes les modèles). Les annonces du shift (clock in, clock out, coupure, retour, changements de box ou de shift, aussi
// ceux faits dans l'app) s'écrivent dans ce salon et partent avec son message, au shift suivant.
async function boxView(name, date) {
  const sh = SHIFTS[name];
  const slot = appSync.SLOT_OF[name];
  const b = await shiftBoard(name, date);
  const byId = Object.fromEntries(b.staff.map((p) => [p.id, p]));
  const { groups, count } = planning.slotGroups(b.day, slot);
  const who = (x) => {
    const k = b.stOf(byId[x.id] || { ...x.c, off: x.off });
    return `${k === "off" ? "🏖️" : ST[k].e} ${whoOf(x.c)}`;
  };
  const { head, extra, done, due } = boardLines(b);
  const top = [
    `## 📦 Box · ${sh.emoji} ${name} · ${sh.label}`,
    `-# ${planning.dayLabel(date)} · en direct, change tout seul 15 min avant chaque shift`,
    due ? `-# **${done}/${due}** pointés · ${head[1]}` : "",
  ].filter(Boolean).join("\n");
  const items = [{ text: top, button: button(`g_menu~${date}~${slot}`, "Admin", "🛠️", ButtonStyle.Secondary) }];
  if (!groups.length) items.push({ text: "_Personne au planning sur ce shift._" });
  for (const g of groups) {
    const held = new Map(); // box -> chatteurs
    const none = [];
    for (const x of g.people) {
      if (!x.boxes.length) none.push(x);
      for (const k of x.boxes) held.set(k, [...(held.get(k) || []), x]);
    }
    const n = Math.max(Number(b.day.nbox?.[`${slot}|${g.mid}`]) || 0, ...[...held.keys()].filter(planning.isNum).map(Number), 0);
    const lines = [];
    if (held.has("all")) lines.push(`### ${planning.boxesE(["all"])} ${held.get("all").map(who).join(" · ")}`);
    for (let k = 1; k <= n; k++) {
      const hs = held.get(String(k)) || [];
      lines.push(`### ${planning.boxesE([String(k)])} ${hs.length ? hs.map(who).join(" · ") : "⬜ libre"}`);
    }
    if (held.has("vip")) lines.push(`### ${planning.VIP} ${held.get("vip").map(who).join(" · ")}`);
    if (none.length) lines.push(`-# Sans box : ${none.map(who).join(", ")}`);
    items.push({ sep: true }, { text: `## ${planning.modelHead(g)}`, keep: true }, { text: lines.join("\n") });
  }
  if (extra.length) items.push({ sep: true }, { text: `➕ En plus (pas au planning) : ${extra.map((u) => `<@${u}>`).join(", ")}` });
  const rows = [clockInRow(name, button(`pm_open~${date}~${slot}`, "Modifier le shift", "✏️", ButtonStyle.Primary))];
  // un seul message : s'il déborde (très rare), la fin est coupée
  const [view, ...more] = v2Messages(items, { color: sh.color, rows });
  if (more.length) view.components.push(...rows);
  return { view, count };
}
async function postBoxBoard(name, t = Date.now()) {
  if (!appSync.enabled()) return null;
  const date = appSync.shiftDay(appSync.SLOT_OF[name], t + 15 * 60e3).date;
  const { view, count } = await boxView(name, date);
  const ch = await client.channels.fetch(BOX_CHANNEL_ID);
  const msg = await ch.send(view);
  const old = data.boxMsg;
  const key = `${date}|${name}`;
  if (old?.id && old.id !== msg.id) await delAll(old.channelId, [old.id]);
  // les annonces du shift d'avant partent avec lui (renvoyé pour le même shift : elles restent) ; l'ancien planning aussi
  const next = old?.key !== key;
  if (next) for (const x of data.boxNotes || []) await delAll(x.channelId, [x.id]);
  for (const p of Object.values(data.planningMsgs || {})) await delAll(p.channelId, p.ids || []);
  Object.assign(data, { planningMsgs: {}, boxNotes: next ? [] : data.boxNotes || [], boxMsg: { channelId: ch.id, id: msg.id, key, hash: hashOf([view]) } });
  saveData();
  return { url: msg.url, count };
}
// Un seul envoi à la fois (l'heure du shift et la vérification de chaque minute peuvent tomber ensemble)
let boxBusy = Promise.resolve();
const boxLock = (f) => (boxBusy = boxBusy.catch(() => {}).then(f));
// Le message du salon box est celui du shift en cours (ou qui commence dans les 15 min) : sinon il est renvoyé
function ensureBoxBoard(t = Date.now()) {
  return boxLock(async () => {
    if (!appSync.enabled()) return null;
    const name = shiftAt(t + 15 * 60e3);
    const key = `${appSync.shiftDay(appSync.SLOT_OF[name], t + 15 * 60e3).date}|${name}`;
    if (data.boxMsg?.key === key) return null;
    // un shift à venir envoyé depuis l'app reste affiché jusqu'à son tour
    if (data.boxMsg?.hold && t < data.boxMsg.hold) return null;
    return postBoxBoard(name, t);
  });
}
// Les anciens « Envoyer le planning » (bouton de l'app, menus) : renvoient le message du salon box
const postPlanning = () => boxLock(() => postBoxBoard(shiftAt(Date.now() + 15 * 60e3)));
// « Envoyer le shift » de l'app (shift choisi) : son message dans le salon box, en bas. Un shift à venir y reste jusqu'à
// son tour (15 min avant son début, comme d'habitude).
async function postShift(date, slot) {
  const name = SHIFT_OF_SLOT[slot];
  if (!SHIFTS[name]) throw new Error(`Shift inconnu : ${slot}`);
  const at = appSync.parisMs(date, SHIFTS[name].start) - 15 * 60e3;
  await appSync.fillDays([date]);
  return boxLock(async () => {
    const r = await postBoxBoard(name, at);
    if (at > Date.now() && data.boxMsg) {
      data.boxMsg.hold = at;
      saveData();
    }
    return r;
  });
}
// Jours encore vides (aujourd'hui, demain) remplis depuis le planning habituel de l'app
async function fillAhead() {
  if (!appSync.enabled()) return;
  const d = appSync.parisParts(Date.now()).date;
  try {
    const l = await appSync.fillDays([d, appSync.addDays(d, 1)]);
    if (l.length) console.log(`Planning rempli depuis le planning habituel : ${l.join(", ")}`);
  } catch (e) {
    console.error("Planning habituel :", e.message);
  }
}
async function refreshBox(date) {
  const m = data.boxMsg;
  if (!m?.id || m.key.slice(0, 10) !== date || !SHIFTS[m.key.slice(11)]) return;
  const { view } = await boxView(m.key.slice(11), date);
  const hash = hashOf([view]);
  if (hash === m.hash) return;
  try {
    const ch = await client.channels.fetch(m.channelId);
    await ch.messages.edit(m.id, view);
    m.hash = hash;
  } catch (e) {
    console.warn("Salon box à mettre à jour :", e.message);
    if (/unknown message/i.test(e.message)) data.boxMsg = null; // supprimé à la main : renvoyé dans la minute
  }
  saveData();
}
// 🔔 Renvoyer le panneau (/panel, 🛠️ Admin) : le message du salon box de ce shift, renvoyé en bas du salon
function announceShift(name, t = Date.now()) {
  return postShift(appSync.shiftDay(appSync.SLOT_OF[name], t + 15 * 60e3).date, appSync.SLOT_OF[name]);
}
// Annonces du shift (clock in, clock out, coupure, retour, changements de box ou de shift) : salon box, supprimées
// avec son message au shift suivant
async function boxNote(payload) {
  const ch = await client.channels.fetch(BOX_CHANNEL_ID);
  const msg = await ch.send(payload);
  (data.boxNotes ||= []).push({ channelId: ch.id, id: msg.id });
  saveData();
  return msg;
}

// 15 min avant chaque shift (heure de Paris) : son message dans le salon box
for (const [name, sh] of Object.entries(SHIFTS)) {
  const hour = (sh.start - 1 + 24) % 24; // 15 min avant => hh-1:45
  cron.schedule(`45 ${hour} * * *`, async () => {
    await fillAhead();
    ensureBoxBoard().catch((e) => console.error("Salon box :", e.message));
  }, { timezone: TZ });
}

// ================== EFFECTIF (quelques minutes après le début de chaque shift) ==================
// Membres qui ont fait clock in sur ce shift (en cours ou terminé), et ceux encore là depuis le shift
// d'avant (double shift : un seul clock in pour les deux)
function clockInsOf(name, date) {
  const slot = appSync.SLOT_OF[name];
  const start = appSync.parisMs(date, SHIFTS[name].start);
  const same = (t) => Math.abs(t - start) < 12 * 3600e3 && appSync.shiftDay(slot, t).date === date;
  const seen = new Set([
    ...data.historique.filter((h) => h.shift === name && same(h.clockIn)).map((h) => h.userId),
    ...Object.entries(data.sessions).filter(([, s]) => s.shift === name && same(s.clockIn)).map(([uid]) => uid),
  ]);
  const covering = new Set([
    ...data.historique.filter((h) => appSync.coversSlot(h.clockIn, h.clockOut, start)).map((h) => h.userId),
    ...Object.entries(data.sessions).filter(([, s]) => appSync.coversSlot(s.clockIn, null, start)).map(([uid]) => uid),
  ]);
  return { seen, covering };
}
// Qui est là sur ce shift, sur combien de prévus, et qui manque
async function effectifView(name, date) {
  const sh = SHIFTS[name];
  const slot = appSync.SLOT_OF[name];
  const { seen, covering } = clockInsOf(name, date);
  // prévus : planning de l'app (hors day off), sinon les chatteurs du bot sur ce shift
  let staff = appSync.enabled() ? await appSync.slotStaff(date, slot) : [];
  if (!staff.length) staff = Object.keys(data.chatteurs).filter((u) => data.chatteurs[u] === name).map((u) => ({ discordId: u, name: nameOf(u) }));
  const due = staff.filter((p) => !p.off);
  // box devant le nom, comme le message de début de shift : « [1] @Kelly · 🍑 » (une ligne par modèle)
  const models = appSync.enabled() && due.some((p) => p.boxes) ? (await appSync.appCatalog()).models : {};
  const mName = (mid) => models[mid]?.name || mid;
  const tag = (p) => (p.discordId ? `<@${p.discordId}>` : `**${p.name}**`);
  const boxRank = (l) => (l.length ? planning.BOX_ORDER.indexOf(l[0]) : 99);
  const linesOf = (list) =>
    list
      .flatMap((p) => {
        const mids = Object.keys(p.boxes || {});
        return mids.length ? mids.map((mid) => ({ p, mid, l: planning.boxList(p.boxes[mid]) })) : [{ p, mid: "", l: [] }];
      })
      .sort((a, b) => (!a.mid) - (!b.mid) || mName(a.mid).localeCompare(mName(b.mid), "fr") ||
        boxRank(a.l) - boxRank(b.l) || a.p.name.localeCompare(b.p.name, "fr"))
      .map(({ p, mid, l }) => `${tag(p)}${mid ? ` · ${planning.modelMark(mName(mid))}` : ""}${l.length ? ` ${planning.boxLabel(l)}` : ""}`);
  // présent : clock in sur Discord (ou encore là depuis le shift d'avant), ou pointé présent / retard / coupure
  const isHere = (p) => seen.has(p.discordId) || covering.has(p.discordId) || ["present", "retard", "coupure"].includes(p.mark?.status);
  const here = linesOf(due.filter(isHere));
  const missing = linesOf(due.filter((p) => !isHere(p)));
  // clock in sur ce shift sans être prévu : listés avec les présents, sans compter dans le total
  const dueIds = new Set(due.map((p) => p.discordId));
  const extra = [...seen].filter((u) => !dueIds.has(u)).map((u) => `<@${u}> (en plus)`);
  const n = due.filter(isHere).length, total = due.length;
  const embed = new EmbedBuilder()
    .setColor(!total ? 0x8a8f98 : n >= total ? 0x5bae8c : n ? 0xe0ae4e : 0xd63a3a)
    .setTitle(`👥 Effectif ${sh.emoji} ${name} · ${n}/${total}`);
  // en description (4096 caractères) : les emojis de box prennent de la place, un champ n'en a que 1024
  const parts = [];
  if (here.length || extra.length) parts.push(`**✅ Présents**\n${fit([...here, ...extra], 2000)}`);
  if (missing.length) parts.push(`**❌ Manquants**\n${fit(missing, 1900)}`);
  embed.setDescription(parts.join("\n\n") || "_Personne de prévu sur ce shift._");
  return { embeds: [embed], components: [row(button(`eff_${name}_${date}`, "Actualiser", "🔄", ButtonStyle.Secondary))], allowedMentions: { parse: [] } };
}
async function postEffectif(name) {
  const { date } = appSync.shiftDay(appSync.SLOT_OF[name], Date.now());
  const v = await effectifView(name, date);
  // dans le salon box : parti avec le message du shift ; mis à jour en direct d'ici là (clock in, remplacement, box…)
  const msg = await boxNote(v);
  data.effMsgs ||= {};
  data.effMsgs[`${date}|${name}`] = { channelId: data.boxNotes.at(-1).channelId, id: msg.id, hash: hashOf([v]) };
  const limit = appSync.addDays(appSync.parisParts(Date.now()).date, -2);
  for (const k of Object.keys(data.effMsgs)) if (k.slice(0, 10) < limit) delete data.effMsgs[k];
  saveData();
}
async function refreshEffectifs(date) {
  for (const [k, m] of Object.entries(data.effMsgs || {})) {
    const [d, name] = k.split("|");
    if (d !== date || !SHIFTS[name]) continue;
    const v = await effectifView(name, d);
    const hash = hashOf([v]);
    if (hash === m.hash) continue;
    try {
      const ch = await client.channels.fetch(m.channelId);
      await ch.messages.edit(m.id, v);
      m.hash = hash;
    } catch (e) {
      console.warn("Effectif à mettre à jour :", e.message);
      if (/unknown message/i.test(e.message)) delete data.effMsgs[k];
    }
    saveData();
  }
}
if (EFFECTIF_APRES > 0)
  for (const [name, sh] of Object.entries(SHIFTS)) {
    const m = sh.start * 60 + EFFECTIF_APRES;
    cron.schedule(`${m % 60} ${Math.floor(m / 60) % 24} * * *`, () => postEffectif(name).catch((e) => console.error("Effectif :", e.message)), { timezone: TZ });
  }

// ================== POINTAGE EN DIRECT (salon gestion) ==================
// Le shift en cours comme Pointage dans l'app : qui est là, en retard, en coupure, absent, pas encore là
// durée : « 42 min », « 2h10 », « 2h »
const dur = (min) => {
  const n = Math.max(0, Math.round(Number(min) || 0));
  return n < 60 ? `${n} min` : `${Math.floor(n / 60)}h${n % 60 ? String(n % 60).padStart(2, "0") : ""}`;
};
const ST = {
  present: { e: "✅", sq: "🟩", l: "présent" }, retard: { e: "🟠", sq: "🟧", l: "retard" }, coupure: { e: "⚡", sq: "🟦", l: "coupure" },
  absent: { e: "❌", sq: "🟥", l: "absent" }, todo: { e: "⭕", sq: "⬜", l: "à pointer" },
};
// État d'un shift : prévus, pointage de l'app, clock in Discord (y compris le double shift)
async function shiftBoard(name, date) {
  const slot = appSync.SLOT_OF[name];
  const [day, staff] = await Promise.all([appSync.planningDay(date), appSync.slotStaff(date, slot)]);
  const { seen, covering } = clockInsOf(name, date);
  const here = (p) => seen.has(p.discordId) || covering.has(p.discordId);
  // revenu de sa coupure : de nouveau ✅, la coupure reste écrite à droite de son nom (pas revenu avant la fin du shift : ⚡)
  const backFromCut = (m) => m?.status === "coupure" && m.cutAt && m.cutEnd && !m.noBack;
  const stOf = (p) =>
    p.off ? "off" : backFromCut(p.mark) ? "present" : ST[p.mark?.status] && !(p.mark.status === "absent" && here(p)) ? p.mark.status : here(p) ? "present" : "todo";
  const detail = (p) => {
    const m = p.mark || {}, s = p.discordId && data.sessions[p.discordId];
    const k = stOf(p);
    const inT = m.in || s?.clockIn;
    const bits = [];
    if (k === "off") bits.push("day off");
    else if (k === "todo") bits.push("pas encore là");
    else if (k === "present") bits.push(covering.has(p.discordId) && !seen.has(p.discordId) ? `double shift, là depuis ${inT ? fmtTime(inT) : "le shift d'avant"}` : inT ? `arrivé ${fmtTime(inT)}` : "présent");
    else if (k === "retard") bits.push(`retard ${m.min || "?"} min`);
    else if (k === "coupure")
      bits.push(
        m.cutAt && !m.cutEnd
          ? `en coupure depuis ${fmtTime(m.cutAt)}${Date.now() - m.cutAt >= 60e3 ? ` · ${dur((Date.now() - m.cutAt) / 60e3)}` : ""}`
          : m.noBack && m.cutAt
            ? `coupure depuis ${fmtTime(m.cutAt)}, pas revenu avant la fin du shift · ${dur(Math.round((m.cutEnd - m.cutAt) / 60e3))}`
            : `coupure ${m.min ? dur(m.min) : ""}`.trim()
      );
    if (backFromCut(m)) {
      const last = Math.round((m.cutEnd - m.cutAt) / 60e3);
      bits.push(`coupure ${fmtTime(m.cutAt)} → ${fmtTime(m.cutEnd)} : ${dur(last)}${Number(m.min) > last ? ` (${dur(m.min)} au total)` : ""}`);
    }
    else if (k === "absent") bits.push("absent");
    if (m.out && k !== "off") bits.push(`parti ${fmtTime(m.out)}`);
    if (m.note) bits.push(`« ${m.note} »`);
    return bits.join(" · ");
  };
  return { name, slot, date, day, staff, seen, covering, stOf, detail };
}
async function pointageEmbed(t = Date.now()) {
  const name = shiftAt(t);
  const sh = SHIFTS[name];
  const b = await shiftBoard(name, appSync.shiftDay(appSync.SLOT_OF[name], t).date);
  const { head, lines, extra } = boardLines(b);
  return {
    title: `${sh.emoji} Pointage · ${name} ${sh.label} · ${planning.dayLabel(b.date)}`,
    color: sh.color,
    description: [...head, "", ...lines, ...(extra.length ? ["", `➕ En plus (pas au planning) : ${extra.map((u) => `<@${u}>`).join(", ")}`] : [])].join("\n").slice(0, 4000),
    footer: { text: "En direct, relié au Pointage de l'app · boutons réservés aux admins" },
  };
}
// Un shift comme Pointage dans l'app : compteur, barre, puis par modèle une ligne par chatteur
// « ✅ @Amour · Box : 1️⃣ · arrivé 19:52 », rangés par box
function boardLines(b) {
  const { slot, day, staff, seen, stOf, detail } = b;
  const byId = Object.fromEntries(staff.map((p) => [p.id, p]));
  // une ligne par chatteur et par modèle, rangés par box (comme le message de début de shift)
  const lines = [];
  for (const g of planning.slotGroups(day, slot).groups) {
    lines.push(planning.modelHead(g));
    for (const x of g.people) {
      const p = byId[x.id] || { ...x.c, off: x.off };
      const k = stOf(p);
      lines.push(`${k === "off" ? "🏖️" : ST[k].e} ${x.c.discordId ? `<@${x.c.discordId}>` : `**${x.c.name}**`}${x.boxes.length ? ` · ${planning.boxLabel(x.boxes)}` : ""} · ${detail(p)}`);
    }
  }
  const due = staff.filter((p) => !p.off);
  const n = Object.fromEntries(Object.keys(ST).map((k) => [k, due.filter((p) => stOf(p) === k).length]));
  const done = due.length - n.todo;
  // barre comme dans l'app : une case par chatteur (15 max)
  const scale = due.length > 15 ? 15 / due.length : 1;
  const bar = ["present", "retard", "coupure", "absent", "todo"].map((k) => ST[k].sq.repeat(Math.round(n[k] * scale))).join("");
  const dueIds = new Set(due.map((p) => p.discordId).filter(Boolean));
  const extra = [...seen].filter((u) => !dueIds.has(u) && !staff.some((p) => p.discordId === u));
  const head = due.length
    ? [`**${done}/${due.length}** pointés  ${bar}`, ["present", "retard", "coupure", "absent", "todo"].filter((k) => n[k]).map((k) => `${ST[k].e} ${n[k]} ${ST[k].l}${n[k] > 1 && k !== "todo" ? "s" : ""}`).join(" · ")]
    : ["_Personne au planning sur ce shift._"];
  return { head, lines, extra, done, due: due.length };
}

// Après un changement : salon box (regroupé, 1,5 s après le dernier)
const refreshTimers = new Map();
function refreshSoon(date) {
  clearTimeout(refreshTimers.get(date));
  refreshTimers.set(date, setTimeout(() => {
    refreshTimers.delete(date);
    refreshDate(date).catch((e) => console.error("Mise à jour du planning :", e.message));
  }, 1500));
}
// Tout ce qui montre ce jour-là : salon box, effectif
async function refreshDate(date) {
  await refreshBox(date);
  await refreshEffectifs(date);
  gestion.panelSoon();
}
// Toutes les minutes : les changements faits dans l'app arrivent sur Discord
let liveBusy = false;
async function refreshLive() {
  if (liveBusy || !appSync.enabled()) return;
  liveBusy = true;
  try {
    const from = appSync.addDays(appSync.parisParts(Date.now()).date, -1);
    const dates = new Set([data.boxMsg?.key || "", ...Object.keys(data.shiftMsgs), ...Object.keys(data.effMsgs || {})].map((k) => k.slice(0, 10)).filter((d) => d >= from));
    for (const d of dates) await refreshDate(d).catch((e) => console.error(`Planning du ${d} :`, e.message));
    await ensureBoxBoard().catch((e) => console.error("Salon box :", e.message));
    await gestion.ensurePanel().catch((e) => console.error("Panneau gestion :", e.message));
  } finally {
    liveBusy = false;
  }
}
// « demain », « 23/10 », « 2026-10-23 » -> « 2026-10-23 »
function parseDay(s) {
  const q = kNorm(s);
  const today = appSync.parisParts(Date.now()).date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(s).trim())) return String(s).trim();
  if (!q || q.startsWith("auj")) return today;
  if (q.startsWith("apres dem")) return appSync.addDays(today, 2);
  if (q.startsWith("dem")) return appSync.addDays(today, 1);
  if (q.startsWith("hier")) return appSync.addDays(today, -1);
  const m = q.match(/^(\d{1,2}) (\d{1,2})(?: (\d{2,4}))?$/);
  if (!m) return null;
  let y = m[3] ? +m[3] : +today.slice(0, 4);
  if (y < 100) y += 2000;
  const iso = `${y}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
  const ok = new Date(iso + "T12:00:00Z").toISOString().slice(0, 10) === iso;
  if (!ok) return null;
  // « 03/01 » tapé en décembre : janvier de l'année suivante
  return !m[3] && iso < appSync.addDays(today, -180) ? `${y + 1}${iso.slice(4)}` : iso;
}
function dayChoices(query) {
  const today = appSync.parisParts(Date.now()).date;
  const rel = { 0: "Aujourd'hui", 1: "Demain", "-1": "Hier" };
  const list = [0, 1, 2, 3, 4, 5, 6, 7, -1].map((n) => {
    const d = appSync.addDays(today, n);
    return { name: `${rel[n] ? rel[n] + " · " : ""}${planning.dayLabel(d)}`, value: d };
  });
  const q = kNorm(query);
  const typed = q && parseDay(query);
  const hits = list.filter((c) => !q || kNorm(c.name).includes(q) || c.value === typed);
  if (typed && !hits.some((c) => c.value === typed)) hits.unshift({ name: planning.cap(planning.dayLabel(typed)), value: typed });
  return hits.slice(0, 25);
}

// Demande d'envoi faite depuis l'app (bouton « Envoyer le shift » de Planning) : le shift choisi (panneau et box) ;
// une ancienne demande sans shift renvoie le message du salon box (shift en cours)
let polling = false;
async function pollPost() {
  if (polling || !appSync.enabled()) return;
  polling = true;
  try {
    const req = await appSync.pendingPost();
    if (req) {
      let patch;
      if (Date.now() - num(req.at) > 30 * 60e3)
        patch = { status: "error", error: "Demande trop ancienne (le bot était hors ligne) : renvoie-la." };
      else
        try {
          const r = req.slot ? await postShift(req.date, req.slot) : await postPlanning(req.date);
          patch = { status: "done", doneAt: Date.now(), url: r?.url || "", count: r?.count || 0 };
          console.log(`${req.slot ? `Shift ${req.slot}` : "Planning"} du ${req.date} envoyé (demandé depuis l'app)`);
        } catch (e) {
          patch = { status: "error", error: String(e.message || e).slice(0, 200) };
        }
      await appSync.finishPost(req, patch);
    }
  } catch (e) {
    console.error("Envoi du planning :", e.message);
  }
  polling = false;
}
const num = (x) => Number(x) || 0;

// Absents automatiques (et rattrapage des pointages qui n'ont pas pu s'écrire au clock in)
let sweeping = false;
// Clock out oublié : 4 h après la fin de son shift (le dernier, en double shift), le bot le fait à sa place, à l'heure
// de fin du shift (sans fiche de ventes) ; une ligne dans le salon box le dit
const AUTO_OUT_H = Number(process.env.AUTO_CLOCKOUT_H ?? 4);
function sessionEnd(s) {
  const slotOf = (key) => key.slice(0, key.indexOf("_"));
  const shifts = s.app?.key ? [{ date: s.app.date, key: s.app.key }, ...(s.app.extra || [])].map((x) => ({ date: x.date, slot: slotOf(x.key) })) : [];
  const slot = appSync.SLOT_OF[s.shift];
  if (!shifts.length && slot) shifts.push({ date: appSync.shiftDay(slot, s.clockIn).date, slot });
  const ends = shifts.map((x) => appSync.shiftEnd(x.date, x.slot)).filter(Number.isFinite);
  return ends.length ? Math.max(s.clockIn, ...ends) : null;
}
async function autoClockOuts(now = Date.now()) {
  if (!(AUTO_OUT_H > 0)) return [];
  const done = [];
  for (const [uid, s] of Object.entries(data.sessions)) {
    const end = sessionEnd(s);
    if (end == null || now < end + AUTO_OUT_H * 3600e3 || closing.has(uid)) continue;
    delete data.sessions[uid];
    outDraft.delete(uid);
    data.historique.push({ userId: uid, shift: s.shift, clockIn: s.clockIn, clockOut: end, modeles: s.modeles, ventes: [], auto: true });
    saveData();
    console.log(`Clock out automatique : ${nameOf(uid)} (${s.shift}), à ${fmtTime(end)}`);
    await boxNote({ content: `${clockLine("out", uid, s, end)} · automatique, pas de clock out ${AUTO_OUT_H} h après la fin du shift`, allowedMentions: { parse: [] } })
      .catch((e) => console.error("Clock out automatique (salon box) :", e.message));
    await appSync.onClockOut({ app: s.app, t: end }).catch((e) => console.error("Pointage app (clock out automatique) :", e.message));
    if (s.app?.date) refreshSoon(s.app.date);
    done.push({ uid, end });
  }
  return done;
}

async function sweep() {
  if (sweeping) return;
  await autoClockOuts().catch((e) => console.error("Clock out automatique :", e.message));
  if (!appSync.enabled()) return;
  sweeping = true;
  try {
    // double shift : encore clock in au début d'un autre shift prévu ce jour-là -> présent aussi sur celui-là
    const live = Object.entries(data.sessions)
      .filter(([, s]) => s.app?.key)
      .map(([uid, s]) => ({ uid, cid: s.app.cid || s.app.key.slice(s.app.key.indexOf("_") + 1), t: s.clockIn }));
    let moved = false;
    const touched = new Set();
    for (const x of await appSync.coverShifts({ sessions: live })) {
      touched.add(x.date);
      const s = data.sessions[x.uid];
      if (!s?.app || (s.app.key === x.key && s.app.date === x.date)) continue;
      s.app.extra = [...(s.app.extra || []).filter((e) => e.key !== x.key || e.date !== x.date), { date: x.date, key: x.key }];
      moved = true;
      console.log(`Double shift : ${nameOf(x.uid)} présent aussi en ${x.slot} du ${x.date}`);
    }
    if (moved) saveData();
    const since = Date.now() - 2 * 864e5;
    const clockIns = [
      ...Object.entries(data.sessions).map(([uid, s]) => ({ uid, shift: s.shift, t: s.clockIn, out: null })),
      ...data.historique.filter((h) => h.clockIn >= since).map((h) => ({ uid: h.userId, shift: h.shift, t: h.clockIn, out: h.clockOut })),
    ];
    for (const x of await appSync.sweepAbsents({ clockIns })) {
      touched.add(x.date);
      console.log(`Pointage auto : ${x.name} ${x.status} (${x.slot} du ${x.date})`);
    }
    // coupure sans 🔙 retour à la fin du shift : il n'a pas pu revenir, fermée à l'heure de fin
    for (const x of await appSync.closeStaleCoupures()) {
      touched.add(x.date);
      console.log(`Coupure sans retour : ${x.chatterId} (${x.slot} du ${x.date}), ${x.took} min jusqu'à la fin du shift`);
    }
    touched.forEach(refreshSoon);
  } catch (e) {
    console.error("Pointage auto :", e.message);
  }
  sweeping = false;
}

// ================== COMMANDES ==================
// Toutes réservées aux admins : les chatteurs n'utilisent que les boutons Clock In / Clock Out du salon box
const shiftChoices = Object.entries(SHIFTS).map(([k, v]) => ({ name: `${k} (${v.label})`, value: k }));
const adminCmd = (name, description) =>
  new SlashCommandBuilder().setName(name).setDescription(description).setDefaultMemberPermissions(ADMIN_PERM);

const commands = [
  adminCmd("chatteurs", "Les chatteurs : nouveau, shift(s), modèles (aussi dans le salon gestion)"),
  adminCmd("modeles", "Voir, ajouter ou retirer des modèles"),
  adminCmd("lien_app", "Relier un membre Discord à son chatteur dans l'app KL (Pointage)")
    .addUserOption((o) => o.setName("membre").setDescription("Le membre Discord"))
    .addStringOption((o) =>
      o.setName("chatteur").setDescription("Son nom dans l'app").setAutocomplete(true)
    ),
  adminCmd("panel", "Renvoyer le message d'un shift (box, pointage, Clock In / Clock Out) dans le salon box")
    .addStringOption((o) =>
      o.setName("shift").setDescription("Le shift à envoyer").setRequired(true).addChoices(...shiftChoices)
    ),
  adminCmd("admins", "Voir, ajouter ou retirer des admins du bot"),
  adminCmd("coupure", "Noter une coupure : notifie le chatteur et le met en « Coupure » dans le pointage de l'app")
    .addUserOption((o) => o.setName("chatteur").setDescription("Le chatteur").setRequired(true))
    .addIntegerOption((o) => o.setName("minutes").setDescription("Durée de la coupure, en minutes").setMinValue(1).setMaxValue(720))
    .addStringOption((o) => o.setName("raison").setDescription("La raison (le chatteur la verra)").setMaxLength(200))
    .addStringOption((o) =>
      o.setName("shift").setDescription("Le shift concerné (par défaut : celui en cours)").addChoices(...shiftChoices)
    )
    .addBooleanOption((o) =>
      o.setName("retour").setDescription("Il revient de sa coupure : compte le temps de coupure au pointage (comme un retard)")
    ),
  adminCmd("dayoff", "Renvoyer le tableau des day off en bas du salon day off"),
].map((c) => c.toJSON());

client.once(Events.ClientReady, async () => {
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  } catch (e) {
    console.error("Enregistrement des commandes :", e.message);
  }
  console.log(`Connecté en tant que ${client.user.tag}`);
  await loadBoxEmojis().catch((e) => console.error("Emojis des box :", e.message));
  await resolveNames().catch((e) => console.error("Noms des membres :", e.message));
  gestion.ensurePanel().catch((e) => console.error("Panneau gestion :", e.message));
  if (!appSync.enabled()) return console.warn("Lien avec l'app désactivé (SUPABASE_URL / SUPABASE_SERVICE_KEY manquants)");
  try {
    const n = await appSync.migrateLinks(data.appLinks);
    if (n) console.log(`${n} lien(s) /lien_app recopié(s) dans l'app`);
  } catch (e) {
    console.error("Liens Discord -> app :", e.message);
  }
  publishMembers();
  await fillAhead();
  cron.schedule("5 0 * * *", fillAhead, { timezone: TZ });
  await restoreSessions().catch((e) => console.error("Clock in en cours :", e.message));
  setTimeout(() => dropClockingPanels().catch((e) => console.error("Anciens panneaux clocking :", e.message)).then(() => ensureBoxBoard()).catch((e) => console.error("Salon box :", e.message)), 8000);
  cron.schedule("*/5 * * * *", sweep, { timezone: TZ });
  setTimeout(sweep, 30000);
  setInterval(pollPost, 15000);
  const watch = () => planWatch.check().catch((e) => console.error("Changements de l'app :", e.message));
  setTimeout(watch, 5000);
  setInterval(watch, 10000);
  // changements faits dans l'app -> planning, messages de shift et tableau des day off sur Discord
  setInterval(refreshLive, 60000);
  // récap des pénalités de la quinzaine : le 16 et le 1er à 02h02 (rattrapé au démarrage s'il a été manqué)
  const recap = () => penalties.autoRecap().then((k) => k && console.log(`Récap des pénalités ${k} envoyé`)).catch((e) => console.error("Récap pénalités :", e.message));
  cron.schedule("2 2 * * *", recap, { timezone: TZ });
  setTimeout(recap, 20000);
  setTimeout(() => penalties.addRmButtons().then((n) => n && console.log(`🗑️ ajouté sous ${n} pénalité(s)`)).catch((e) => console.error("Boutons 🗑️ des pénalités :", e.message)), 25000);
  const board = () => dayoff.refreshBoard().catch((e) => console.error("Tableau day off :", e.message));
  setTimeout(board, 10000);
  setInterval(board, 120000);
});

// Clock in en cours oubliés (bot redémarré sans sa mémoire) : retrouvés d'après le pointage de l'app (arrivée
// notée, pas de départ). Un double shift (même arrivée sur deux shifts) redevient un seul clock in.
async function restoreSessions(t = Date.now()) {
  if (!appSync.enabled()) return [];
  const live = await appSync.openClockIns(t);
  const byUid = new Map();
  for (const x of live) byUid.set(x.uid, [...(byUid.get(x.uid) || []), x]);
  const back = [];
  for (const [uid, l] of byUid) {
    if (data.sessions[uid] || data.historique.some((h) => h.userId === uid && h.clockOut >= l[0].in)) continue;
    const order = (x) => appSync.parisMs(x.date, appSync.START_OF[x.slot] ?? 0);
    const [main, ...more] = [...l].sort((a, b) => a.in - b.in || order(a) - order(b));
    const shift = SHIFT_OF_SLOT[main.slot];
    if (!SHIFTS[shift]) continue;
    const p = await appSync.plannedFor(uid, [data.membres[uid]?.name].filter(Boolean), main.slot, main.date).catch(() => null);
    data.sessions[uid] = {
      shift, clockIn: main.in, modeles: await modelesOf(p?.accts || []).catch(() => []),
      app: { date: main.date, key: main.key, cid: main.cid, ...(more.length ? { extra: more.filter((x) => x.in === main.in).map((x) => ({ date: x.date, key: x.key })) } : {}) },
      restored: true,
    };
    back.push(uid);
    console.log(`Clock in retrouvé : ${nameOf(uid)} (${shift} depuis ${fmtTime(main.in)})`);
  }
  if (back.length) saveData();
  return back;
}

// Emojis des box (pastilles vertes 1 à 15 et ALL, dans assets/box) : ajoutés une fois aux emojis de
// l'application du bot, utilisables partout. Sans eux (BOX_EMOJIS=off, ou erreur), chiffres emoji 1️⃣ 2️⃣.
const BOX_EMOJI_V = "2"; // à changer si les images changent : les anciennes sont supprimées
async function loadBoxEmojis() {
  if (/^(off|non|0|false)$/i.test(process.env.BOX_EMOJIS || "") || !client.application?.emojis) return;
  const have = await client.application.emojis.fetch();
  const map = {};
  // VIP 👑 s'écrit en texte : pas d'image
  for (const k of planning.BOX_ORDER.filter((x) => x !== "vip")) {
    const name = `klbox${BOX_EMOJI_V}_${k}`;
    const e = have.find((x) => x.name === name) || (await client.application.emojis.create({ attachment: path.join(__dirname, "assets", "box", `${k}.png`), name }));
    map[k] = `<:${name}:${e.id}>`;
  }
  planning.setBoxEmojis(map);
  for (const e of have.values()) if (/^klbox\d+_/.test(e.name) && !e.name.startsWith(`klbox${BOX_EMOJI_V}_`)) await e.delete().catch(() => {});
}

// ================== MENUS ADMIN (ajout / retrait en multi-sélection) ==================
const chosenOf = (st) => [...new Set(Object.values(st.menus || {}).flat())];
// Menus de choix multiple : 25 choix par menu (limite Discord), 4 menus au plus
function pickMenus(menu, options, chosen, placeholder) {
  const groups = chunk(options, 25).slice(0, 4);
  return groups.map((g, k) =>
    row(
      new StringSelectMenuBuilder()
        .setCustomId(`adm_${menu}_sel_${k}`)
        .setPlaceholder(groups.length > 1 ? `${placeholder} (${k + 1}/${groups.length})` : placeholder)
        .setMinValues(0)
        .setMaxValues(g.length)
        .addOptions(g.map((o) => ({ ...o, default: chosen.includes(o.value) })))
    )
  );
}
const userMenu = (id, placeholder, users) => {
  const m = new UserSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setMinValues(1).setMaxValues(25);
  return users.length ? m.setDefaultUsers(...users) : m;
};
const okRow = (menu, label, emoji, style, n) =>
  row(
    button(`adm_${menu}_ok`, n ? `${label} (${n})` : label, emoji, style, !n),
    button(`adm_${menu}_back`, "Retour", "↩️", ButtonStyle.Secondary)
  );
const backRow = (menu) => row(button(`adm_${menu}_back`, "Retour", "↩️", ButtonStyle.Secondary));
// Accueil d'un menu : la liste + Ajouter / Retirer
const homeRow = (g, n) =>
  row(
    button(`adm_${g}home_to_${g}add`, "Ajouter", "➕", ButtonStyle.Success),
    button(`adm_${g}home_to_${g}rem`, "Retirer", "🗑️", ButtonStyle.Danger, !n)
  );

// Compte de l'app (modèle|plateforme) -> modèle du bot qui lui correspond
function modeleForAcct(key, cat) {
  const [mid, pid] = key.split("|");
  const a = cat.accounts.find((x) => x.key === key) || { model: cat.models[mid]?.name || "", platform: cat.platName(pid), pid };
  const keys = [`${a.model} ${a.platform}`, `${a.model} ${String(a.pid).replace(/^p-/, "")}`].map(kNorm);
  return data.modeles.find((m) => m.app === key) || data.modeles.find((m) => keys.includes(kNorm(m.name)));
}

const PANELS = {
  // ---- modèles ----
  mhome: {
    view() {
      const embed = new EmbedBuilder()
        .setColor(0x5bae8c)
        .setTitle(`💃 Modèles (${data.modeles.length})`)
        .setDescription(
          data.modeles.map((m) => `• **${withEmoji(m.name)}** · ${m.devise}${needsFiche(m.name) ? " · 📝" : ""}`).join("\n").slice(0, 4000) ||
            "Aucun modèle pour l'instant : clique sur **Ajouter**."
        );
      if (data.modeles.some((m) => needsFiche(m.name))) embed.setFooter({ text: "📝 = fiche de fin de shift dans le salon ventes" });
      return { embeds: [embed], components: [homeRow("m", data.modeles.length)] };
    },
  },
  madd: {
    async view(st) {
      const chosen = chosenOf(st);
      let opts = [];
      if (appSync.enabled())
        try {
          const cat = await appSync.appCatalog();
          opts = cat.accounts
            .filter((a) => !modeleForAcct(a.key, cat))
            .map((a) => opt(withEmoji(`${a.model} (${a.platform})`), a.key, `Compte de l'app · ${a.devise}`));
        } catch (e) {
          console.error("Comptes de l'app :", e.message);
        }
      const full = data.modeles.length >= 25;
      return {
        content: [
          "➕ **Ajouter des modèles**",
          full
            ? "⚠️ 25 modèles maximum (limite des menus Discord) : retire-en avant d'en ajouter."
            : opts.length
              ? "Coche les comptes de l'app à ajouter, ou **Autre modèle…** pour en écrire un à la main."
              : "Tous les comptes de l'app sont déjà dans la liste. **Autre modèle…** pour en écrire un à la main.",
        ].join("\n"),
        components: [
          ...(opts.length && !full ? pickMenus("madd", opts, chosen, "Comptes de l'app") : []),
          row(
            button("adm_madd_ok", chosen.length ? `Ajouter (${chosen.length})` : "Ajouter", "✅", ButtonStyle.Success, !chosen.length || full),
            button("adm_madd_other", "Autre modèle…", "✏️", ButtonStyle.Secondary, full),
            button("adm_madd_back", "Retour", "↩️", ButtonStyle.Secondary)
          ),
        ],
      };
    },
    async ok(i, st) {
      const cat = await appSync.appCatalog();
      const added = [];
      for (const key of chosenOf(st)) {
        const a = cat.accounts.find((x) => x.key === key);
        if (!a || modeleForAcct(key, cat) || data.modeles.length >= 25) continue;
        const name = `${a.model} (${a.platform})`.slice(0, 80);
        data.modeles.push({ name, devise: a.devise, app: key });
        added.push(name);
      }
      saveData();
      return added.length ? `✅ Ajouté${plS(added.length)} : **${modelesTxt(added)}**` : "Rien à ajouter.";
    },
  },
  mrem: {
    view(st) {
      if (!data.modeles.length) return { content: "Aucun modèle dans la liste.", components: [backRow("mrem")] };
      const chosen = chosenOf(st);
      const opts = data.modeles.map((m) => opt(withEmoji(m.name), m.name, `${m.devise}${needsFiche(m.name) ? " · fiche de fin de shift" : ""}`));
      return {
        content: [
          `🗑️ **Retirer des modèles** (${data.modeles.length} dans la liste)`,
          "Coche celles à retirer, puis **Retirer**.",
          chosen.length ? `Sélection : **${modelesTxt(chosen)}**` : "",
        ].filter(Boolean).join("\n"),
        components: [...pickMenus("mrem", opts, chosen, "Modèles à retirer"), okRow("mrem", "Retirer", "🗑️", ButtonStyle.Danger, chosen.length)],
      };
    },
    ok(i, st) {
      const names = chosenOf(st);
      data.modeles = data.modeles.filter((m) => !names.includes(m.name));
      saveData();
      return `🗑️ Retiré${plS(names.length)} : **${modelesTxt(names)}**`;
    },
  },
  // ---- admins du bot ----
  ahome: {
    view() {
      const embed = new EmbedBuilder()
        .setColor(0x5bae8c)
        .setTitle(`🛡️ Admins du bot (${data.admins.length})`)
        .setDescription(data.admins.map((a) => `• <@${a}>`).join("\n") || "Aucun admin du bot pour l'instant.")
        .setFooter({ text: "Les admins du serveur Discord ont toujours accès aux commandes." });
      return { embeds: [embed], components: [homeRow("a", data.admins.length)] };
    },
  },
  aadd: {
    view(st) {
      const users = st.users || [];
      return {
        content: ["➕ **Ajouter des admins du bot**", users.length ? `Sélection : ${mentions(users)}` : "Choisis un ou plusieurs membres."].join("\n"),
        components: [row(userMenu("adm_aadd_users", "Membres Discord", users)), okRow("aadd", "Ajouter", "✅", ButtonStyle.Success, users.length)],
      };
    },
    ok(i, st) {
      data.admins = [...new Set([...data.admins, ...st.users])];
      saveData();
      return `✅ ${mentions(st.users)} ${st.users.length > 1 ? "sont" : "est"} admin du bot.`;
    },
  },
  arem: {
    view(st) {
      if (!data.admins.length) return { content: "Aucun admin du bot (en plus des admins Discord).", components: [backRow("arem")] };
      const chosen = chosenOf(st);
      const opts = data.admins.map((u) => opt(nameOf(u), u, data.membres[u]?.username ? `@${data.membres[u].username}` : ""));
      return {
        content: ["🗑️ **Retirer des admins du bot**", chosen.length ? `Sélection : ${mentions(chosen)}` : "Coche ceux à retirer."].join("\n"),
        components: [...pickMenus("arem", opts, chosen, "Admins à retirer"), okRow("arem", "Retirer", "🗑️", ButtonStyle.Danger, chosen.length)],
      };
    },
    ok(i, st) {
      const ids = chosenOf(st);
      data.admins = data.admins.filter((a) => !ids.includes(a));
      saveData();
      return `🗑️ ${mentions(ids)} ${ids.length > 1 ? "ne sont" : "n'est"} plus admin du bot.`;
    },
  },
};
const PANEL_OF = { modeles: "mhome", admins: "ahome" };

// ---------- 💃 Modèles et 🛡️ Admins en petite fiche (boutons sous le panneau du shift) ----------
const mLabel = (l, d) => (d ? new LabelBuilder().setLabel(l).setDescription(d) : new LabelBuilder().setLabel(l));
const mPick = (id, opts, min = 0) =>
  new StringSelectMenuBuilder().setCustomId(id).setRequired(min > 0).setMinValues(min).setMaxValues(Math.max(1, opts.length)).addOptions(opts);
const fiField = (i, fn, id) => {
  try {
    return i.fields[fn](id);
  } catch {
    return null;
  }
};
// La liste en haut ; cocher pour retirer, ajouter un compte de l'app ou un autre nom (avec sa devise)
async function openModels(i) {
  if (!isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const cat = appSync.enabled() ? await Promise.race([appSync.appCatalog().catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]) : null;
  const list = data.modeles;
  const add = cat ? cat.accounts.filter((a) => !modeleForAcct(a.key, cat)).slice(0, 25) : [];
  const full = list.length >= 25;
  const m = new ModalBuilder().setCustomId("ga_models").setTitle(`💃 Modèles (${list.length})`).addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      [
        list.map((x) => `• **${withEmoji(x.name)}** · ${x.devise}${needsFiche(x.name) ? " · 📝" : ""}`).join("\n") || "_Aucun modèle pour l'instant._",
        list.some((x) => needsFiche(x.name)) ? "-# 📝 = fiche de fin de shift dans le salon ventes" : "",
        full ? "-# ⚠️ 25 modèles maximum : retires-en avant d'en ajouter." : "",
      ].filter(Boolean).join("\n").slice(0, 3900)
    )
  );
  if (list.length)
    m.addLabelComponents(mLabel("Retirer de la liste").setStringSelectMenuComponent(mPick("rem", list.map((x) => opt(withEmoji(x.name), x.name, `${x.devise}${needsFiche(x.name) ? " · fiche de fin de shift" : ""}`)))));
  if (add.length && !full)
    m.addLabelComponents(mLabel("Ajouter un compte de l'app").setStringSelectMenuComponent(mPick("add", add.map((a) => opt(withEmoji(`${a.model} (${a.platform})`), a.key, `Compte de l'app · ${a.devise}`)))));
  if (!full)
    m.addLabelComponents(
      mLabel("Ou un autre modèle", "Son nom, ex : Zoé (Uncove)").setTextInputComponent(
        new TextInputBuilder().setCustomId("nom").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80).setPlaceholder("Vide = aucun")
      ),
      mLabel("Sa devise").setStringSelectMenuComponent(mPick("devise", [opt("Euro (€)", "€", null, "💶", true), opt("Dollar ($)", "$", null, "💵")], 1))
    );
  return i.showModal(m);
}
async function saveModels(i) {
  await i.deferReply({ flags: EPHEMERAL });
  const rem = fiField(i, "getStringSelectValues", "rem") || [];
  const add = fiField(i, "getStringSelectValues", "add") || [];
  const nom = String(fiField(i, "getTextInputValue", "nom") || "").trim().slice(0, 80);
  const devise = (fiField(i, "getStringSelectValues", "devise") || [])[0] === "$" ? "$" : "€";
  const out = [];
  if (rem.length) {
    data.modeles = data.modeles.filter((m) => !rem.includes(m.name));
    out.push(`🗑️ Retiré${plS(rem.length)} : **${modelesTxt(rem)}**`);
  }
  if (add.length && appSync.enabled()) {
    const cat = await appSync.appCatalog();
    const added = [];
    for (const key of add) {
      const a = cat.accounts.find((x) => x.key === key);
      if (!a || modeleForAcct(key, cat) || data.modeles.length >= 25) continue;
      const name = `${a.model} (${a.platform})`.slice(0, 80);
      data.modeles.push({ name, devise: a.devise, app: key });
      added.push(name);
    }
    if (added.length) out.push(`✅ Ajouté${plS(added.length)} : **${modelesTxt(added)}**`);
  }
  if (nom) {
    if (modeleOf(nom)) out.push(`⚠️ **${withEmoji(nom)}** est déjà dans la liste.`);
    else if (data.modeles.length >= 25) out.push("⚠️ 25 modèles maximum : retires-en d'abord.");
    else {
      data.modeles.push({ name: nom, devise });
      out.push(`✅ Ajouté : **${withEmoji(nom)}** (${devise})`);
    }
  }
  saveData();
  return done(i, [...(out.length ? out : ["Rien n'a changé."]), `-# ${data.modeles.length} modèle${plS(data.modeles.length)} dans la liste.`].join("\n"), 30000);
}
// Les admins du bot déjà cochés : on en coche d'autres, on décoche ceux à retirer
function openAdmins(i) {
  if (!isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const sel = new UserSelectMenuBuilder().setCustomId("who").setRequired(false).setMinValues(0).setMaxValues(25).setPlaceholder("🔎 Tape un nom");
  if (data.admins.length) sel.setDefaultUsers(...data.admins.slice(0, 25));
  return i.showModal(
    new ModalBuilder().setCustomId("ga_admins").setTitle(`🛡️ Admins du bot (${data.admins.length})`).addLabelComponents(
      mLabel("Admins du bot", "Ajoute ou retire des noms ; les admins du serveur Discord ont toujours accès").setUserSelectMenuComponent(sel)
    )
  );
}
async function saveAdmins(i) {
  await i.deferReply({ flags: EPHEMERAL });
  const picked = fiField(i, "getSelectedUsers", "who");
  const list = picked ? [...picked.values()].filter((u) => !u.bot) : [];
  for (const u of list) remember(u, fiField(i, "getSelectedMembers", "who")?.get?.(u.id));
  const ids = list.map((u) => u.id);
  const added = ids.filter((u) => !data.admins.includes(u)), gone = data.admins.filter((u) => !ids.includes(u));
  data.admins = ids;
  saveData();
  return done(
    i,
    [
      added.length ? `✅ ${mentions(added)} ${added.length > 1 ? "sont" : "est"} admin du bot.` : "",
      gone.length ? `🗑️ ${mentions(gone)} ${gone.length > 1 ? "ne sont" : "n'est"} plus admin du bot.` : "",
      !added.length && !gone.length ? "Rien n'a changé." : "",
      `-# Admins du bot : ${ids.length ? mentions(ids) : "aucun"} (les admins du serveur Discord ont toujours accès).`,
    ].filter(Boolean).join("\n"),
    30000
  );
}
// 📅 Planning (panneau du shift) : la barre « ✏️ Modif par shift », pour ce jour-là et le lendemain
function openPlanPick(i, date) {
  if (!isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const days = [date, appSync.addDays(date, 1)];
  const sel = new StringSelectMenuBuilder().setCustomId("pm_pickd").setPlaceholder("✏️ Modif par shift").addOptions(
    days.flatMap((d) => planning.SLOTS.map((sl) => opt(`${sl.l} · ${planning.dayLabel(d)}`, `${d}|${sl.k}`, sl.h, sl.emoji)))
  );
  return reply(i, { content: "✏️ **Modif par shift** : choisis le shift, sa fiche s'ouvre (un chatteur par ligne avec ses box).", components: [row(sel)] }, false);
}
const HOME_OF = { madd: "mhome", mrem: "mhome", aadd: "ahome", arem: "ahome" };

// Affiche un menu dans le message éphémère (note : résultat de la dernière action, au-dessus)
async function show(i, menu, st = {}, note = "") {
  const v = await PANELS[menu].view(st);
  const payload = {
    content: [note, v.content].filter(Boolean).join("\n\n"),
    embeds: v.embeds || [],
    components: v.components,
    allowedMentions: { parse: [] },
  };
  return i.deferred || i.replied ? i.editReply(payload) : i.update(payload);
}
async function openPanel(i, menu) {
  await i.deferReply({ flags: EPHEMERAL });
  return show(i, menu);
}
// customId : adm_<menu>_<action>[_<n° du menu ou menu suivant>]
async function onPanel(i) {
  if (!isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const [, menu, action, k] = i.customId.split("_");
  const key = `${i.user.id}:${menu}`;
  if (!PANELS[menu]) return done(i, "Ce menu a expiré, relance la commande.");
  if (action === "to" && PANELS[k]) {
    const st = {};
    picks.set(`${i.user.id}:${k}`, st);
    return show(i, k, st);
  }
  if (action === "back") {
    picks.delete(key);
    return show(i, HOME_OF[menu] || menu);
  }
  const st = picks.get(key);
  if (!st) return done(i, "Ce menu a expiré, relance la commande.");
  if (action === "sel") (st.menus ||= {})[k] = i.values;
  else if (action === "users") {
    st.users = i.values.filter((u) => !i.users.get(u)?.bot);
    for (const u of st.users) remember(i.users.get(u), i.members?.get(u));
  } else if (action === "other") {
    return i.showModal(
      new ModalBuilder().setCustomId("adm_madd_modal").setTitle("Autre modèle").addComponents(
        row(new TextInputBuilder().setCustomId("nom").setLabel("Nom").setPlaceholder("ex : Zoé (Uncove)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
        row(new TextInputBuilder().setCustomId("devise").setLabel("Devise : € ou $").setValue("€").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10))
      )
    );
  } else if (action === "ok") {
    await i.deferUpdate();
    const msg = await PANELS[menu].ok(i, st);
    picks.delete(key);
    return show(i, HOME_OF[menu], {}, msg);
  }
  return show(i, menu, st);
}

// ================== INTERACTIONS ==================
async function handleInteraction(i) {
  try {
    const uid = i.user.id;

    // ---------- Autocomplete (/lien_app, /planning) ----------
    if (i.isAutocomplete()) {
      if (!isAdmin(i)) return i.respond([]);
      if (!appSync.enabled()) return i.respond([]);
      const q = appSync.norm(i.options.getFocused());
      const list = (await appSync.appChatters())
        .filter((c) => c.active && appSync.norm(c.name).includes(q))
        .slice(0, q ? 25 : 24)
        .map((c) => ({ name: `${c.name}${c.discordId ? " (déjà relié)" : ""}`.slice(0, 100), value: c.id }));
      return i.respond(q ? list : [{ name: "— Délier (aucun chatteur) —", value: "none" }, ...list]);
    }

    remember(i.user, i.member);
    // un seul menu éphémère ouvert à la fois par admin, supprimé après 3 min sans le toucher
    menus.track(i);

    // planning modifiable (pl_ / pe_), salon day off (do_), vocaux (vc_), panneau gestion (g_), chatteurs (cm_)
    const cid = i.customId || "";
    if (cid.startsWith("cm_")) return chatters.handle(i);
    if (cid.startsWith("pn_")) return penalties.handle(i);
    if (cid.startsWith("pm_")) return shiftModal.handle(i);
    if (cid.startsWith("qm_")) return quickModal.handle(i);
    if (cid.startsWith("cf_")) return fiche.handle(i);
    if (/^p[leb]_/.test(cid)) return planEdit.handle(i);
    if (cid.startsWith("do_")) return dayoff.handle(i);
    if (cid.startsWith("vc_")) return voice.handle(i);
    if (cid.startsWith("g_")) return gestion.handle(i);
    if (cid === "ga_models" || cid === "ga_admins") {
      if (!isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
      return cid === "ga_models" ? saveModels(i) : saveAdmins(i);
    }

    // ---------- Slash commands ----------
    if (i.isChatInputCommand()) {
      if (!isAdmin(i)) return reply(i, { content: "⛔ Cette commande est réservée aux admins." });
      if (i.commandName === "chatteurs") return chatters.open(i);
      if (PANEL_OF[i.commandName]) return openPanel(i, PANEL_OF[i.commandName]);

      switch (i.commandName) {
        case "panel": {
          const shift = i.options.getString("shift");
          await i.deferReply({ flags: EPHEMERAL });
          await announceShift(shift);
          return done(i, `✅ Shift **${shift}** renvoyé dans <#${BOX_CHANNEL_ID}>.`);
        }
        case "lien_app":
          return lienApp(i);
        case "coupure":
          return coupure(i);
        case "dayoff": {
          if (!appSync.enabled())
            return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
          if (!dayoff.DAYOFF_CHANNEL_ID) return reply(i, { content: "⚠️ Aucun salon day off : ajoute DAYOFF_CHANNEL_ID dans Railway." });
          await i.deferReply({ flags: EPHEMERAL });
          const b = await dayoff.refreshBoard({ resend: true });
          return done(i, b ? `✅ Tableau des day off envoyé dans <#${b.channelId}> : ${b.url}` : "⚠️ Tableau pas envoyé, réessaie dans un instant.");
        }
      }
    }

    // ---------- Boutons ----------
    if (i.isButton()) {
      const id = i.customId;
      if (id.startsWith("adm_")) return onPanel(i);
      // Actualiser le récap de l'effectif
      if (id.startsWith("eff_")) {
        const [, name, date] = id.split("_");
        if (!SHIFTS[name] || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return done(i, "Ce message a expiré.", 8000);
        await i.deferUpdate();
        return i.editReply(await effectifView(name, date));
      }
      // Clock Out (bouton du salon)
      if (id === "btn_clockout") return startClockOut(i);
      // Clock In (bouton du salon) : le shift vient du planning, pas du message cliqué
      if (id.startsWith("btn_clockin_")) return startClockIn(i);
      if (id === "co_go") {
        const d = outDraft.get(uid);
        if (!data.sessions[uid] || !d) return done(i, "Session expirée, refais Clock Out.");
        const fiche = ficheModeles(d);
        return fiche.length ? i.showModal(ficheModal(fiche)) : finalizeClockOut(i, []);
      }
      if (id === "co_cancel") {
        outDraft.delete(uid);
        return done(i, "Clock out annulé : tu es toujours clock in.", 8000);
      }
      return done(i, "Ce menu a expiré, recommence.", 8000);
    }

    // ---------- Menus ----------
    if (i.isStringSelectMenu() || i.isUserSelectMenu()) {
      if (i.customId.startsWith("adm_")) return onPanel(i);
      return done(i, "Ce menu a expiré, recommence.", 8000);
    }

    // ---------- Fenêtres ----------
    if (i.isModalSubmit()) {
      if (i.customId === "co_fiche") return submitFiche(i);
      if (i.customId === "adm_madd_modal") {
        if (!isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
        const nom = i.fields.getTextInputValue("nom").trim().slice(0, 80);
        const devise = /\$|usd|dol/i.test(i.fields.getTextInputValue("devise")) ? "$" : "€";
        if (!nom) return reply(i, { content: "❌ Indique un nom." });
        if (modeleOf(nom)) return reply(i, { content: "⚠️ Ce modèle existe déjà." });
        if (data.modeles.length >= 25) return reply(i, { content: "⚠️ 25 modèles maximum : retire-en d'abord." });
        data.modeles.push({ name: nom, devise });
        saveData();
        picks.delete(`${uid}:madd`);
        return show(i, "mhome", {}, `✅ Modèle **${withEmoji(nom)}** (${devise}) ajouté.`);
      }
    }
  } catch (err) {
    console.error(err);
    const msg = { content: `❌ Erreur : ${String(err.message || err).slice(0, 300)}`, flags: EPHEMERAL };
    if (i.deferred || i.replied) i.followUp(msg).catch(() => {});
    else if (i.isRepliable()) i.reply(msg).catch(() => {});
  }
}
client.on(Events.InteractionCreate, handleInteraction);
client.on(Events.VoiceStateUpdate, (o, n) => voice.onVoice(o, n).catch((e) => console.error("Vocal :", e.message)));

// ================== MODULES (planning modifiable, day off, vocaux) ==================
Object.assign(planEdit.ctx, {
  isAdmin,
  refresh: refreshSoon,
  // remplacement, renfort, box retirées… : annoncés dans le salon box
  notify: boxNote,
  coupure: ({ cid, slot, date }) => appSync.markCoupure({ cid, slot, date }),
  postPlanning: (date) => postPlanning(date),
  presence: async (date, slot) => {
    const name = SHIFT_OF_SLOT[slot];
    if (!SHIFTS[name]) return {};
    const b = await shiftBoard(name, date);
    return Object.fromEntries(b.staff.map((p) => [p.id, b.stOf(p)]));
  },
});
Object.assign(gestion.ctx, {
  isAdmin, client, SHIFTS, getData: () => data, saveData, liveEmbed: () => pointageEmbed(),
  // le shift en cours, ou celui qui commence dans les 15 min (son panneau est déjà là)
  currentShift: () => {
    const t = Date.now() + 15 * 60e3;
    const name = shiftAt(t);
    return { name, date: appSync.shiftDay(appSync.SLOT_OF[name], t).date };
  },
  shiftOfSlot: (slot) => SHIFT_OF_SLOT[slot],
  shiftBoard,
  setMark: async (date, slot, cid, patch) => {
    await appSync.setMark(date, slot, cid, patch);
    refreshSoon(date);
  },
  openMenu: openPanel,
  openChatters: (i) => chatters.open(i),
  openPlanning: (i, date, view, extra) => planEdit.open(i, date, view, extra),
  openPenalties: (i) => penalties.open(i),
  refreshPanels: refreshSoon,
  heldText: (date, slot, cid) => planEdit.heldText(date, slot, cid),
  dayoffView: (month) => dayoff.boardView(month),
  coupure: runCoupure,
  retour: retourCoupure,
  retours: retourMany,
  openModels, openAdmins, openPlanPick,
  postPlanning: (date) => postPlanning(date),
  announceShift,
  dayChoices: () => dayChoices(""),
  fireTargets, firePreview, fire: fireChatter,
});
Object.assign(shiftModal.ctx, { isAdmin, refresh: refreshSoon });
// 🔁 Remplacer, 🔀 Déplacer, 💪🏼 Renfort : des fenêtres où l'on tape le nom (au lieu des menus éphémères)
Object.assign(quickModal.ctx, { isAdmin, refresh: refreshSoon });
// 👤 la fiche d'un chatteur (menu sous le panneau du shift) : modèles, box, shifts, compte ; ➕ un nouveau
Object.assign(fiche.ctx, { isAdmin, refresh: refreshSoon });
const modals = { replace: quickModal.openReplace, change: quickModal.openChange, fiche: fiche.openFiche, fresh: fiche.openNew, find: fiche.openFor };
planEdit.ctx.modals = modals;
gestion.ctx.modals = modals;
// box, modèle, chatteur ajouté ou retiré dans l'app sur un shift en cours -> une ligne dans le salon box
Object.assign(planWatch.ctx, { notify: planEdit.ctx.notify, refresh: refreshSoon });
Object.assign(appSync.hooks, { planWritten: planWatch.onWrite, beforeLoud: planWatch.prime });
Object.assign(chatters.ctx, {
  isAdmin, getData: () => data, saveData, publishMembers, remember, refresh: refreshSoon, SHIFT_OF_SLOT,
});
Object.assign(penalties.ctx, { isAdmin, client, nameOf, getData: () => data, saveData });
Object.assign(dayoff.ctx, { isAdmin, client, getData: () => data, saveData, refreshPlanning: refreshSoon });
Object.assign(voice.ctx, {
  client,
  note: (payload) => boxNote(payload),
  isAdmin,
  fmtTime,
  // son shift s'il est clock in, sinon celui où il est au planning (déjà commencé, ou dans les 15 min)
  shiftText: async (uid) => {
    const s = data.sessions[uid];
    if (s) {
      const k = liveShift(s);
      return `${SHIFTS[k]?.emoji || ""} ${k}${s.modeles.length ? ` · ${modelesTxt(s.modeles)}` : ""}`;
    }
    if (!appSync.enabled()) return "";
    const t = Date.now();
    const p = await appSync.plannedSlotAt(uid, [data.membres[uid]?.name].filter(Boolean), t).catch(() => null);
    const k = p && SHIFT_OF_SLOT[p.slot];
    return k && t >= appSync.parisMs(p.date, appSync.START_OF[p.slot]) - 15 * 60e3 ? `${SHIFTS[k].emoji} ${k}` : "";
  },
  // ses box sur son shift (en cours, ou qui commence dans l'heure et demie)
  boxTag: async (uid) => {
    if (!appSync.enabled()) return "";
    const t = Date.now();
    const names = [data.membres[uid]?.name].filter(Boolean);
    const s = data.sessions[uid];
    const slot = s ? appSync.SLOT_OF[liveShift(s, t)] : (await appSync.plannedSlotAt(uid, names, t))?.slot;
    if (!slot) return "";
    const p = await appSync.plannedFor(uid, names, slot, appSync.shiftDay(slot, t).date);
    if (!p) return "";
    const { models } = await appSync.appCatalog();
    return planning.boxTag(p.boxes, (mid) => models[mid]?.name || mid);
  },
  // coupure en cours (pour le bouton 🔙 sous « est revenu »)
  inCoupure: async (uid) => appSync.enabled() && (await appSync.openCoupures()).some((c) => c.discordId === uid),
  // ⚡ Coupure (notée tout de suite) : puis ses box (quelqu'un le remplace, redonnées, retirées)
  depart: async (i, uid, { cut }) => {
    await i.deferReply({ flags: EPHEMERAL });
    let cutText = "";
    if (cut) {
      const s = data.sessions[uid];
      const p = !s && appSync.enabled() ? await appSync.plannedSlotAt(uid, [data.membres[uid]?.name].filter(Boolean), Date.now()).catch(() => null) : null;
      const r = await noteCoupure(await client.users.fetch(uid), { shift: p ? SHIFT_OF_SLOT[p.slot] : undefined });
      cutText = r.ok ? `✅ Coupure notée au pointage de l'app et dans <#${BOX_CHANNEL_ID}>. À son retour : 🔙 sous son message « est revenu ».` : r.text;
    }
    return planEdit.openDepart(i, uid, { cutNoted: cut, cutText });
  },
  // 🔁 Remplacer : la fenêtre tout de suite, lui déjà choisi (son shift en cours est trouvé à l'envoi)
  replace: (i, uid) => quickModal.openReplace(i, { date: "-", out: uid }),
  retour: async (i, uid) => {
    const m = await client.users.fetch(uid);
    return retourCoupure(i, { uid, names: namesOfUser(m) });
  },
});

// ================== VIRER UN CHATTEUR ==================
// Les chatteurs de l'app (actifs) et ceux du clocking Discord qui ne sont reliés à aucun chatteur de l'app
async function fireTargets() {
  const app = appSync.enabled() ? (await appSync.appChatters(true)).filter((c) => c.active) : [];
  const linked = new Set(app.map((c) => c.discordId).filter(Boolean));
  const sh = (c) => c.shift?.slot && planning.SLOTS.find((x) => x.k === c.shift.slot);
  return [
    ...app.map((c) => ({
      value: `c:${c.id}`, cid: c.id, uid: c.discordId || "", label: c.name, emoji: sh(c)?.emoji || "👤",
      desc: [sh(c) ? `Habituellement ${sh(c).l}` : "", c.discordId ? `Discord : ${nameOf(c.discordId)}` : "Pas relié à Discord"].filter(Boolean).join(" · "),
    })),
    ...Object.keys(data.chatteurs)
      .filter((u) => !linked.has(u))
      .map((u) => ({ value: `u:${u}`, uid: u, label: nameOf(u), emoji: "💬", desc: `Seulement dans le clocking Discord (${data.chatteurs[u]})` })),
  ].sort((a, b) => a.label.localeCompare(b.label, "fr"));
}
async function firePreview(t) {
  const out = [];
  if (t.uid && data.chatteurs[t.uid]) out.push(`retiré du clocking Discord (shift ${data.chatteurs[t.uid]})`);
  if (t.uid && data.sessions[t.uid]) out.push("son clock in en cours est terminé maintenant");
  if (t.cid) {
    const r = await appSync.retireChatter(t.cid, appSync.parisParts(Date.now()).date, { dry: true });
    out.push(`retiré du planning à venir : ${r.shifts} shift${plS(r.shifts)}${r.dates.length ? ` (${r.dates.map((d) => +d.slice(8)).join(", ")})` : ""}`);
    if (r.offs) out.push(`${r.offs} day off à venir supprimé${plS(r.offs)}`);
    out.push("inactif dans l'app, sans shift habituel");
  }
  return out;
}
async function fireChatter(t) {
  const gone = [];
  if (t.uid && data.sessions[t.uid]) {
    const s = data.sessions[t.uid];
    data.historique.push({ userId: t.uid, shift: s.shift, clockIn: s.clockIn, clockOut: Date.now(), modeles: s.modeles, ventes: [] });
    delete data.sessions[t.uid];
    appSync.onClockOut({ app: s.app, t: Date.now() }).catch((e) => console.error("Pointage app (viré) :", e.message));
  }
  if (t.uid && data.chatteurs[t.uid]) {
    delete data.chatteurs[t.uid];
    gone.push("clocking Discord");
  }
  saveData();
  publishMembers();
  if (t.cid) {
    const r = await appSync.retireChatter(t.cid, appSync.parisParts(Date.now()).date);
    if (r.shifts) gone.push(`planning (${r.shifts} shift${plS(r.shifts)} à venir)`);
    if (r.offs) gone.push(`${r.offs} day off à venir`);
    gone.push("passé inactif dans l'app");
    r.dates.forEach(refreshSoon);
    dayoff.refreshBoard().catch((e) => console.error("Tableau day off :", e.message));
  }
  console.log(`Chatteur viré : ${t.label} (${t.value})`);
  return `🚫 **${t.label}** a été retiré : ${gone.join(", ") || "rien à retirer"}. Son historique reste dans l'app.`;
}

// ================== LIEN APP ==================
async function lienApp(i) {
  if (!appSync.enabled())
    return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  const m = i.options.getUser("membre");
  const cid = i.options.getString("chatteur");
  await i.deferReply({ flags: EPHEMERAL });
  const chatters = await appSync.appChatters(true);
  if (!m) {
    const txt =
      chatters.filter((c) => c.discordId).sort((a, b) => a.name.localeCompare(b.name, "fr")).map((c) => `<@${c.discordId}> → ${c.name}`).join("\n") ||
      "Aucun lien pour l'instant. Ils se règlent dans l'app (Équipe › Comptes Discord), ou tout seuls au premier clock in si le pseudo Discord = le nom dans l'app.";
    return done(i, txt.slice(0, 2000), 60000);
  }
  remember(m, i.options.getMember("membre"));
  if (!cid) {
    const c = chatters.find((x) => x.discordId === m.id);
    return done(i, c ? `<@${m.id}> → **${c.name}**` : `<@${m.id}> n'est relié à aucun chatteur de l'app.`);
  }
  if (cid === "none") {
    await appSync.linkDiscord(m.id, "");
    return done(i, `🔓 <@${m.id}> n'est plus relié à l'app.`);
  }
  const c = chatters.find((x) => x.id === cid);
  if (!c) return done(i, "❌ Chatteur introuvable dans l'app, choisis-le dans la liste.");
  await appSync.linkDiscord(m.id, cid);
  return done(i, `🔗 <@${m.id}> est relié à **${c.name}** dans l'app.`);
}

// ================== COUPURE ==================
async function coupure(i) {
  const m = i.options.getUser("chatteur");
  if (m.bot) return reply(i, { content: "❌ Choisis un chatteur, pas un bot." });
  remember(m, i.options.getMember("chatteur"));
  const opts = { min: i.options.getInteger("minutes"), raison: (i.options.getString("raison") || "").trim(), shift: i.options.getString("shift") };
  return i.options.getBoolean?.("retour") ? retourCoupure(i, { uid: m.id, names: namesOfUser(m) }) : runCoupure(i, m, opts);
}
const namesOfUser = (m) => [data.membres[m.id]?.name, m.globalName, m.username].filter(Boolean);
// Début de coupure : « Coupure » au pointage de l'app, et une ligne qui notifie le chatteur dans le salon box
// update : vient d'un menu éphémère (panneau gestion), le résultat remplace le menu
async function runCoupure(i, m, { min, raison, shift: forced, update = false }) {
  await (update ? i.deferUpdate() : i.deferReply({ flags: EPHEMERAL }));
  const r = await noteCoupure(m, { min, raison, shift: forced });
  return done(i, r.text, 60000);
}
// Note la coupure (pointage de l'app + salon box) ; renvoie le compte rendu
async function noteCoupure(m, { min, raison, shift: forced } = {}) {
  const t = Date.now();
  const s = data.sessions[m.id];
  // par défaut : le shift sur lequel il est clock in (le 2e en cas de double shift), sinon celui en cours
  const shift = forced || (s ? liveShift(s, t) : shiftAt(t));
  const date = appSync.shiftDay(appSync.SLOT_OF[shift], s?.shift === shift ? s.clockIn : t).date;

  let point = "";
  let ok = false;
  if (!appSync.enabled()) point = "⚠️ Lien avec l'app désactivé : pas noté au pointage.";
  else
    try {
      const r = await appSync.markCoupure({ uid: m.id, names: namesOfUser(m), slot: appSync.SLOT_OF[shift], date, min, note: raison, t });
      ok = r.skipped !== "unlinked";
      point = !ok
        ? "⚠️ Ce compte Discord n'est relié à aucun chatteur de l'app : pas noté au pointage (à relier dans Équipe › Comptes Discord)."
        : `📋 Noté « Coupure » au pointage de l'app (${r.name}). À son retour : 🔙 **Retour de coupure** (sous son message de retour dans le vocal, ou 🛠️ Admin dans le salon box).`;
    } catch (e) {
      console.error("Pointage app (coupure) :", e.message);
      point = `⚠️ Pas noté au pointage : ${String(e.message || e).slice(0, 200)}`;
    }

  // une seule ligne, comme les clock in : « ⚡ @Keoni Coupure 00:49 · 🌆 SOIR · 15 min · Connexion coupée »
  const line = [`⚡ <@${m.id}> **Coupure** ${fmtTime(t)}`, `${SHIFTS[shift].emoji} ${shift}`, min ? `${min} min` : "", raison].filter(Boolean).join(" · ");
  let sent = "";
  try {
    await boxNote({ content: line, allowedMentions: { users: [m.id] } });
    sent = `🔔 Notifié dans <#${BOX_CHANNEL_ID}>.`;
  } catch (e) {
    ok = false;
    console.error("Coupure (salon box) :", e.message);
    sent = `⚠️ Message pas envoyé dans le salon box : ${String(e.message || e).slice(0, 200)}`;
  }
  refreshSoon(date);
  return { date, shift, ok, text: [`⚡ Coupure pour <@${m.id}> · ${SHIFTS[shift].emoji} ${shift} du ${planning.dayLabel(date)}${min ? ` · ${min} min` : ""}`, point, sent].join("\n") };
}
// Retour de coupure : temps réel compté au pointage (comme un retard) et une ligne dans le salon box
// target : { uid, names } (compte Discord) ou { cid } (chatteur de l'app)
// giveBack : il reprend les box qu'il avait avant d'être remplacé (retirées à celui qui les a)
async function retourCoupure(i, target, { update = false, giveBack = true } = {}) {
  await (update ? i.deferUpdate() : i.deferReply({ flags: EPHEMERAL }));
  if (!appSync.enabled()) return done(i, "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway.");
  return done(i, await retourText(target, { giveBack }), 60000);
}
// Fiche 🔙 Retour de coupure : un ou plusieurs chatteurs (de l'app) d'un coup
async function retourMany(i, cids, giveBack = true) {
  await i.deferReply({ flags: EPHEMERAL });
  if (!cids.length) return done(i, "Choisis qui revient.");
  const out = [];
  for (const cid of cids) out.push(await retourText({ cid }, { giveBack }));
  return done(i, out.join("\n"), 60000);
}
async function retourText({ uid, cid, names = [] }, { giveBack = true } = {}) {
  const t = Date.now();
  const r = await appSync.endCoupure({ uid, cid, names, t });
  const tag = uid || r.discordId ? `<@${uid || r.discordId}>` : `**${r.name}**`;
  if (r.skipped === "unlinked") return `⚠️ <@${uid}> n'est relié à aucun chatteur de l'app (Équipe › Comptes Discord).`;
  if (r.notCut) return `⚠️ ${tag} n'a pas de coupure en cours (lance d'abord une coupure).`;
  const shift = SHIFT_OF_SLOT[r.slot];
  const back = giveBack ? await planEdit.giveBack(r.date, r.slot, r.chatterId).catch((e) => (console.error("Box rendues :", e.message), "")) : "";
  const line = [
    `🔙 ${tag} **Retour de coupure** ${fmtTime(t)}`,
    shift ? `${SHIFTS[shift].emoji} ${shift}` : "",
    `${r.took} min${r.total > r.took ? ` (${r.total} min sur le shift)` : ""}`,
    back,
  ].filter(Boolean).join(" · ");
  await boxNote({ content: line, allowedMentions: { parse: [] } }).catch((e) => console.error("Retour de coupure (salon box) :", e.message));
  refreshSoon(r.date);
  return `🔙 ${tag} est de retour : ${r.took} min de coupure (parti à ${fmtTime(r.since)}), noté au pointage de l'app (${r.name}).${back ? `\n📦 Il ${back}.` : ""}`;
}

// ================== CLOCK IN ==================
// Un seul clic : le shift et les modèles viennent du planning de l'app (ou de son shift habituel).
// Shift : celui où il est prévu (de 1 h 30 avant le début à la fin), sinon un de ses shifts habituels en cours
// ou qui commence bientôt, sinon celui en cours dans 30 min. Un clock in à 13h40 va bien sur APREM.
const gapTo = (k, t) => {
  const p = appSync.parisParts(t);
  const m = (((p.h * 60 + p.mi - SHIFTS[k].start * 60) % 1440) + 1440) % 1440;
  return m >= 1440 - 90 ? 1440 - m : m;
};
async function detectShift(i, t, app) {
  if (appSync.enabled())
    try {
      const p = await appSync.plannedSlotAt(i.user.id, namesOf(i), t);
      if (p && SHIFT_OF_SLOT[p.slot]) return { shift: SHIFT_OF_SLOT[p.slot], planned: true };
    } catch (e) {
      console.error("Shift du clock in :", e.message);
    }
  const habit = [...appSync.habSlots(app?.shift).map((k) => SHIFT_OF_SLOT[k]), data.chatteurs[i.user.id]].filter((k) => SHIFTS[k] && nearShift(k, t));
  if (habit.length) return { shift: habit.sort((a, b) => gapTo(a, t) - gapTo(b, t))[0], planned: false };
  return { shift: shiftAt(t + 30 * 60e3), planned: false };
}
// Comptes de l'app -> modèles du bot (ajoutées à sa liste si elles n'y sont pas encore)
async function modelesOf(accts) {
  if (!accts.length) return [];
  const cat = await appSync.appCatalog();
  const names = [];
  for (const k of accts) {
    let m = modeleForAcct(k, cat);
    const a = cat.accounts.find((x) => x.key === k);
    if (!m && a) {
      m = { name: `${a.model} (${a.platform})`.slice(0, 80), devise: a.devise, app: k };
      data.modeles.push(m);
      saveData();
    }
    if (m) names.push(m.name);
  }
  return [...new Set(names)];
}
// Modèles et box prévues pour lui sur ce shift (planning du jour, sinon son shift habituel)
async function plannedOf(uid, names, shift, t, app) {
  if (!appSync.enabled()) return { modeles: [], boxes: {} };
  try {
    const slot = appSync.SLOT_OF[shift];
    const p = await appSync.plannedFor(uid, names, slot, appSync.shiftDay(slot, t).date);
    const habit = app?.shift && appSync.habSlots(app.shift).includes(slot) ? app.shift.accts || [] : [];
    return { modeles: await modelesOf(p?.accts.length ? p.accts : habit), boxes: p?.boxes || {} };
  } catch (e) {
    console.error("Planning du clock in :", e.message);
    return { modeles: [], boxes: {} };
  }
}
async function startClockIn(i) {
  const uid = i.user.id;
  const cur = data.sessions[uid];
  if (cur)
    return reply(i, { content: `⚠️ Tu es déjà clock in depuis ${fmtTime(cur.clockIn)} (shift ${cur.shift}). Clock out d'abord.` });
  if (opening.has(uid)) return i.deferUpdate().catch(() => {});
  opening.add(uid);
  try {
    await i.deferReply({ flags: EPHEMERAL });
    const appOf = () => (appSync.enabled() ? appSync.chatterOf(uid, namesOf(i), false).catch(() => null) : null);
    let app = await appOf();
    // pas trouvé : la liste de l'app est peut-être en cache depuis moins d'une minute (chatteur tout juste créé)
    if (!app && !data.chatteurs[uid] && appSync.enabled()) app = await appSync.appChatters(true).then(appOf, () => null);
    if (!data.chatteurs[uid] && !app?.active)
      return done(i, "❌ Tu n'es pas dans la liste des chatteurs. Demande à un admin.");
    const t = Date.now();
    const { shift } = await detectShift(i, t, app);
    const { modeles, boxes } = await plannedOf(uid, namesOf(i), shift, t, app);
    if (data.sessions[uid]) return done(i, "⚠️ Tu es déjà clock in.");
    const s = (data.sessions[uid] = { shift, clockIn: t, modeles });
    saveData();

    const { late, isLate } = appSync.lateness(appSync.SLOT_OF[shift], t);
    await boxNote({ content: clockLine("in", uid, s, t, isLate ? late : 0), allowedMentions: { parse: [] } }).catch((e) => console.error("Clock in (salon box) :", e.message));
    const note = await syncClockIn(i, shift, t);
    refreshSoon(data.sessions[uid]?.app?.date || appSync.shiftDay(appSync.SLOT_OF[shift], t).date);
    const models = appSync.enabled() && Object.keys(boxes).length ? (await appSync.appCatalog()).models : {};
    const tag = planning.boxTag(boxes, (mid) => models[mid]?.name || mid);
    return done(
      i,
      [
        `✅ Clock in à **${fmtTime(t)}** · ${shiftTxt(shift)}`,
        modeles.length ? `${modelesTxt(modeles)}${tag ? ` · ${tag}` : ""}` : "",
        isLate ? `⏰ ${late} min de retard.` : "",
        note,
      ].filter(Boolean).join("\n"),
      60000
    );
  } finally {
    opening.delete(uid);
  }
}

// Pointage de l'app : présent ou retard (si le compte Discord est relié à un chatteur)
async function syncClockIn(i, shift, t) {
  const uid = i.user.id;
  if (!appSync.enabled()) return "";
  try {
    const r = await appSync.onClockIn({ uid, names: namesOf(i), shift, t });
    if (r.skipped === "unlinked") {
      console.warn(`Pointage app : ${nameOf(uid)} (${uid}) n'est relié à aucun chatteur`);
      return "⚠️ Ton compte Discord n'est relié à aucun chatteur de l'app : ton pointage n'y apparaît pas. Préviens un admin.";
    }
    if (r.chatterId && data.sessions[uid]) {
      data.sessions[uid].app = { date: r.date, key: r.key, cid: r.chatterId };
      saveData();
    }
  } catch (e) {
    console.error("Pointage app (clock in) :", e.message);
  }
  return "";
}

// ================== CLOCK OUT ==================
async function startClockOut(i) {
  const uid = i.user.id;
  const s = data.sessions[uid];
  if (!s) return reply(i, { content: "❌ Tu n'es pas clock in." });
  await i.deferReply({ flags: EPHEMERAL });
  // ses modèles du clock in, plus celles où on l'a mis pendant le shift (remplacement, renfort)
  const now = await plannedOf(uid, namesOf(i), liveShift(s), s.clockIn, null);
  outDraft.set(uid, { modeles: [...new Set([...s.modeles, ...now.modeles])] });
  return i.editReply(clockOutView(uid));
}

async function submitFiche(i) {
  const uid = i.user.id;
  const d = outDraft.get(uid);
  if (!data.sessions[uid] || !d) return reply(i, { content: "Session expirée, refais Clock Out." });
  const fiche = ficheModeles(d);
  const field = (id) => {
    try {
      return i.fields.getTextInputValue(id);
    } catch {
      return "";
    }
  };
  const ventes = [];
  for (const [k, modele] of fiche.entries()) {
    let [v, t] = [field(`v_${k}`), field(`t_${k}`)];
    if (fiche.length > 2) [v, t = ""] = field(`vt_${k}`).split("/");
    const montant = parseAmount(v), tips = parseAmount(t);
    if (isNaN(montant) || isNaN(tips))
      return reply(i, { content: `❌ Montant invalide pour ${modele}. Exemple : 185 ou 185,50. Reclique sur le bouton pour corriger.` });
    ventes.push({ modele, montant, tips });
  }
  return finalizeClockOut(i, ventes);
}

async function finalizeClockOut(i, ventes) {
  const uid = i.user.id;
  if (closing.has(uid)) return i.deferUpdate().catch(() => {});
  closing.add(uid);
  try {
    await i.deferUpdate();
    const s = data.sessions[uid];
    if (!s) return done(i, "Tu n'es plus clock in.");
    const modeles = outDraft.get(uid)?.modeles || s.modeles;
    const tOut = Date.now();
    delete data.sessions[uid];
    outDraft.delete(uid);
    // Historique pour /stats
    data.historique.push({ userId: uid, shift: s.shift, clockIn: s.clockIn, clockOut: tOut, modeles, ventes });
    saveData();

    if (ventes.length) {
      const ventesCh = await client.channels.fetch(VENTES_CHANNEL_ID);
      await ventesCh.send({ embeds: ventes.map((v) => ficheEmbed(uid, v)), allowedMentions: { parse: [] } });
    }
    await boxNote({ content: clockLine("out", uid, { ...s, modeles }, tOut), allowedMentions: { parse: [] } }).catch((e) => console.error("Clock out (salon box) :", e.message));
    appSync.onClockOut({ app: s.app, t: tOut }).catch((e) => console.error("Pointage app (clock out) :", e.message))
      .finally(() => (s.app?.date ? refreshSoon(s.app.date) : gestion.panelSoon()));

    return done(i, `✅ Shift terminé à **${fmtTime(tOut)}** (${fmtDuration(tOut - s.clockIn)}).${ventes.length ? ` Fiche envoyée dans <#${VENTES_CHANNEL_ID}>.` : ""}`);
  } finally {
    closing.delete(uid);
  }
}

// la mémoire gardée dans l'app est relue avant de se connecter (data.json perdu au redéploiement)
if (require.main === module) restoreData().finally(() => client.login(TOKEN));
// pour les tests
module.exports = {
  client, handleInteraction, postPlanning, postShift, fillAhead, restoreData, restoreSessions, refreshLive, announceShift, dropClockingPanels, loadBoxEmojis, autoClockOuts, ensureBoxBoard, refreshBox, postEffectif, pollPost, sweep, planWatch,
  parseDay, dayChoices, getData: () => data, SHIFTS, voice, dayoff, planEdit, gestion, pointageEmbed,
};
