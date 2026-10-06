const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, SlashCommandBuilder, REST, Routes, PermissionFlagsBits,
} = require("discord.js");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

// ================== CONFIG ==================
const TOKEN = (process.env.DISCORD_TOKEN || "").trim();
const CLIENT_ID = (process.env.CLIENT_ID || "").trim();
const GUILD_ID = (process.env.GUILD_ID || "").trim();
const CLOCKING_CHANNEL_ID = (process.env.CLOCKING_CHANNEL_ID || "").trim();
const VENTES_CHANNEL_ID = (process.env.VENTES_CHANNEL_ID || "").trim();
const TZ = "Europe/Paris";
const EPHEMERAL_TTL = 25000; // 25 secondes

const DATA_DIR = process.env.DATA_DIR || "/data"; // Volume Railway
const DATA_FILE = path.join(DATA_DIR, "data.json");

const SHIFTS = {
  MATIN: { start: 8, label: "08h-14h", emoji: "🌞" },
  APREM: { start: 14, label: "14h-20h", emoji: "☀️" },
  SOIR: { start: 20, label: "20h-02h", emoji: "🌆" },
  NUIT: { start: 2, label: "02h-08h", emoji: "🌙" },
};

// ================== DATA ==================
const DEFAULT_DATA = {
  modeles: [
    { name: "Amélie (Inflow)", devise: "$" },
    { name: "Zoé (Inflow)", devise: "$" },
    { name: "Zoé (Uncove)", devise: "€" },
  ],
  chatteurs: {}, // userId -> shift
  sessions: {}, // userId -> { shift, clockIn, modeles }
  historique: [], // shifts terminés (pour /stats)
  admins: [], // userIds des admins du bot
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
const deviseOf = (modeleName) => data.modeles.find((m) => m.name === modeleName)?.devise || "$";

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
  const payload = { ...options, ephemeral: true };
  const msg = i.replied || i.deferred ? await i.followUp(payload) : await i.reply(payload);
  if (autoDelete) setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
  return msg;
}

// Brouillons en mémoire
const fiches = new Map(); // userId -> { ventes: [], currentModele }
const clockInDraft = new Map(); // userId -> { shift, modeles: [] }

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ================== COMPOSANTS ==================
const clockInRow = (shift) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`clockin_${shift}`)
      .setLabel("Clock In")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("clockout_btn")
      .setLabel("Clock Out")
      .setEmoji("🔴")
      .setStyle(ButtonStyle.Danger)
  );

// Menu de choix des modèles au clock in + bouton Valider
function clockInComponents(uid, shift) {
  const draft = clockInDraft.get(uid);
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`clockin_models_${shift}`)
        .setPlaceholder("Modèle(s)")
        .setMinValues(1)
        .setMaxValues(data.modeles.length)
        .addOptions(
          data.modeles.map((m) => ({
            label: m.name,
            value: m.name,
            default: draft?.modeles.includes(m.name) || false,
          }))
        )
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`clockin_validate_${shift}`)
        .setLabel("Valider le Clock In")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!draft || draft.modeles.length === 0)
    ),
  ];
}

function clockInText(uid) {
  const draft = clockInDraft.get(uid);
  return draft && draft.modeles.length
    ? `Modèle(s) choisi(s) : **${draft.modeles.join(", ")}**\nClique sur **Valider** pour confirmer.`
    : "Choisis ton/tes modèle(s) puis clique sur **Valider** :";
}

function ficheComponents(uid, session) {
  const f = fiches.get(uid);
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("fiche_modele")
        .setPlaceholder("Modèle de la vente")
        .addOptions(
          session.modeles.map((m) => ({
            label: m,
            value: m,
            default: m === f.currentModele,
          }))
        )
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("fiche_add").setLabel("➕ Ajouter une vente").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("fiche_validate").setLabel("✅ Valider").setStyle(ButtonStyle.Success)
    ),
  ];
}

function ficheText(uid) {
  const f = fiches.get(uid);
  let txt = `📝 **Fiche de ventes**\nModèle sélectionné : **${f.currentModele}**\n\n`;
  if (f.ventes.length === 0) txt += "*Aucune vente ajoutée.*";
  else for (const v of f.ventes) txt += `• ${v.fan} → ${v.montant}${deviseOf(v.modele)} (${v.modele})\n`;
  return txt;
}

