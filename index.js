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

const DATA_DIR = process.env.DATA_DIR || "/data";
const DATA_FILE = path.join(DATA_DIR, "data.json");

const SHIFTS = {
  MATIN: { start: 8, label: "08h-14h", emoji: "🌞" },
  APREM: { start: 14, label: "14h-20h", emoji: "☀️" },
  SOIR: { start: 20, label: "20h-02h", emoji: "🌆" },
  NUIT: { start: 2, label: "02h-08h", emoji: "🌙" },
};

const ANNOUNCEMENTS = [
  { shift: "MATIN", hour: 7, minute: 45 },
  { shift: "APREM", hour: 13, minute: 45 },
  { shift: "SOIR", hour: 19, minute: 45 },
  { shift: "NUIT", hour: 1, minute: 45 },
];

// ================== DATA ==================
let data = {};
const fiches = new Map();
const ADMIN_PERM = PermissionFlagsBits.Administrator;

function loadData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } else {
      data = {
        modeles: [
          { name: "Amélie (Inflow)", devise: "$" },
          { name: "Zoé (Inflow)", devise: "$" },
          { name: "Zoé (Uncove)", devise: "€" },
        ],
        chatteurs: {},
        sessions: {},
        historique: [],
        admins: [],
      };
      saveData();
    }
  } catch (err) {
    console.error("❌ Erreur loadData :", err);
    data = {
      modeles: [
        { name: "Amélie (Inflow)", devise: "$" },
        { name: "Zoé (Inflow)", devise: "$" },
        { name: "Zoé (Uncove)", devise: "€" },
      ],
      chatteurs: {},
      sessions: {},
      historique: [],
      admins: [],
    };
  }
}

function saveData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("❌ Erreur saveData :", err);
  }
}

loadData();

// ================== UTILITAIRES ==================
function fmtTime(ms) {
  return new Date(ms).toLocaleString("fr-FR", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDuration(ms) {
  const h = Math.floor(ms / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  return `${h}h${m}min`;
}

function fmtMoney(u) {
  return `$${u.$} / €${u["€"]}`;
}

function deviseOf(modele) {
  return data.modeles.find((m) => m.name === modele)?.devise || "$";
}

// ================== COMPOSANTS ==================
const periodeChoices = [
  { name: "Aujourd'hui", value: "today" },
  { name: "7 derniers jours", value: "week" },
  { name: "15 derniers jours", value: "fifteendays" },
  { name: "30 derniers jours", value: "month" },
  { name: "Tout", value: "all" },
];

const clockInRow = (shift) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`clockin_${shift}`)
      .setLabel("Clock In")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
  );

const clockOutRow = () =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("clockout_btn")
      .setLabel("Clock Out")
      .setEmoji("🔴")
      .setStyle(ButtonStyle.Danger)
  );

const modelesRow = (shift) =>
  new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`clockin_models_${shift}`)
      .setPlaceholder("Sélectionne tes modèles")
      .setMinValues(1)
      .setMaxValues(data.modeles.length)
      .addOptions(data.modeles.map((m) => ({ label: m.name, value: m.name })))
  );

const ficheText = (uid) =>
  `📋 **Fiche de ventes**\n<@${uid}>\nAjoute tes ventes ci-dessous ⬇️`;

const ficheComponents = (uid, s) => {
  const f = fiches.get(uid);
  const currentModele = f?.currentModele || s.modeles[0];
  const rows = [];

  rows.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("fiche_modele")
        .setPlaceholder(`Modèle actuel : ${currentModele}`)
        .addOptions(s.modeles.map((m) => ({ label: m.name, value: m.name, default: m === currentModele })))
    )
  );

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("fiche_add_vente")
        .setLabel("Ajouter une vente")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("fiche_validate")
        .setLabel("Valider et terminer")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success)
    )
  );

  return rows;
};

