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

const ANNOUNCEMENTS = [
  { shift: "MATIN", hour: 7, minute: 45 }, // 08h - 15min
  { shift: "APREM", hour: 13, minute: 45 }, // 14h - 15min
  { shift: "SOIR", hour: 19, minute: 45 }, // 20h - 15min
  { shift: "NUIT", hour: 1, minute: 45 }, // 02h - 15min
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

function isAdmin(interaction) {
  return interaction.member.permissions.has(ADMIN_PERM) || data.admins.includes(interaction.user.id);
}

function deviseOf(modeleName) {
  return data.modeles.find((m) => m.name === modeleName)?.devise || "?";
}

function fmtTime(ms) {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function fmtDuration(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function fmtMoney(stats) {
  const parts = [];
  if (stats.$) parts.push(`$${stats.$}`);
  if (stats["€"]) parts.push(`€${stats["€"]}`);
  return parts.join(" + ") || "-";
}

function clockInRow(shift) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`btn_clockin_${shift}`)
      .setLabel("Clock In")
      .setStyle(ButtonStyle.Success)
  );
}

function clockOutRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("btn_clockout")
      .setLabel("Clock Out")
      .setStyle(ButtonStyle.Danger)
  );
}

function ficheComponents(uid, session) {
  const modelesRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("menu_fiche_modele")
      .setPlaceholder("Choisir un modèle...")
      .addOptions(data.modeles.map((m) => ({ label: m.name, value: m.name })))
  );

  const f = fiches.get(uid);
  const formRow = new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId("input_fan")
      .setLabel("Nom du fan")
      .setStyle(TextInputStyle.Short)
      .setRequired(true),
    new TextInputBuilder()
      .setCustomId("input_montant")
      .setLabel(`Montant (${f.currentModele ? deviseOf(f.currentModele) : "?"})`
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
  );

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("btn_add_vente")
      .setLabel("➕ Ajouter une vente")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("btn_finish_fiche")
      .setLabel("✅ Valider")
      .setStyle(ButtonStyle.Success)
  );

  return [modelesRow, buttonRow];
}

function ficheText(uid) {
  const f = fiches.get(uid);
  let txt = `📝 **Fiche de ventes**\nModèle sélectionné : **${f.currentModele}**\n\n`;
  if (f.ventes.length === 0) txt += "*Aucune vente ajoutée.*";
  else
    for (const v of f.ventes)
      txt += `• ${v.fan} → ${v.montant}${deviseOf(v.modele)} (${v.modele})\n`;
  return txt;
}

// ================== CLIENT ==================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

loadData();

// ================== ANNONCES AUTO ==================
async function announceShift(name) {
  const sh = SHIFTS[name];
  const ch = await client.channels.fetch(CLOCKING_CHANNEL_ID);
  await ch.send({
    content: `🔔 **C'est l'heure du shift ${name} (${sh.label})**\nPensez bien à Clock-in ceux du shift ${name.toLowerCase()} et bon shift ${sh.emoji}`,
    components: [clockInRow(name), clockOutRow()],
  });
}

// ================== COMMANDES ==================
const periodeChoices = [
  { name: "Aujourd'hui", value: "today" },
  { name: "7 jours", value: "week" },
  { name: "15 jours", value: "fifteendays" },
  { name: "30 jours", value: "month" },
  { name: "Total", value: "all" },
];