// ================== ANNONCES AUTO ==================
async function announceShift(name) {
  const sh = SHIFTS[name];
  const ch = await client.channels.fetch(CLOCKING_CHANNEL_ID);
  await ch.send({
    content: `🔔 **C'est l'heure du shift ${name} (${sh.label})**\nPensez bien à Clock-in ceux du **shift ${name} (${sh.label})** et bon shift ${sh.emoji}`,
    components: [clockInRow(name)],
  });
}

// 15 min avant chaque shift (heure de Paris)
for (const [name, sh] of Object.entries(SHIFTS)) {
  const hour = (sh.start - 1 + 24) % 24; // 15 min avant => hh-1:45
  cron.schedule(`45 ${hour} * * *`, () => announceShift(name), { timezone: TZ });
}

// ================== COMMANDES ==================
const commands = [
  // ---- Chatteurs (tout le monde) ----
  new SlashCommandBuilder()
    .setName("clockin")
    .setDescription("Commencer ton shift")
    .addStringOption((o) =>
      o.setName("shift").setDescription("Ton shift").setRequired(true)
        .addChoices(...Object.entries(SHIFTS).map(([k, v]) => ({ name: `${k} (${v.label})`, value: k })))
    ),
  new SlashCommandBuilder().setName("clockout").setDescription("Terminer ton shift"),
  new SlashCommandBuilder().setName("mystats").setDescription("Voir tes propres stats")
    .addStringOption((o) =>
      o.setName("periode").setDescription("Période").setRequired(true)
        .addChoices(
          { name: "Aujourd'hui", value: "today" },
          { name: "7 derniers jours", value: "week" },
          { name: "15 derniers jours", value: "15days" },
          { name: "30 derniers jours", value: "month" },
          { name: "Tout", value: "all" }
        )
    ),

  // ---- Admins uniquement ----
  new SlashCommandBuilder()
    .setName("chatteur_add")
    .setDescription("Ajouter un chatteur au clocking")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .addUserOption((o) => o.setName("membre").setDescription("Le chatteur").setRequired(true))
    .addStringOption((o) =>
      o.setName("shift").setDescription("Son shift").setRequired(true)
        .addChoices(...Object.entries(SHIFTS).map(([k, v]) => ({ name: `${k} (${v.label})`, value: k })))
    ),
  new SlashCommandBuilder()
    .setName("chatteur_remove")
    .setDescription("Retirer un chatteur")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .addUserOption((o) => o.setName("membre").setDescription("Le chatteur").setRequired(true)),
  new SlashCommandBuilder()
    .setName("chatteur_list")
    .setDescription("Liste des chatteurs")
    .setDefaultMemberPermissions(ADMIN_PERM),
  new SlashCommandBuilder()
    .setName("modele_add")
    .setDescription("Ajouter un modèle")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .addStringOption((o) => o.setName("nom").setDescription("Ex : Zoé (Inflow)").setRequired(true))
    .addStringOption((o) =>
      o.setName("devise").setDescription("Devise").setRequired(true)
        .addChoices({ name: "Dollar ($)", value: "$" }, { name: "Euro (€)", value: "€" })
    ),
  new SlashCommandBuilder()
    .setName("modele_remove")
    .setDescription("Retirer un modèle")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .addStringOption((o) => o.setName("nom").setDescription("Nom exact du modèle").setRequired(true)),
  new SlashCommandBuilder()
    .setName("modele_list")
    .setDescription("Liste des modèles")
    .setDefaultMemberPermissions(ADMIN_PERM),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Statistiques des ventes (admin)")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .addStringOption((o) =>
      o.setName("periode").setDescription("Période").setRequired(true)
        .addChoices(
          { name: "Aujourd'hui", value: "today" },
          { name: "7 derniers jours", value: "week" },
          { name: "15 derniers jours", value: "15days" },
          { name: "30 derniers jours", value: "month" },
          { name: "Tout", value: "all" }
        )
    )
    .addUserOption((o) => o.setName("membre").setDescription("Filtrer sur un chatteur")),
  new SlashCommandBuilder()
    .setName("admin_add")
    .setDescription("Ajouter un admin du bot")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .addUserOption((o) => o.setName("membre").setDescription("Le futur admin").setRequired(true)),
  new SlashCommandBuilder()
    .setName("admin_remove")
    .setDescription("Retirer un admin du bot")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .addUserOption((o) => o.setName("membre").setDescription("L'admin à retirer").setRequired(true)),
  new SlashCommandBuilder()
    .setName("admin_list")
    .setDescription("Liste des admins du bot")
    .setDefaultMemberPermissions(ADMIN_PERM),
].map((c) => c.toJSON());