// ================== CLIENT ==================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ================== ANNONCES AUTO ==================
async function announceShift(shiftName) {
  const sh = SHIFTS[shiftName];
  const ch = await client.channels.fetch(CLOCKING_CHANNEL_ID);
  await ch.send({
    content: `🔔 **C'est l'heure du shift ${shiftName} (${sh.label})**\nPensez bien à Clock-in ceux du shift ${shiftName.toLowerCase()} et bon shift ${sh.emoji}`,
    components: [clockInRow(shiftName), clockOutRow()],
  });
}

for (const { shift, hour, minute } of ANNOUNCEMENTS) {
  cron.schedule(`${minute} ${hour} * * *`, () => announceShift(shift), { timezone: TZ });
}

// ================== COMMANDES ==================
const commands = [
  // ========== CHATTEURS (tout le monde) ==========
  new SlashCommandBuilder()
    .setName("clockin")
    .setDescription("Commencer ton shift")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("clockout")
    .setDescription("Terminer ton shift")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("mystats")
    .setDescription("Voir tes propres stats")
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("periode")
        .setDescription("Période")
        .setRequired(true)
        .addChoices(...periodeChoices)
    ),
  // ========== ADMINS ONLY ==========
  new SlashCommandBuilder()
    .setName("chatteur_add")
    .setDescription("Ajouter un chatteur au clocking")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .setDMPermission(false)
    .addUserOption((o) => o.setName("membre").setDescription("Le chatteur").setRequired(true))
    .addStringOption((o) =>
      o
        .setName("shift")
        .setDescription("Son shift")
        .setRequired(true)
        .addChoices(...Object.entries(SHIFTS).map(([k, v]) => ({ name: `${k} (${v.label})`, value: k })))
    ),
  new SlashCommandBuilder()
    .setName("chatteur_remove")
    .setDescription("Retirer un chatteur")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .setDMPermission(false)
    .addUserOption((o) => o.setName("membre").setDescription("Le chatteur").setRequired(true)),
  new SlashCommandBuilder()
    .setName("chatteur_list")
    .setDescription("Liste des chatteurs")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("modele_add")
    .setDescription("Ajouter un modèle")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .setDMPermission(false)
    .addStringOption((o) => o.setName("nom").setDescription("Nom du modèle").setRequired(true))
    .addStringOption((o) =>
      o
        .setName("devise")
        .setDescription("Devise")
        .setRequired(true)
        .addChoices(
          { name: "Dollars ($)", value: "$" },
          { name: "Euros (€)", value: "€" }
        )
    ),
  new SlashCommandBuilder()
    .setName("modele_remove")
    .setDescription("Retirer un modèle")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("nom")
        .setDescription("Nom du modèle")
        .setRequired(true)
        .addChoices(...data.modeles.map((m) => ({ name: m.name, value: m.name })))
    ),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Statistiques des ventes")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("periode")
        .setDescription("Période")
        .setRequired(true)
        .addChoices(...periodeChoices)
    )
    .addUserOption((o) => o.setName("membre").setDescription("Filtrer sur un chatteur")),
  new SlashCommandBuilder()
    .setName("admin_add")
    .setDescription("Ajouter un admin")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .setDMPermission(false)
    .addUserOption((o) => o.setName("membre").setDescription("L'admin").setRequired(true)),
  new SlashCommandBuilder()
    .setName("admin_remove")
    .setDescription("Retirer un admin")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .setDMPermission(false)
    .addUserOption((o) => o.setName("membre").setDescription("L'admin").setRequired(true)),
  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Envoyer le message de shift (test)")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("shift")
        .setDescription("Shift à annoncer")
        .setRequired(true)
        .addChoices(...Object.entries(SHIFTS).map(([k, v]) => ({ name: `${k} (${v.label})`, value: k })))
    ),
].map((c) => c.toJSON());

// ================== LOGIN ==================
client.once("ready", async () => {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`✅ Connecté en tant que ${client.user.tag}`);
  } catch (err) {
    console.error("❌ Erreur enregistrement commandes :", err);
  }
});

