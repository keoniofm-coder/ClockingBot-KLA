const {
  Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, REST, Routes, PermissionFlagsBits, MessageFlags,
} = require("discord.js");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const appSync = require("./app-sync");
const planning = require("./planning");
const { withEmoji } = planning;

// ================== CONFIG ==================
const TOKEN = (process.env.DISCORD_TOKEN || "").trim();
const CLIENT_ID = (process.env.CLIENT_ID || "").trim();
const GUILD_ID = (process.env.GUILD_ID || "").trim();
const CLOCKING_CHANNEL_ID = (process.env.CLOCKING_CHANNEL_ID || "").trim();
const VENTES_CHANNEL_ID = (process.env.VENTES_CHANNEL_ID || "").trim();
const PLANNING_CHANNEL_ID = (process.env.PLANNING_CHANNEL_ID || "1553946673141518466").trim();
// Envoi automatique du planning chaque jour à cette heure (ex : 20:00), vide = seulement à la demande.
// Avant midi on envoie celui du jour même, après midi celui du lendemain.
const PLANNING_AUTO = (process.env.PLANNING_AUTO || "").trim();
// Modèles qui ont une fiche de fin de shift dans le salon ventes (les autres n'en ont pas)
const FICHE_MODELES = new RegExp(process.env.FICHE_MODELES || "uncove", "i");
// Récap de l'effectif dans le salon clocking, N minutes après le début de chaque shift (0 = pas de récap)
const EFFECTIF_APRES = Math.min(300, Math.max(0, Number(process.env.EFFECTIF_APRES_MIN ?? 20) || 0));
const TZ = "Europe/Paris";
const EPHEMERAL_TTL = 25000; // 25 secondes
const EPHEMERAL = MessageFlags.Ephemeral;

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
  planningMsgs: {}, // date -> { channelId, ids } : dernier planning envoyé (remplacé au prochain envoi)
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
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
loadData();

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
const plS = (n) => (n > 1 ? "s" : "");
const mentions = (ids) => ids.map((u) => `<@${u}>`).join(", ");
const modelesTxt = (names) => names.map(withEmoji).join(", ");
const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, k) => list.slice(k * n, k * n + n));
// « Zoé (Inflow) » -> « zoe inflow »
const fit = (lines, max = 1024) => {
  let out = "";
  for (const l of lines) {
    if (out.length + l.length + 3 > max) return out + "\n…";
    out += (out ? "\n" : "") + l;
  }
  return out;
};
// Shift en cours à l'instant t (heure de Paris)
const shiftAt = (t) => SHIFT_ORDER.find((k) => (appSync.parisParts(t).h - SHIFTS[k].start + 24) % 24 < 6);
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

// Répond en éphémère et supprime le message après 25 secondes
async function reply(i, options, autoDelete = true) {
  const payload = { allowedMentions: { parse: [] }, ...options, flags: EPHEMERAL };
  const follow = i.replied || i.deferred;
  const msg = follow ? await i.followUp(payload) : await i.reply(payload);
  if (autoDelete) setTimeout(() => i.deleteReply(follow ? msg : undefined).catch(() => {}), EPHEMERAL_TTL);
  return msg;
}
// Remplace le message éphémère (menu, réponse différée) par un texte final, puis le supprime
async function done(i, content, ttl = EPHEMERAL_TTL) {
  const payload = { content, components: [], embeds: [], allowedMentions: { parse: [] } };
  if (i.deferred || i.replied) await i.editReply(payload);
  else await i.update(payload);
  setTimeout(() => i.deleteReply().catch(() => {}), ttl);
}
const row = (...c) => new ActionRowBuilder().addComponents(...c);
function button(id, label, emoji, style, disabled = false) {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
  return emoji ? b.setEmoji(emoji) : b;
}

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
const clockInDraft = new Map(); // userId -> { shift, modeles, plan }
const outDraft = new Map(); // userId -> { modeles }
const picks = new Map(); // `${userId}:${menu}` -> état d'un menu admin
const closing = new Set(); // clock out en cours (évite le double clic)

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ================== COMPOSANTS ==================
const clockInRow = (shift) =>
  row(
    button(`btn_clockin_${shift}`, "Clock In", "✅", ButtonStyle.Success),
    button("btn_clockout", "Clock Out", "🔴", ButtonStyle.Danger)
  );