// Commandes qui nécessitent d'être admin (sécurité côté code, en plus du masquage Discord)
const ADMIN_COMMANDS = [
  "chatteur_add", "chatteur_remove", "chatteur_list",
  "modele_add", "modele_remove", "modele_list",
  "stats", "admin_add", "admin_remove", "admin_list",
];

client.once("ready", async () => {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log(`Connecté en tant que ${client.user.tag}`);
});

// ================== INTERACTIONS ==================
client.on("interactionCreate", async (i) => {
  try {
    const uid = i.user.id;

    // ---------- Slash commands ----------
    if (i.isChatInputCommand()) {
      if (ADMIN_COMMANDS.includes(i.commandName) && !isAdmin(i))
        return reply(i, { content: "⛔ Cette commande est réservée aux admins." });

      switch (i.commandName) {
        case "clockin":
          return startClockIn(i, i.options.getString("shift"));
        case "clockout":
          return startClockOut(i);
        case "mystats":
          return handleStats(i, true);
        case "stats":
          return handleStats(i, false);

        case "chatteur_add": {
          const m = i.options.getUser("membre");
          const s = i.options.getString("shift");
          data.chatteurs[m.id] = s;
          saveData();
          return reply(i, { content: `✅ <@${m.id}> ajouté au shift **${s}**.` });
        }
        case "chatteur_remove": {
          const m = i.options.getUser("membre");
          delete data.chatteurs[m.id];
          saveData();
          return reply(i, { content: `🗑️ <@${m.id}> retiré.` });
        }
        case "chatteur_list": {
          const txt =
            Object.entries(data.chatteurs).map(([u, s]) => `<@${u}> — ${s}`).join("\n") || "Aucun chatteur.";
          return reply(i, { content: txt });
        }
        case "modele_add": {
          const nom = i.options.getString("nom");
          const devise = i.options.getString("devise");
          if (data.modeles.find((m) => m.name === nom))
            return reply(i, { content: "⚠️ Ce modèle existe déjà." });
          data.modeles.push({ name: nom, devise });
          saveData();
          return reply(i, { content: `✅ Modèle **${nom}** (${devise}) ajouté.` });
        }
        case "modele_remove": {
          const nom = i.options.getString("nom");
          data.modeles = data.modeles.filter((m) => m.name !== nom);
          saveData();
          return reply(i, { content: `🗑️ Modèle **${nom}** retiré.` });
        }
        case "modele_list": {
          const txt = data.modeles.map((m) => `• ${m.name} (${m.devise})`).join("\n") || "Aucun modèle.";
          return reply(i, { content: txt });
        }
        case "admin_add": {
          const m = i.options.getUser("membre");
          if (data.admins.includes(m.id)) return reply(i, { content: "⚠️ Déjà admin du bot." });
          data.admins.push(m.id);
          saveData();
          return reply(i, { content: `✅ <@${m.id}> est maintenant admin du bot.` });
        }
        case "admin_remove": {
          const m = i.options.getUser("membre");
          data.admins = data.admins.filter((a) => a !== m.id);
          saveData();
          return reply(i, { content: `🗑️ <@${m.id}> n'est plus admin du bot.` });
        }
        case "admin_list": {
          const txt = data.admins.map((a) => `<@${a}>`).join("\n") || "Aucun admin du bot (en plus des admins Discord).";
          return reply(i, { content: txt });
        }
      }
    }

    // ---------- Boutons ----------
    if (i.isButton()) {
      // Valider le clock in (doit être AVANT "clockin_")
      if (i.customId.startsWith("clockin_validate_")) {
        const shift = i.customId.split("_")[2];
        const draft = clockInDraft.get(uid);
        if (!draft || draft.modeles.length === 0)
          return reply(i, { content: "❌ Choisis au moins un modèle." });
        if (data.sessions[uid])
          return reply(i, { content: "⚠️ Tu es déjà clock in." });

        const t = Date.now();
        data.sessions[uid] = { shift, clockIn: t, modeles: draft.modeles };
        clockInDraft.delete(uid);
        saveData();

        await i.update({ content: "✅ Clock in enregistré !", components: [] });
        setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
        const ch = await client.channels.fetch(CLOCKING_CHANNEL_ID);
        return ch.send(
          `<@${uid}> CLOCK IN ✅ ${fmtTime(t)} | Shift ${shift} | Modèle(s) : ${data.sessions[uid].modeles.join(", ")}`
        );
      }

      // Clock In (bouton du salon)
      if (i.customId.startsWith("clockin_")) {
        const shift = i.customId.split("_")[1];
        return startClockIn(i, shift);
      }

      // Clock Out (bouton du salon)
      if (i.customId === "clockout_btn") return startClockOut(i);

      // Fiche : ajouter une vente
      if (i.customId === "fiche_add") {
        const f = fiches.get(uid);
        if (!f) return reply(i, { content: "Session expirée, refais Clock Out." });
        const devise = deviseOf(f.currentModele);
        const modal = new ModalBuilder()
          .setCustomId("fiche_modal")
          .setTitle(`Vente - ${f.currentModele}`.slice(0, 45))
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("fan").setLabel("Nom du fan").setPlaceholder("ex : John")
                .setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("montant").setLabel(`Ventes PPV (${devise})`).setPlaceholder("ex : 185")
                .setStyle(TextInputStyle.Short).setRequired(true)
            )
          );
        return i.showModal(modal);
      }

      // Fiche : valider
      if (i.customId === "fiche_validate") return finalizeClockOut(i);
    }

    // ---------- Select menus ----------
    if (i.isStringSelectMenu()) {
      // Choix des modèles au clock in (ne valide plus tout seul)
      if (i.customId.startsWith("clockin_models_")) {
        const shift = i.customId.split("_")[2];
        clockInDraft.set(uid, { shift, modeles: i.values });
        return i.update({ content: clockInText(uid), components: clockInComponents(uid, shift) });
      }

      // Choix du modèle dans la fiche
      if (i.customId === "fiche_modele") {
        const f = fiches.get(uid);
        const s = data.sessions[uid];
        if (!f || !s) return reply(i, { content: "Session expirée." });
        f.currentModele = i.values[0];
        return i.update({ content: ficheText(uid), components: ficheComponents(uid, s) });
      }
    }

    // ---------- Modal ----------
    if (i.isModalSubmit() && i.customId === "fiche_modal") {
      const f = fiches.get(uid);
      const s = data.sessions[uid];
      if (!f || !s) return reply(i, { content: "Session expirée." });
      const fan = i.fields.getTextInputValue("fan");
      const montant = parseFloat(i.fields.getTextInputValue("montant").replace(",", ".").replace(/[$€\s]/g, ""));
      if (isNaN(montant)) return reply(i, { content: "❌ Montant invalide." });
      f.ventes.push({ modele: f.currentModele, fan, montant });
      return i.update({ content: ficheText(uid), components: ficheComponents(uid, s) });
    }
  } catch (err) {
    console.error(err);
    if (!i.replied && !i.deferred) i.reply({ content: "❌ Erreur.", ephemeral: true }).catch(() => {});
  }
});