// ================== INTERACTIONS ==================
client.on("interactionCreate", async (i) => {
  try {
    const uid = i.user.id;

    // COMMANDES SLASH
    if (i.isChatInputCommand()) {
      const isAdmin = i.member?.permissions.has(ADMIN_PERM);

      switch (i.commandName) {
        case "chatteur_add": {
          const m = i.options.getUser("membre");
          const s = i.options.getString("shift");
          data.chatteurs[m.id] = s;
          saveData();
          const reply = await i.reply({ content: `✅ <@${m.id}> ajouté au shift **${s}**.`, ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        case "chatteur_remove": {
          const m = i.options.getUser("membre");
          delete data.chatteurs[m.id];
          saveData();
          const reply = await i.reply({ content: `🗑️ <@${m.id}> retiré.`, ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        case "chatteur_list": {
          const txt =
            Object.entries(data.chatteurs)
              .map(([u, s]) => `<@${u}> — ${s}`)
              .join("\n") || "Aucun chatteur.";
          const reply = await i.reply({ content: txt, ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        case "modele_add": {
          const nom = i.options.getString("nom");
          const devise = i.options.getString("devise");
          if (data.modeles.find((m) => m.name === nom)) {
            const reply = await i.reply({ content: "⚠️ Ce modèle existe déjà.", ephemeral: true });
            setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
            return;
          }
          data.modeles.push({ name: nom, devise });
          saveData();
          const reply2 = await i.reply({ content: `✅ Modèle **${nom}** (${devise}) ajouté.`, ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        case "modele_remove": {
          const nom = i.options.getString("nom");
          data.modeles = data.modeles.filter((m) => m.name !== nom);
          saveData();
          const reply = await i.reply({ content: `🗑️ Modèle **${nom}** retiré.`, ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        case "admin_add": {
          const m = i.options.getUser("membre");
          if (!data.admins) data.admins = [];
          if (!data.admins.includes(m.id)) {
            data.admins.push(m.id);
            saveData();
            const reply = await i.reply({ content: `✅ <@${m.id}> est maintenant admin.`, ephemeral: true });
            setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          } else {
            const reply = await i.reply({ content: "⚠️ Déjà admin.", ephemeral: true });
            setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          }
          return;
        }
        case "admin_remove": {
          const m = i.options.getUser("membre");
          if (!data.admins) data.admins = [];
          data.admins = data.admins.filter((id) => id !== m.id);
          saveData();
          const reply = await i.reply({ content: `🗑️ <@${m.id}> n'est plus admin.`, ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        case "stats": {
          await handleStats(i, false);
          return;
        }
        case "mystats": {
          await handleStats(i, true);
          return;
        }
        case "clockout": {
          if (!data.chatteurs[uid]) {
            const reply = await i.reply({ content: "❌ Tu n'es pas enregistré comme chatteur.", ephemeral: true });
            setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
            return;
          }
          return startClockOut(i);
        }
        case "clockin": {
          if (!data.chatteurs[uid]) {
            const reply = await i.reply({ content: "❌ Tu n'es pas enregistré comme chatteur.", ephemeral: true });
            setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
            return;
          }
          const shift = data.chatteurs[uid];
          if (data.sessions[uid]) {
            const reply = await i.reply({ content: "⚠️ Tu es déjà clock in.", ephemeral: true });
            setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
            return;
          }
          if (data.modeles.length === 0) {
            const reply = await i.reply({ content: "❌ Aucun modèle configuré.", ephemeral: true });
            setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
            return;
          }
          return i.reply({
            content: "Sélectionne tes modèles pour ce shift :",
            components: [modelesRow(shift)],
            ephemeral: true,
          });
        }
        case "panel": {
          const shift = i.options.getString("shift");
          await announceShift(shift);
          const reply = await i.reply({ content: `✅ Annonce envoyée pour le shift ${shift}.`, ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
      }
    }

    // BOUTONS
    if (i.isButton()) {
      // Clock In
      if (i.customId.startsWith("clockin_")) {
        const shift = i.customId.split("_")[1];
        if (!data.chatteurs[uid]) {
          const reply = await i.reply({ content: "❌ Tu n'es pas enregistré comme chatteur.", ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        if (data.sessions[uid]) {
          const reply = await i.reply({ content: "⚠️ Tu es déjà clock in.", ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        if (data.modeles.length === 0) {
          const reply = await i.reply({ content: "❌ Aucun modèle configuré.", ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        return i.reply({
          content: "Sélectionne tes modèles pour ce shift :",
          components: [modelesRow(shift)],
          ephemeral: true,
        });
      }

      // Clock Out bouton
      if (i.customId === "clockout_btn") {
        if (!data.chatteurs[uid]) {
          const reply = await i.reply({ content: "❌ Tu n'es pas enregistré comme chatteur.", ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        if (!data.sessions[uid]) {
          const reply = await i.reply({ content: "❌ Tu n'es pas clock in.", ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        return startClockOut(i);
      }

      // Fiche : valider
      if (i.customId === "fiche_validate") {
        return finalizeClockOut(i);
      }

      // Fiche : ajouter vente
      if (i.customId === "fiche_add_vente") {
        const s = data.sessions[uid];
        if (!s) {
          const reply = await i.reply({ content: "Session expirée.", ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        const f = fiches.get(uid);
        const modele = f?.currentModele || s.modeles[0];
        const devise = deviseOf(modele);

        const modal = new ModalBuilder()
          .setCustomId("modal_vente")
          .setTitle(`Ajouter une vente — ${modele}`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("input_fan")
                .setLabel("Nom du fan")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("input_montant")
                .setLabel(`Montant (${devise})`)
                .setStyle(TextInputStyle.Short)
                .setPlaceholder("100")
                .setRequired(true)
            )
          );
        return i.showModal(modal);
      }
    }

    // SELECT MENUS
    if (i.isStringSelectMenu()) {
      // Clock in models
      if (i.customId.startsWith("clockin_models_")) {
        const shift = i.customId.split("_")[2];
        const t = Date.now();
        data.sessions[uid] = { shift, clockIn: t, modeles: i.values };
        saveData();
        await i.update({ content: "✅ Clock in enregistré !", components: [] });
        const ch = await client.channels.fetch(CLOCKING_CHANNEL_ID);
        return ch.send(
          `<@${uid}> CLOCK IN ✅ ${fmtTime(t)} | Shift ${shift} | Modèle(s) : ${i.values.join(", ")}`
        );
      }

      // Fiche modele
      if (i.customId === "fiche_modele") {
        const f = fiches.get(uid);
        const s = data.sessions[uid];
        if (!f || !s) {
          const reply = await i.reply({ content: "Session expirée.", ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        f.currentModele = i.values[0];
        return i.update({ content: ficheText(uid), components: ficheComponents(uid, s) });
      }
    }

    // MODALS
    if (i.isModalSubmit()) {
      if (i.customId === "modal_vente") {
        const fan = i.fields.getTextInputValue("input_fan");
        const montantStr = i.fields.getTextInputValue("input_montant");
        const montant = parseFloat(montantStr);

        if (isNaN(montant) || montant <= 0) {
          const reply = await i.reply({ content: "❌ Montant invalide.", ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }

        const f = fiches.get(uid);
        const s = data.sessions[uid];
        if (!f || !s) {
          const reply = await i.reply({ content: "Session expirée.", ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }

        const modele = f.currentModele;
        f.ventes.push({ fan, montant, modele });

        await i.reply({ content: `✅ Vente ajoutée : ${fan} — ${montant}${deviseOf(modele)}`, ephemeral: true });
        setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);

        // Pas de update du message principal ici
        return;
      }
    }
  } catch (err) {
    console.error("❌ Erreur interaction :", err);
    if (!i.replied && !i.deferred) {
      i.reply({ content: "❌ Erreur.", ephemeral: true }).catch(() => {});
    }
  }
});

// ================== CLOCK OUT ==================
async function startClockOut(i) {
  const uid = i.user.id;
  const s = data.sessions[uid];
  if (!s) {
    const reply = await i.reply({ content: "❌ Tu n'es pas clock in.", ephemeral: true });
    setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
    return;
  }
  fiches.set(uid, { ventes: [], currentModele: s.modeles[0] });
  return i.reply({
    content: ficheText(uid),
    components: ficheComponents(uid, s),
    ephemeral: true,
  });
}

async function finalizeClockOut(i) {
  const uid = i.user.id;
  const s = data.sessions[uid];
  const f = fiches.get(uid);
  if (!s || !f) {
    const reply = await i.reply({ content: "Session introuvable.", ephemeral: true });
    setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
    return;
  }

  const tOut = Date.now();
  const duree = tOut - s.clockIn;

  const detail = {};
  let ventesTxt = "";
  let totalVentes = { $: 0, "€": 0 };

  for (const v of f.ventes) {
    if (!detail[v.modele]) detail[v.modele] = [];
    detail[v.modele].push(v);
    const devise = deviseOf(v.modele);
    totalVentes[devise] += v.montant;
    ventesTxt += `${v.modele} - ${v.fan} : ${v.montant}${devise}\n`;
  }

  const embed = new EmbedBuilder()
    .setTitle(`🔴 SHIFT TERMINÉ`)
    .setColor(0xe74c3c)
    .setTimestamp(tOut)
    .setDescription(`<@${uid}> — ${i.user.username}`)
    .addFields(
      { name: "📊 Shift", value: s.shift, inline: true },
      { name: "🕐 Arrivée", value: fmtTime(s.clockIn), inline: true },
      { name: "🕒 Départ", value: fmtTime(tOut), inline: true },
      { name: "⏱️ Durée", value: fmtDuration(duree), inline: true },
      { name: "👥 Modèles", value: s.modeles.join(", ") },
      {
        name: "💰 Ventes totales",
        value: totalVentes.$ > 0 || totalVentes["€"] > 0 ? `${totalVentes.$}$ / ${totalVentes["€"]}€` : "Aucune vente",
      }
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
  await ventesCh.send({ embeds: [embed] });
  const clockCh = await client.channels.fetch(CLOCKING_CHANNEL_ID);
  await clockCh.send(
    `<@${uid}> CLOCK OUT 🔴 ${fmtTime(tOut)} | Shift ${s.shift} | Modèle(s) : ${s.modeles.join(", ")}`
  );

  data.historique.push({
    userId: uid,
    shift: s.shift,
    clockIn: s.clockIn,
    clockOut: tOut,
    modeles: s.modeles,
    ventes: f.ventes,
  });
  delete data.sessions[uid];
  fiches.delete(uid);
  saveData();

  return i.update({ content: "✅ Shift terminé, fiche envoyée !", components: [] });
}

// ================== STATS ==================
async function handleStats(i, self) {
  const periode = i.options.getString("periode");
  const membre = self ? i.user : i.options.getUser("membre");

  const now = Date.now();
  const limits = {
    today: 24 * 3600e3,
    week: 7 * 24 * 3600e3,
    fifteendays: 15 * 24 * 3600e3,
    month: 30 * 24 * 3600e3,
    all: Infinity,
  };
  const since = now - limits[periode];

  const list = data.historique.filter((h) => h.clockOut >= since && h.userId === membre.id);
  if (!list.length) {
    const reply = await i.reply({ content: "Aucun shift sur cette période.", ephemeral: true });
    setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
    return;
  }

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

  const titres = {
    today: "Aujourd'hui",
    week: "7 jours",
    fifteendays: "15 jours",
    month: "30 jours",
    all: "Total",
  };

  const embed = new EmbedBuilder()
    .setTitle(`📈 ${self ? "Mes stats" : "Stats"} — ${titres[periode]}`)
    .setColor(0x3498db)
    .addFields({
      name: "👤 Chatteur",
      value: `<@${membre.id}> — ${parUser[membre.id].shifts} shift(s) | ${fmtDuration(parUser[membre.id].ms)} | ${fmtMoney(parUser[membre.id])}`,
    })
    .addFields({
      name: "💃 Par modèle",
      value:
        Object.entries(parModele)
          .map(([m, v]) => `**${m}** — ${v}${deviseOf(m)}`)
          .join("\n")
          .slice(0, 1024) || "-",
    });

  await i.reply({ embeds: [embed], ephemeral: true });
  setTimeout(() => i.deleteReply().catch(() => {}), 60000);
}

client.login(TOKEN);