// Clock in : choix des modèles (plusieurs possibles) + Valider
function clockInView(uid) {
  const d = clockInDraft.get(uid);
  const names = data.modeles.map((m) => m.name).slice(0, 25);
  const lines = [`${SHIFTS[d.shift].emoji} **Clock in · Shift ${d.shift}** (${SHIFTS[d.shift].label})`];
  if (d.plan.length) lines.push(`📋 Au planning : **${modelesTxt(d.plan)}**`);
  lines.push(
    d.modeles.length
      ? `Modèle(s) : **${modelesTxt(d.modeles)}**. Clique sur **Valider**.`
      : "Choisis une ou plusieurs modèles, puis **Valider**."
  );
  // bouton au-dessus du menu : Discord ouvre la liste vers le bas, elle cacherait le bouton
  return {
    content: lines.join("\n"),
    components: [
      row(button(`ci_ok_${d.shift}`, "Valider le clock in", "✅", ButtonStyle.Success, !d.modeles.length)),
      row(
        new StringSelectMenuBuilder()
          .setCustomId(`ci_models_${d.shift}`)
          .setPlaceholder("Tes modèles (plusieurs possibles)")
          .setMinValues(1)
          .setMaxValues(names.length)
          .addOptions(names.map((n) => ({ label: withEmoji(n), value: n, default: d.modeles.includes(n) })))
      ),
    ],
  };
}