// ================== CLOCK IN ==================
async function startClockIn(i, shift) {
  const uid = i.user.id;
  if (!data.chatteurs[uid])
    return reply(i, { content: "❌ Tu n'es pas dans la liste des chatteurs." });
  if (data.sessions[uid])
    return reply(i, { content: "⚠️ Tu es déjà clock in." });
  if (data.modeles.length === 0)
    return reply(i, { content: "❌ Aucun modèle configuré." });

  clockInDraft.set(uid, { shift, modeles: [] });
  // Pas de suppression auto : le chatteur doit avoir le temps de choisir
  return reply(i, { content: clockInText(uid), components: clockInComponents(uid, shift) }, false);
}

// ================== CLOCK OUT ==================
async function startClockOut(i) {
  const uid = i.user.id;
  const s = data.sessions[uid];
  if (!s) return reply(i, { content: "❌ Tu n'es pas clock in." });
  fiches.set(uid, { ventes: [], currentModele: s.modeles[0] });
  // Pas de suppression auto : la fiche reste jusqu'à validation
  return reply(i, { content: ficheText(uid), components: ficheComponents(uid, s) }, false);
}

async function finalizeClockOut(i) {
  const uid = i.user.id;
  const s = data.sessions[uid];
  const f = fiches.get(uid);
  if (!s || !f) return reply(i, { content: "Session introuvable." });

  const tOut = Date.now();
  const duree = tOut - s.clockIn;

  // Totaux par devise + détail par modèle
  const totaux = { $: 0, "€": 0 };
  const detail = {};
  for (const v of f.ventes) {
    const d = deviseOf(v.modele);
    totaux[d] += v.montant;
    (detail[v.modele] ||= []).push(v);
  }
  const ventesTxt =
    Object.entries(totaux).filter(([, m]) => m > 0).map(([d, m]) => `${m}${d}`).join(" + ") || "0";

  const embed = new EmbedBuilder()
    .setTitle(`🔴 SHIFT TERMINÉ - ${i.member.displayName}`)
    .setColor(0xe74c3c)
    .setTimestamp(tOut)
    .addFields(
      { name: "👤 Chatteur", value: `<@${uid}>` },
      { name: "📊 Shift", value: `${s.shift} (${SHIFTS[s.shift]?.label || ""})` },
      { name: "🕐 Arrivée", value: fmtTime(s.clockIn), inline: true },
      { name: "🕒 Départ", value: fmtTime(tOut), inline: true },
      { name: "⏱️ Durée", value: fmtDuration(duree), inline: true },
      { name: "👥 Modèles", value: s.modeles.join(", ") },
      { name: "💰 Ventes", value: ventesTxt }
    );

  if (f.ventes.length) {
    let txt = "";
    for (const [modele, list] of Object.entries(detail)) {
      const d = deviseOf(modele);
      const sub = list.reduce((a, b) => a + b.montant, 0);
      txt += `**${modele}** — ${sub}${d}\n`;
      for (const v of list) txt += `　• ${v.fan} : ${v.montant}${d}\n`;
    }
    embed.addFields({ name: "📋 Détail par modèle / fan", value: txt.slice(0, 1024) });
  }

  const ventesCh = await client.channels.fetch(VENTES_CHANNEL_ID);
  await ventesCh.send({ content: `<@${uid}>`, embeds: [embed] });
  const clockCh = await client.channels.fetch(CLOCKING_CHANNEL_ID);
  await clockCh.send(
    `<@${uid}> CLOCK OUT 🔴 ${fmtTime(tOut)} | Shift ${s.shift} | Modèle(s) : ${s.modeles.join(", ")}`
  );

  // Historique pour /stats
  data.historique.push({
    userId: uid, shift: s.shift, clockIn: s.clockIn, clockOut: tOut,
    modeles: s.modeles, ventes: f.ventes,
  });
  delete data.sessions[uid];
  fiches.delete(uid);
  saveData();

  await i.update({ content: "✅ Shift terminé, fiche envoyée !", components: [] });
  setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
}