const commands = [
  // ========== CHATTEURS (tout le monde) ==========
  new SlashCommandBuilder()
    .setName("clockin")
    .setDescription("Commencer ton shift"),
  new SlashCommandBuilder()
    .setName("clockout")
    .setDescription("Terminer ton shift"),
  new SlashCommandBuilder()
    .setName("mystats")
    .setDescription("Voir tes propres stats")
    .addStringOption((o) =>
      o.setName("periode").setDescription("Période").setRequired(true).addChoices(...periodeChoices)
    ),

  // ========== ADMINS ==========
  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Envoyer le message de shift")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .addStringOption((o) =>
      o.setName("shift").setDescription("Quel shift ?").setRequired(true)
        .addChoices(
          { name: "MATIN (08h-14h)", value: "MATIN" },
          { name: "APREM (14h-20h)", value: "APREM" },
          { name: "SOIR (20h-02h)", value: "SOIR" },
          { name: "NUIT (02h-08h)", value: "NUIT" }
        )
    ),
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
    .addStringOption((o) => o.setName("nom").setDescription("Nom exact").setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName("modele_list")
    .setDescription("Liste des modèles")
    .setDefaultMemberPermissions(ADMIN_PERM),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Statistiques des ventes (admin)")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .addStringOption((o) =>
      o.setName("periode").setDescription("Période").setRequired(true).addChoices(...periodeChoices)
    )
    .addUserOption((o) => o.setName("membre").setDescription("Filtrer sur un chatteur")),
  new SlashCommandBuilder()
    .setName("admin_add")
    .setDescription("Ajouter un admin")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .addUserOption((o) => o.setName("membre").setDescription("L'utilisateur").setRequired(true)),
  new SlashCommandBuilder()
    .setName("admin_remove")
    .setDescription("Retirer un admin")
    .setDefaultMemberPermissions(ADMIN_PERM)
    .addUserOption((o) => o.setName("membre").setDescription("L'utilisateur").setRequired(true)),
  new SlashCommandBuilder()
    .setName("admin_list")
    .setDescription("Liste des admins")
    .setDefaultMemberPermissions(ADMIN_PERM),
];

const ADMIN_COMMANDS = [
  "panel", "chatteur_add", "chatteur_remove", "chatteur_list",
  "modele_add", "modele_remove", "modele_list",
  "stats", "admin_add", "admin_remove", "admin_list",
];

// ================== READY ==================
client.once("ready", async () => {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log(`✅ Connecté en tant que ${client.user.tag}`);

  // Planifier les annonces
  for (const ann of ANNOUNCEMENTS) {
    const cronExpr = `${ann.minute} ${ann.hour} * * *`;
    cron.schedule(cronExpr, () => announceShift(ann.shift), { timezone: TZ });
  }
  console.log("📅 Annonces planifiées");
});