// Clock out : les modèles du shift (on peut en ajouter une) puis fiche ou fin directe
const outOptions = (s) => [...new Set([...data.modeles.map((m) => m.name), ...s.modeles])].slice(0, 25);
const ficheModeles = (d) => d.modeles.filter(needsFiche).slice(0, 5);
function clockOutView(uid) {
  const s = data.sessions[uid];
  const d = outDraft.get(uid);
  const fiche = ficheModeles(d);
  const opts = outOptions(s);
  return {
    content: [
      `🔴 **Clock out · Shift ${s.shift}**, arrivé à ${fmtTime(s.clockIn)} (${fmtDuration(Date.now() - s.clockIn)})`,
      "Sur quelles modèles as-tu bossé ? Ajoute celles où tu as aidé en plus pendant le shift.",
      fiche.length ? `📝 Fiche de ventes à remplir pour **${modelesTxt(fiche)}**.` : "",
    ].filter(Boolean).join("\n"),
    components: [
      row(
        fiche.length
          ? button("co_go", "Remplir la fiche et terminer", "📝", ButtonStyle.Primary, !d.modeles.length)
          : button("co_go", "Terminer mon shift", "🔴", ButtonStyle.Danger, !d.modeles.length),
        button("co_cancel", "Annuler", null, ButtonStyle.Secondary)
      ),
      row(
        new StringSelectMenuBuilder()
          .setCustomId("co_models")
          .setPlaceholder("Modèles du shift (plusieurs possibles)")
          .setMinValues(1)
          .setMaxValues(opts.length)
          .addOptions(opts.map((n) => ({ label: withEmoji(n), value: n, default: d.modeles.includes(n) })))
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

function clockEmbed(kind, uid, s, t, late = 0) {
  const sh = SHIFTS[s.shift] || {};
  const lines =
    kind === "in"
      ? [`✅ <@${uid}> **Clock in** · ${fmtTime(t)}`, `${sh.emoji || ""} Shift ${s.shift} · ${modelesTxt(s.modeles)}`]
      : [`🔴 <@${uid}> **Clock out** · ${fmtTime(t)}`, `${sh.emoji || ""} Shift ${s.shift} · ${fmtDuration(t - s.clockIn)} · ${modelesTxt(s.modeles)}`];
  if (late) lines.push(`⏰ ${late} min de retard`);
  return new EmbedBuilder().setColor(kind === "in" ? 0x2ecc71 : 0xe74c3c).setDescription(lines.join("\n"));
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
// Chatteurs prévus au planning de l'app sur ce shift (mentionnés sans les notifier)
async function rosterText(shift) {
  if (!appSync.enabled()) return "";
  const slot = appSync.SLOT_OF[shift];
  const { date } = appSync.shiftDay(slot, Date.now() + 15 * 60e3);
  const day = await appSync.planningDay(date);
  return planning.slotLines(day, slot).lines.join("\n").slice(0, 3500);
}
async function announceShift(name) {
  const sh = SHIFTS[name];
  const ch = await client.channels.fetch(CLOCKING_CHANNEL_ID);
  const roster = await rosterText(name).catch((e) => (console.error("Planning de l'annonce :", e.message), ""));
  const embed = new EmbedBuilder()
    .setColor(sh.color)
    .setTitle(`${sh.emoji} Shift ${name} · ${sh.label}`)
    .setDescription(`Pensez bien à **clock in** avec le bouton ci-dessous, et bon shift ${sh.emoji}${roster ? `\n\n**Au planning**\n${roster}` : ""}`);
  await ch.send({
    content: `🔔 **C'est l'heure du shift ${name} (${sh.label})**`,
    embeds: [embed],
    components: [clockInRow(name)],
    allowedMentions: { parse: [] },
  });
}

// 15 min avant chaque shift (heure de Paris)
for (const [name, sh] of Object.entries(SHIFTS)) {
  const hour = (sh.start - 1 + 24) % 24; // 15 min avant => hh-1:45
  cron.schedule(`45 ${hour} * * *`, () => announceShift(name).catch((e) => console.error("Annonce :", e.message)), { timezone: TZ });
}

// ================== EFFECTIF (quelques minutes après le début de chaque shift) ==================
// Membres qui ont fait clock in sur ce shift (en cours ou terminé)
function clockInsOf(name, date) {
  const slot = appSync.SLOT_OF[name];
  const start = appSync.parisMs(date, SHIFTS[name].start);
  const same = (t) => Math.abs(t - start) < 12 * 3600e3 && appSync.shiftDay(slot, t).date === date;
  return new Set([
    ...data.historique.filter((h) => h.shift === name && same(h.clockIn)).map((h) => h.userId),
    ...Object.entries(data.sessions).filter(([, s]) => s.shift === name && same(s.clockIn)).map(([uid]) => uid),
  ]);
}
// Qui est là sur ce shift, sur combien de prévus, et qui manque
async function effectifView(name, date) {
  const sh = SHIFTS[name];
  const slot = appSync.SLOT_OF[name];
  const seen = clockInsOf(name, date);
  // prévus : planning de l'app (hors day off), sinon les chatteurs du bot sur ce shift
  let staff = appSync.enabled() ? await appSync.slotStaff(date, slot) : [];
  if (!staff.length) staff = Object.keys(data.chatteurs).filter((u) => data.chatteurs[u] === name).map((u) => ({ discordId: u, name: nameOf(u) }));
  const due = staff.filter((p) => !p.off);
  const who = (p) => (p.discordId ? `<@${p.discordId}>` : `**${p.name}**`);
  // présent : clock in sur Discord, ou pointé présent / retard / coupure dans l'app
  const isHere = (p) => seen.has(p.discordId) || ["present", "retard", "coupure"].includes(p.mark?.status);
  const here = due.filter(isHere).map(who);
  const missing = due.filter((p) => !isHere(p)).map(who);
  // clock in sur ce shift sans être prévu : listés avec les présents, sans compter dans le total
  const dueIds = new Set(due.map((p) => p.discordId));
  const extra = [...seen].filter((u) => !dueIds.has(u)).map((u) => `<@${u}> (en plus)`);
  const n = here.length, total = due.length;
  const embed = new EmbedBuilder()
    .setColor(!total ? 0x8a8f98 : n >= total ? 0x5bae8c : n ? 0xe0ae4e : 0xd63a3a)
    .setTitle(`👥 Effectif ${sh.emoji} ${name} · ${n}/${total}`);
  if (!total && !extra.length) embed.setDescription("_Personne de prévu sur ce shift._");
  if (here.length || extra.length) embed.addFields({ name: "✅ Présents", value: fit([...here, ...extra]) });
  if (missing.length) embed.addFields({ name: "❌ Manquants", value: fit(missing) });
  return { embeds: [embed], components: [row(button(`eff_${name}_${date}`, "Actualiser", "🔄", ButtonStyle.Secondary))], allowedMentions: { parse: [] } };
}
async function postEffectif(name) {
  const { date } = appSync.shiftDay(appSync.SLOT_OF[name], Date.now());
  const ch = await client.channels.fetch(CLOCKING_CHANNEL_ID);
  await ch.send(await effectifView(name, date));
}
if (EFFECTIF_APRES > 0)
  for (const [name, sh] of Object.entries(SHIFTS)) {
    const m = sh.start * 60 + EFFECTIF_APRES;
    cron.schedule(`${m % 60} ${Math.floor(m / 60) % 24} * * *`, () => postEffectif(name).catch((e) => console.error("Effectif :", e.message)), { timezone: TZ });
  }

// ================== PLANNING -> DISCORD ==================
async function postPlanning(date) {
  const { content, embeds, count } = planning.planningEmbeds(await appSync.planningDay(date));
  const ch = await client.channels.fetch(PLANNING_CHANNEL_ID);
  // un nouvel envoi du même jour remplace le précédent
  const old = data.planningMsgs[date];
  if (old?.channelId === ch.id) for (const id of old.ids || []) await ch.messages.delete(id).catch(() => {});
  const ids = [];
  let first = null;
  const parts = embeds.length ? planning.chunkEmbeds(embeds) : [[]];
  for (const part of parts) {
    const msg = await ch.send({ ...(first ? {} : { content }), embeds: part, allowedMentions: { parse: [] } });
    first ||= msg;
    ids.push(msg.id);
  }
  data.planningMsgs[date] = { channelId: ch.id, ids, at: Date.now() };
  const limit = appSync.addDays(appSync.parisParts(Date.now()).date, -21);
  for (const d of Object.keys(data.planningMsgs)) if (d < limit) delete data.planningMsgs[d];
  saveData();
  return { url: first.url, count };
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

// Demande d'envoi faite depuis l'app (bouton « Envoyer sur Discord » de Planning › Jour)
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
          const r = await postPlanning(req.date);
          patch = { status: "done", doneAt: Date.now(), url: r.url, count: r.count };
          console.log(`Planning du ${req.date} envoyé (demandé depuis l'app)`);
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
async function sweep() {
  if (sweeping || !appSync.enabled()) return;
  sweeping = true;
  try {
    const since = Date.now() - 2 * 864e5;
    const clockIns = [
      ...Object.entries(data.sessions).map(([uid, s]) => ({ uid, shift: s.shift, t: s.clockIn })),
      ...data.historique.filter((h) => h.clockIn >= since).map((h) => ({ uid: h.userId, shift: h.shift, t: h.clockIn })),
    ];
    for (const x of await appSync.sweepAbsents({ clockIns }))
      console.log(`Pointage auto : ${x.name} ${x.status} (${x.slot} du ${x.date})`);
  } catch (e) {
    console.error("Pointage auto :", e.message);
  }
  sweeping = false;
}

// ================== COMMANDES ==================
// Toutes réservées aux admins : les chatteurs n'utilisent que les boutons Clock In / Clock Out du salon clocking
const shiftChoices = Object.entries(SHIFTS).map(([k, v]) => ({ name: `${k} (${v.label})`, value: k }));
const adminCmd = (name, description) =>
  new SlashCommandBuilder().setName(name).setDescription(description).setDefaultMemberPermissions(ADMIN_PERM);

const commands = [
  adminCmd("chatteurs", "Voir, ajouter ou retirer des chatteurs du clocking"),
  adminCmd("modeles", "Voir, ajouter ou retirer des modèles"),
  adminCmd("planning", "Envoyer le planning d'un jour dans le salon planning")
    .addStringOption((o) =>
      o.setName("jour").setDescription("Le jour : aujourd'hui, demain, 23/10…").setRequired(true).setAutocomplete(true)
    ),
  adminCmd("lien_app", "Relier un membre Discord à son chatteur dans l'app KL (Pointage)")
    .addUserOption((o) => o.setName("membre").setDescription("Le membre Discord"))
    .addStringOption((o) =>
      o.setName("chatteur").setDescription("Son nom dans l'app").setAutocomplete(true)
    ),
  adminCmd("panel", "Renvoyer le message de shift (boutons Clock In / Clock Out) dans le salon clocking")
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
    ),
].map((c) => c.toJSON());

client.once(Events.ClientReady, async () => {
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  } catch (e) {
    console.error("Enregistrement des commandes :", e.message);
  }
  console.log(`Connecté en tant que ${client.user.tag}`);
  await resolveNames().catch((e) => console.error("Noms des membres :", e.message));
  if (!appSync.enabled()) return console.warn("Lien avec l'app désactivé (SUPABASE_URL / SUPABASE_SERVICE_KEY manquants)");
  try {
    const n = await appSync.migrateLinks(data.appLinks);
    if (n) console.log(`${n} lien(s) /lien_app recopié(s) dans l'app`);
  } catch (e) {
    console.error("Liens Discord -> app :", e.message);
  }
  publishMembers();
  cron.schedule("*/5 * * * *", sweep, { timezone: TZ });
  setTimeout(sweep, 30000);
  setInterval(pollPost, 15000);
  const auto = PLANNING_AUTO.match(/^(\d{1,2})[:h](\d{2})$/);
  if (auto)
    cron.schedule(`${+auto[2]} ${+auto[1]} * * *`, () => {
      const today = appSync.parisParts(Date.now()).date;
      postPlanning(+auto[1] < 12 ? today : appSync.addDays(today, 1)).catch((e) => console.error("Planning auto :", e.message));
    }, { timezone: TZ });
});

// ================== MENUS ADMIN (ajout / retrait en multi-sélection) ==================
const shiftOptions = (cur) =>
  SHIFT_ORDER.map((k) => ({ label: `${k} (${SHIFTS[k].label})`, value: k, emoji: SHIFTS[k].emoji, default: k === cur }));
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
const opt = (label, value, description, emoji) => ({
  label: String(label).slice(0, 100), value, ...(description ? { description: String(description).slice(0, 100) } : {}), ...(emoji ? { emoji } : {}),
});
const byShift = (ids) =>
  ids.sort((a, b) => SHIFT_ORDER.indexOf(data.chatteurs[a]) - SHIFT_ORDER.indexOf(data.chatteurs[b]) || nameOf(a).localeCompare(nameOf(b), "fr"));

// Compte de l'app (modèle|plateforme) -> modèle du bot qui lui correspond
function modeleForAcct(key, cat) {
  const [mid, pid] = key.split("|");
  const a = cat.accounts.find((x) => x.key === key) || { model: cat.models[mid]?.name || "", platform: cat.platName(pid), pid };
  const keys = [`${a.model} ${a.platform}`, `${a.model} ${String(a.pid).replace(/^p-/, "")}`].map(kNorm);
  return data.modeles.find((m) => m.app === key) || data.modeles.find((m) => keys.includes(kNorm(m.name)));
}

const PANELS = {
  // ---- chatteurs ----
  chome: {
    async view() {
      const linked = {};
      if (appSync.enabled())
        try {
          for (const c of await appSync.appChatters()) if (c.discordId) linked[c.discordId] = c.name;
        } catch (e) {
          console.error("Chatteurs de l'app :", e.message);
        }
      const ids = byShift(Object.keys(data.chatteurs));
      const embed = new EmbedBuilder().setColor(0x5bae8c).setTitle(`👥 Chatteurs du clocking (${ids.length})`);
      if (!ids.length) embed.setDescription("Aucun chatteur pour l'instant : clique sur **Ajouter**.");
      for (const k of SHIFT_ORDER) {
        const list = ids.filter((u) => data.chatteurs[u] === k);
        if (!list.length) continue;
        const line = (u) => `<@${u}>${appSync.enabled() ? (linked[u] ? ` → ${linked[u]}` : " · ⚠️ pas relié à l'app") : ""}`;
        embed.addFields({ name: `${SHIFTS[k].emoji} ${k} · ${list.length}`, value: list.map(line).join("\n").slice(0, 1024) });
      }
      if (appSync.enabled()) embed.setFooter({ text: "Les liens se règlent dans l'app : Équipe › Comptes Discord" });
      return { embeds: [embed], components: [homeRow("c", ids.length)] };
    },
  },
  cadd: {
    view(st) {
      const users = st.users || [];
      const moved = users.filter((u) => data.chatteurs[u] && st.shift && data.chatteurs[u] !== st.shift);
      return {
        content: [
          "➕ **Ajouter des chatteurs**",
          "Choisis un ou plusieurs membres, leur shift, puis **Ajouter**. Ceux déjà dans la liste changent juste de shift.",
          users.length ? `Sélection : ${mentions(users)}` : "",
          moved.length ? `↪️ Changent de shift : ${mentions(moved)}` : "",
        ].filter(Boolean).join("\n"),
        components: [
          row(userMenu("adm_cadd_users", "Membres Discord", users)),
          row(new StringSelectMenuBuilder().setCustomId("adm_cadd_shift").setPlaceholder("Leur shift").addOptions(shiftOptions(st.shift))),
          okRow("cadd", "Ajouter", "✅", ButtonStyle.Success, st.shift ? users.length : 0),
        ],
      };
    },
    ok(i, st) {
      for (const u of st.users) data.chatteurs[u] = st.shift;
      saveData();
      publishMembers();
      return `✅ ${mentions(st.users)} ${st.users.length > 1 ? "sont" : "est"} au shift **${st.shift}**.`;
    },
  },
  crem: {
    view(st) {
      const ids = byShift(Object.keys(data.chatteurs));
      if (!ids.length) return { content: "Aucun chatteur dans la liste.", components: [backRow("crem")] };
      const chosen = chosenOf(st);
      const opts = ids.map((u) =>
        opt(nameOf(u), u, `Shift ${data.chatteurs[u]}${data.membres[u]?.username ? ` · @${data.membres[u].username}` : ""}`, SHIFTS[data.chatteurs[u]]?.emoji)
      );
      return {
        content: [
          `🗑️ **Retirer des chatteurs** (${ids.length} dans la liste)`,
          "Coche ceux à retirer, puis **Retirer**.",
          chosen.length ? `Sélection : ${mentions(chosen)}` : "",
        ].filter(Boolean).join("\n"),
        components: [...pickMenus("crem", opts, chosen, "Chatteurs à retirer"), okRow("crem", "Retirer", "🗑️", ButtonStyle.Danger, chosen.length)],
      };
    },
    ok(i, st) {
      const ids = chosenOf(st);
      ids.forEach((u) => delete data.chatteurs[u]);
      saveData();
      publishMembers();
      return `🗑️ Retiré${plS(ids.length)} du clocking : ${mentions(ids)}`;
    },
  },
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
const PANEL_OF = { chatteurs: "chome", modeles: "mhome", admins: "ahome" };
const HOME_OF = { cadd: "chome", crem: "chome", madd: "mhome", mrem: "mhome", aadd: "ahome", arem: "ahome" };

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
  } else if (action === "shift") st.shift = i.values[0];
  else if (action === "other") {
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
      if (i.commandName === "planning") return i.respond(dayChoices(i.options.getFocused()));
      if (!appSync.enabled()) return i.respond([]);
      const q = appSync.norm(i.options.getFocused());
      const list = (await appSync.appChatters())
        .filter((c) => c.active && appSync.norm(c.name).includes(q))
        .slice(0, q ? 25 : 24)
        .map((c) => ({ name: `${c.name}${c.discordId ? " (déjà relié)" : ""}`.slice(0, 100), value: c.id }));
      return i.respond(q ? list : [{ name: "— Délier (aucun chatteur) —", value: "none" }, ...list]);
    }

    remember(i.user, i.member);

    // ---------- Slash commands ----------
    if (i.isChatInputCommand()) {
      if (!isAdmin(i)) return reply(i, { content: "⛔ Cette commande est réservée aux admins." });
      if (PANEL_OF[i.commandName]) return openPanel(i, PANEL_OF[i.commandName]);

      switch (i.commandName) {
        case "panel": {
          const shift = i.options.getString("shift");
          await i.deferReply({ flags: EPHEMERAL });
          await announceShift(shift);
          return done(i, `✅ Message du shift **${shift}** envoyé dans le salon clocking.`);
        }
        case "planning": {
          if (!appSync.enabled())
            return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
          const date = parseDay(i.options.getString("jour"));
          if (!date) return reply(i, { content: "❌ Je ne reconnais pas ce jour. Exemples : demain, 23/10, 2026-10-23." });
          await i.deferReply({ flags: EPHEMERAL });
          const r = await postPlanning(date);
          return done(i, `✅ Planning du ${planning.dayLabel(date)} envoyé dans <#${PLANNING_CHANNEL_ID}> (${r.count} chatteur${plS(r.count)}) : ${r.url}`);
        }
        case "lien_app":
          return lienApp(i);
        case "coupure":
          return coupure(i);
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
      // Clock In (bouton du salon)
      if (id.startsWith("btn_clockin_") && SHIFTS[id.slice(12)]) return startClockIn(i, id.slice(12));
      if (id.startsWith("ci_ok_")) return validateClockIn(i, id.slice(6));
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
      // Choix des modèles au clock in (ne valide pas tout seul)
      if (i.customId.startsWith("ci_models_")) {
        const d = clockInDraft.get(uid);
        if (!d) return done(i, "Ce menu a expiré, refais Clock In.", 8000);
        d.modeles = i.values;
        return i.update(clockInView(uid));
      }
      // Modèles travaillées pendant le shift (au clock out)
      if (i.customId === "co_models") {
        const d = outDraft.get(uid);
        if (!d || !data.sessions[uid]) return done(i, "Session expirée, refais Clock Out.", 8000);
        d.modeles = i.values;
        return i.update(clockOutView(uid));
      }
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
  const min = i.options.getInteger("minutes");
  const raison = (i.options.getString("raison") || "").trim();
  const t = Date.now();
  const s = data.sessions[m.id];
  // par défaut : le shift sur lequel il est clock in, sinon celui en cours
  const shift = i.options.getString("shift") || s?.shift || shiftAt(t);
  const date = appSync.shiftDay(appSync.SLOT_OF[shift], s?.shift === shift ? s.clockIn : t).date;
  await i.deferReply({ flags: EPHEMERAL });
  remember(m, i.options.getMember("chatteur"));

  let point = "";
  if (!appSync.enabled()) point = "⚠️ Lien avec l'app désactivé : pas noté au pointage.";
  else
    try {
      const names = [data.membres[m.id]?.name, m.globalName, m.username].filter(Boolean);
      const r = await appSync.markCoupure({ uid: m.id, names, slot: appSync.SLOT_OF[shift], date, min, note: raison, t });
      point = r.skipped === "unlinked"
        ? "⚠️ Ce compte Discord n'est relié à aucun chatteur de l'app : pas noté au pointage (à relier dans Équipe › Comptes Discord)."
        : `📋 Noté « Coupure » au pointage de l'app (${r.name}).`;
    } catch (e) {
      console.error("Pointage app (coupure) :", e.message);
      point = `⚠️ Pas noté au pointage : ${String(e.message || e).slice(0, 200)}`;
    }

  const embed = new EmbedBuilder()
    .setColor(0x4f8fd6)
    .setTitle("✂️ Coupure")
    .setDescription(`<@${m.id}>, une coupure a été notée sur ton shift.`)
    .addFields(
      { name: "Shift", value: `${SHIFTS[shift].emoji} ${shift} · ${planning.dayLabel(date)}`, inline: true },
      ...(min ? [{ name: "Durée", value: `${min} min`, inline: true }] : []),
      ...(raison ? [{ name: "Raison", value: raison }] : [])
    )
    .setTimestamp(t);
  let sent = "";
  try {
    const ch = await client.channels.fetch(CLOCKING_CHANNEL_ID);
    await ch.send({ content: `<@${m.id}>`, embeds: [embed], allowedMentions: { users: [m.id] } });
    sent = `🔔 Notifié dans <#${CLOCKING_CHANNEL_ID}>.`;
  } catch (e) {
    console.error("Coupure (salon clocking) :", e.message);
    sent = `⚠️ Message pas envoyé dans le salon clocking : ${String(e.message || e).slice(0, 200)}`;
  }
  return done(
    i,
    [`✂️ Coupure pour <@${m.id}> · ${SHIFTS[shift].emoji} ${shift} du ${planning.dayLabel(date)}${min ? ` · ${min} min` : ""}`, point, sent].join("\n"),
    60000
  );
}

// ================== CLOCK IN ==================
async function startClockIn(i, shift) {
  const uid = i.user.id;
  if (!data.chatteurs[uid])
    return reply(i, { content: "❌ Tu n'es pas dans la liste des chatteurs. Demande à un admin." });
  const cur = data.sessions[uid];
  if (cur)
    return reply(i, { content: `⚠️ Tu es déjà clock in depuis ${fmtTime(cur.clockIn)} (shift ${cur.shift}). Clock out d'abord.` });
  if (data.modeles.length === 0)
    return reply(i, { content: "❌ Aucun modèle configuré." });

  await i.deferReply({ flags: EPHEMERAL });
  // les modèles prévues pour lui au planning de l'app sont déjà cochées
  let plan = [];
  if (appSync.enabled())
    try {
      const accts = await appSync.plannedAccts(uid, namesOf(i), shift, Date.now());
      if (accts.length) {
        const cat = await appSync.appCatalog();
        plan = [...new Set(accts.map((k) => modeleForAcct(k, cat)?.name).filter(Boolean))];
      }
    } catch (e) {
      console.error("Planning du clock in :", e.message);
    }
  clockInDraft.set(uid, { shift, modeles: plan, plan });
  // Pas de suppression auto : le chatteur doit avoir le temps de choisir
  return i.editReply(clockInView(uid));
}

async function validateClockIn(i, shift) {
  const uid = i.user.id;
  const d = clockInDraft.get(uid);
  if (!d?.modeles.length) return reply(i, { content: "❌ Choisis au moins un modèle." });
  if (data.sessions[uid]) return done(i, "⚠️ Tu es déjà clock in.");
  await i.deferUpdate();
  const t = Date.now();
  const s = (data.sessions[uid] = { shift, clockIn: t, modeles: d.modeles });
  clockInDraft.delete(uid);
  saveData();

  const { late, isLate } = appSync.lateness(appSync.SLOT_OF[shift], t);
  const ch = await client.channels.fetch(CLOCKING_CHANNEL_ID);
  await ch.send({ embeds: [clockEmbed("in", uid, s, t, isLate ? late : 0)], allowedMentions: { parse: [] } });
  const note = await syncClockIn(i, shift, t);
  return done(i, [`✅ Clock in enregistré à **${fmtTime(t)}** · ${shiftTxt(shift)}`, isLate ? `⏰ ${late} min de retard.` : "", note].filter(Boolean).join("\n"));
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
      data.sessions[uid].app = { date: r.date, key: r.key };
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
  outDraft.set(uid, { modeles: s.modeles.filter((n) => outOptions(s).includes(n)) });
  // Pas de suppression auto : le menu reste jusqu'à la fin du clock out
  return reply(i, clockOutView(uid), false);
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
    const clockCh = await client.channels.fetch(CLOCKING_CHANNEL_ID);
    await clockCh.send({ embeds: [clockEmbed("out", uid, { ...s, modeles }, tOut)], allowedMentions: { parse: [] } });
    appSync.onClockOut({ app: s.app, t: tOut }).catch((e) => console.error("Pointage app (clock out) :", e.message));

    return done(i, `✅ Shift terminé à **${fmtTime(tOut)}** (${fmtDuration(tOut - s.clockIn)}).${ventes.length ? ` Fiche envoyée dans <#${VENTES_CHANNEL_ID}>.` : ""}`);
  } finally {
    closing.delete(uid);
  }
}

if (require.main === module) client.login(TOKEN);
// pour les tests
module.exports = { client, handleInteraction, postPlanning, postEffectif, pollPost, sweep, parseDay, dayChoices, getData: () => data, SHIFTS };