// ================== STATS ==================
// self = true => /mystats (ses propres stats), sinon /stats (admin)
async function handleStats(i, self) {
  const periode = i.options.getString("periode");
  const membre = self ? i.user : i.options.getUser("membre");
  const now = Date.now();
  const day = 24 * 3600e3;
  const limits = { today: day, week: 7 * day, "15days": 15 * day, month: 30 * day, all: Infinity };
  const since = now - limits[periode];

  const list = data.historique.filter(
    (h) => h.clockOut >= since && (!membre || h.userId === membre.id)
  );
  if (!list.length) return reply(i, { content: "Aucun shift sur cette période." });

  const parUser = {};
  const parModele = {};
  for (const h of list) {
    const u = (parUser[h.userId] ||= { shifts: 0, ms: 0, $: 0, "€": 0 });
    u.shifts++;
    u.ms += h.clockOut - h.clockIn;
    for (const v of h.ventes) {
      const d = deviseOf(v.modele);
      u[d] += v.montant;
      parModele[v.modele] = (parModele[v.modele] || 0) + v.montant;
    }
  }

  const fmtMoney = (u) =>
    [u.$ > 0 ? `${u.$}$` : null, u["€"] > 0 ? `${u["€"]}€` : null].filter(Boolean).join(" + ") || "0";

  const titres = {
    today: "Aujourd'hui", week: "7 jours", "15days": "15 jours", month: "30 jours", all: "Total",
  };

  const embed = new EmbedBuilder()
    .setTitle(`📈 ${self ? "Mes stats" : "Stats"} — ${titres[periode]}`)
    .setColor(0x3498db)
    .addFields({
      name: "👤 Par chatteur",
      value:
        Object.entries(parUser)
          .map(([u, s]) => `<@${u}> — ${s.shifts} shift(s) | ${fmtDuration(s.ms)} | ${fmtMoney(s)}`)
          .join("\n")
          .slice(0, 1024) || "-",
    })
    .addFields({
      name: "💃 Par modèle",
      value:
        Object.entries(parModele)
          .map(([m, v]) => `**${m}** — ${v}${deviseOf(m)}`)
          .join("\n")
          .slice(0, 1024) || "-",
    });

  // Les stats restent affichées 60 secondes pour avoir le temps de les lire
  await i.reply({ embeds: [embed], ephemeral: true });
  setTimeout(() => i.deleteReply().catch(() => {}), 60000);
}

client.login(TOKEN);