// ================== INTERACTIONS ==================
client.on("interactionCreate", async (i) => {
  try {
    const uid = i.user.id;

    // ---------- Slash commands ----------
    if (i.isChatInputCommand()) {
      if (ADMIN_COMMANDS.includes(i.commandName) && !isAdmin(i))
        return i.reply({ content: "❌ Admin uniquement.", ephemeral: true });

      switch (i.commandName) {
        case "panel": {
          const shift = i.options.getString("shift");
          const sh = SHIFTS[shift];
          await i.reply({ content: `✅ Message de shift **${shift}** envoyé.`, ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          const ch = await client.channels.fetch(CLOCKING_CHANNEL_ID);
          return ch.send({
            content: `🔔 **C'est l'heure du shift ${shift} (${sh.label})**\nPensez bien à Clock-in ceux du shift ${shift.toLowerCase()} et bon shift ${sh.emoji}`,
            components: [clockInRow(shift), clockOutRow()],
          });
        }
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
          const txt = Object.entries(data.chatteurs).map(([u, s]) => `<@${u}> — ${s}`).join("\n") || "Aucun chatteur.";
          const reply = await i.reply({ content: txt, ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        case "modele_add": {
          const nom = i.options.getString("nom");
          const devise = i.options.getString("devise");
          if (data.modeles.find((m) => m.name === nom))
            return i.reply({ content: "⚠️ Ce modèle existe déjà.", ephemeral: true });
          data.modeles.push({ name: nom, devise });
          saveData();
          const reply = await i.reply({ content: `✅ Modèle **${nom}** (${devise}) ajouté.`, ephemeral: true });
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
        case "modele_list": {
          const txt = data.modeles.map((m) => `• ${m.name} (${m.devise})`).join("\n") || "Aucun modèle.";
          const reply = await i.reply({ content: txt, ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        case "mystats":
          return handleStats(i, true);
        case "stats":
          return handleStats(i, false);
        case "admin_add": {
          const m = i.options.getUser("membre");
          if (!data.admins.includes(m.id)) data.admins.push(m.id);
          saveData();
          const reply = await i.reply({ content: `✅ <@${m.id}> est admin.`, ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        case "admin_remove": {
          const m = i.options.getUser("membre");
          data.admins = data.admins.filter((id) => id !== m.id);
          saveData();
          const reply = await i.reply({ content: `🗑️ <@${m.id}> n'est plus admin.`, ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        case "admin_list": {
          const txt = data.admins.map((id) => `<@${id}>`).join("\n") || "Aucun admin personnalisé.";
          const reply = await i.reply({ content: txt, ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        case "clockin": {
          if (!data.chatteurs[uid])
            return i.reply({ content: "❌ Tu n'es pas dans la liste des chatteurs.", ephemeral: true });
          if (data.sessions[uid])
            return i.reply({ content: "⚠️ Tu es déjà clock in.", ephemeral: true });
          if (data.modeles.length === 0)
            return i.reply({ content: "❌ Aucun modèle configuré.", ephemeral: true });
          const shift = data.chatteurs[uid];
          const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("menu_clockin_models")
              .setPlaceholder("Choisir tes modèles...")
              .setMinValues(1)
              .setMaxValues(data.modeles.length)
              .addOptions(data.modeles.map((m) => ({ label: m.name, value: m.name })))
          );
          const reply = await i.reply({ content: "Sélectionne tes modèles :", components: [row], ephemeral: true });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
        case "clockout": {
          if (!data.sessions[uid])
            return i.reply({ content: "❌ Tu n'es pas clock in.", ephemeral: true });
          const s = data.sessions[uid];
          fiches.set(uid, { currentModele: s.modeles[0], ventes: [] });
          const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("menu_fiche_modele")
              .setPlaceholder("Choisir un modèle...")
              .addOptions(data.modeles.map((m) => ({ label: m.name, value: m.name })))
          );
          const buttonRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("btn_add_vente")
              .setLabel("➕ Ajouter une vente")
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId("btn_finish_fiche")
              .setLabel("✅ Valider")
              .setStyle(ButtonStyle.Success)
          );
          const reply = await i.reply({
            content: ficheText(uid),
            components: [row, buttonRow],
            ephemeral: true,
          });
          setTimeout(() => i.deleteReply().catch(() => {}), EPHEMERAL_TTL);
          return;
        }
      }
    }

    // ---------- Boutons ----------
    if (i.isButton()) {
      // Clock Out
      if (i.customId === "btn_clockout") {
        if (!data.sessions[uid])
          return i.reply({ content: "❌ Tu n'es pas clock in.", ephemeral: true });
        const s = data.sessions[uid];
        fiches.set(uid, { currentModele: s.modeles[0], ventes: [] });
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("menu_fiche_modele")
            .setPlaceholder("Choisir un modèle...")
            .addOptions(data.modeles.map((m) => ({ label: m.name, value: m.name })))
        );
        const buttonRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("btn_add_vente")
            .setLabel("➕ Ajouter une vente")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("btn_finish_fiche")
            .setLabel("✅ Valider")
            .setStyle(ButtonStyle.Success)
        );
        return i.reply({
          content: ficheText(uid),
          components: [row, buttonRow],
          ephemeral: true,
        });
      }

      // Clock In
      if (i.customId.startsWith("btn_clockin_")) {
        const shift = i.customId.split("_")[2];
        if (!data.chatteurs[uid])
          return i.reply({ content: "❌ Tu n'es pas dans la liste des chatteurs.", ephemeral: true });
        if (data.sessions[uid])
          return i.reply({ content: "⚠️ Tu es déjà clock in.", ephemeral: true });
        if (data.modeles.length === 0)
          return i.reply({ content: "❌ Aucun modèle configuré.", ephemeral: true });
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("menu_clockin_models")
            .setPlaceholder("Choisir tes modèles...")
            .setMinValues(1)
            .setMaxValues(data.modeles.length)
            .addOptions(data.modeles.map((m) => ({ label: m.name, value: m.name })))
        );
        return i.reply({ content: "Sélectionne tes modèles :", components: [row], ephemeral: true });
      }

      // Ajouter une vente
      if (i.customId === "btn_add_vente") {
        const f = fiches.get(uid);
        if (!f) return i.reply({ content: "Session expirée.", ephemeral: true });
        const modal = new ModalBuilder()
          .setCustomId("modal_vente")
          .setTitle("Ajouter une vente")
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
                .setLabel(`Montant (${deviseOf(f.currentModele)})`)
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            )
          );
        return i.showModal(modal);
      }

      // Terminer la fiche
      if (i.customId === "btn_finish_fiche") {
        return finalizeClockOut(i);
      }
    }

    // ---------- Select menus ----------
    if (i.isStringSelectMenu()) {
      // Clock In models
      if (i.customId === "menu_clockin_models") {
        const shift = data.chatteurs[uid];
        const t = Date.now();
        data.sessions[uid] = { shift, clockIn: t, modeles: i.values };
        saveData();
        await i.update({ content: "✅ Clock in enregistré !", components: [] });
        const ch = await client.channels.fetch(CLOCKING_CHANNEL_ID);
        return ch.send(`<@${uid}> CLOCK IN ✅ ${fmtTime(t)} | Shift ${shift} | Modèle(s) : ${i.values.join(", ")}`);
      }

      // Fiche modele
      if (i.customId === "menu_fiche_modele") {
        const f = fiches.get(uid);
        const s = data.sessions[uid];
        if (!f || !s) return i.reply({ content: "Session expirée.", ephemeral: true });
        f.currentModele = i.values[0];
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("menu_fiche_modele")
            .setPlaceholder("Choisir un modèle...")
            .addOptions(data.modeles.map((m) => ({ label: m.name, value: m.name })))
        );
        const buttonRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("btn_add_vente")
            .setLabel("➕ Ajouter une vente")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("btn_finish_fiche")
            .setLabel("✅ Valider")
            .setStyle(ButtonStyle.Success)
        );
        return i.update({ content: ficheText(uid), components: [row, buttonRow] });
      }
    }

    // ---------- Modals ----------
    if (i.isModalSubmit()) {
      if (i.customId === "modal_vente") {
        const fan = i.fields.getTextInputValue("input_fan");
        const montantStr = i.fields.getTextInputValue("input_montant");
        const montant = parseFloat(montantStr);
        if (isNaN(montant)) return i.reply({ content: "❌ Montant invalide.", ephemeral: true });
        const f = fiches.get(uid);
        const s = data.sessions[uid];
        if (!f || !s) return i.reply({ content: "Session expirée.", ephemeral: true });
        f.ventes.push({ fan, montant, modele: f.currentModele });
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("menu_fiche_modele")
            .setPlaceholder("Choisir un modèle...")
            .addOptions(data.modeles.map((m) => ({ label: m.name, value: m.name })))
        );
        const buttonRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("btn_add_vente")
            .setLabel("➕ Ajouter une vente")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("btn_finish_fiche")
            .setLabel("✅ Valider")
            .setStyle(ButtonStyle.Success)
        );
        return i.update({ content: ficheText(uid), components: [row, buttonRow] });
      }
    }
  } catch (err) {
    console.error(err);
    if (!i.replied && !i.deferred) i.reply({ content: "❌ Erreur.", ephemeral: true }).catch(() => {});
  }
});

// ================== CLOCK OUT FINALIZATION ==================
async function finalizeClockOut(i) {
  const uid = i.user.id;
  const s = data.sessions[uid];
  const f = fiches.get(uid);
  if (!s || !f) return i.reply({ content: "Session introuvable.", ephemeral: true });

  const tOut = Date.now();
  const duree = tOut - s.clockIn;

  const detail = {};
  let totalVentes = {};
  for (const v of f.ventes) {
    if (!detail[v.modele]) detail[v.modele] = [];
    detail[v.modele].push(v);
    totalVentes[v.modele] = (totalVentes[v.modele] || 0) + v.montant;
  }

  const embed = new EmbedBuilder()
    .setTitle("📊 Fiche de Shift")
    .setColor(0x2ecc71)
    .addFields(
      { name: "👤 Chatteur", value: `<@${uid}>`, inline: true },
      { name: "⏰ Clock In", value: fmtTime(s.clockIn), inline: true },
      { name: "⏰ Clock Out", value: fmtTime(tOut), inline: true },
      { name: "📅 Shift", value: s.shift, inline: true },
      { name: "⏳ Durée", value: fmtDuration(duree), inline: true },
      { name: "💃 Modèle(s)", value: s.modeles.join(", "), inline: true }
    );

  if (f.ventes.length) {
    const totalsStr = Object.entries(totalVentes)
      .map(([m, v]) => `**${m}** : ${v}${deviseOf(m)}`)
      .join("\n");
    embed.addFields({ name: "💰 Total par modèle", value: totalsStr });

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
  if (!list.length)
    return i.reply({ content: "Aucun shift sur cette période.", ephemeral: true });

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
