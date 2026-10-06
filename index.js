const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, SlashCommandBuilder, REST, Routes, PermissionFlagsBits,
} = require("discord.js");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

// ================== CONFIG ==================
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const CLOCKING_CHANNEL_ID = process.env.CLOCKING_CHANNEL_ID;
const VENTES_CHANNEL_ID = process.env.VENTES_CHANNEL_ID;
const TZ = "Europe/Paris";

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
  sessions: {}, // userId -> { shift, clockIn, modeles, messageId }
  historique: [], // shifts terminés (pour /stats)
};

let data = DEFAULT_DATA;
function loadData() {
  try {
    data = { ...DEFAULT_DATA, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
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
const deviseOf = (modeleName) =>
  data.modeles.find((m) => m.name === modeleName)?.devise || "$";
const isAdmin = (i) => i.memberPermissions.has(PermissionFlagsBits.Administrator);

// Brouillons de fiches de ventes en cours (en mémoire)
const fiches = new Map(); // userId -> { ventes: [], currentModele }

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ================== COMPOSANTS ==================
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
      .setCustomId("clockout")
      .setLabel("Clock Out")
      .setEmoji("🔴")
      .setStyle(ButtonStyle.Danger)
  );

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
  else
    for (const v of f.ventes)
      txt += `• ${v.fan} → ${v.montant}${deviseOf(v.modele)} (${v.modele})\n`;
  return txt;
}

// ================== ANNONCES AUTO ==================
async function announceShift(name) {
  const sh = SHIFTS[name];
  const ch = await client.channels.fetch(CLOCKING_CHANNEL_ID);
  await ch.send({
    content: `🔔 **C'est l'heure du shift ${name} (${sh.label})**\nPensez bien à Clock-in ceux du ${name.toLowerCase()} et bon shift ${sh.emoji}`,
    components: [clockInRow(name)],
  });
  await ch.send({ content: "Pour terminer ton shift :", components: [clockOutRow()] });
}

// 15 min avant chaque shift (heure de Paris)
for (const [name, sh] of Object.entries(SHIFTS)) {
  const hour = (sh.start - 1 + 24) % 24; // 15 min avant => hh-1:45
  cron.schedule(`45 ${hour} * * *`, () => announceShift(name), { timezone: TZ });
}

// ================== COMMANDES ==================
const commands = [
  new SlashCommandBuilder()
    .setName("chatteur_add")
    .setDescription("Ajouter un chatteur au clocking")
    .addUserOption((o) => o.setName("membre").setDescription("Le chatteur").setRequired(true))
    .addStringOption((o) =>
      o.setName("shift").setDescription("Son shift").setRequired(true)
        .addChoices(...Object.entries(SHIFTS).map(([k, v]) => ({ name: `${k} (${v.label})`, value: k })))
    ),
  new SlashCommandBuilder()
    .setName("chatteur_remove")
    .setDescription("Retirer un chatteur")
    .addUserOption((o) => o.setName("membre").setDescription("Le chatteur").setRequired(true)),
  new SlashCommandBuilder().setName("chatteur_list").setDescription("Liste des chatteurs"),
  new SlashCommandBuilder()
    .setName("modele_add")
    .setDescription("Ajouter un modèle")
    .addStringOption((o) => o.setName("nom").setDescription("Ex : Zoé (Inflow)").setRequired(true))
    .addStringOption((o) =>
      o.setName("devise").setDescription("Devise").setRequired(true)
        .addChoices({ name: "Dollar ($)", value: "$" }, { name: "Euro (€)", value: "€" })
    ),
  new SlashCommandBuilder()
    .setName("modele_remove")
    .setDescription("Retirer un modèle")
    .addStringOption((o) => o.setName("nom").setDescription("Nom exact").setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName("modele_list").setDescription("Liste des modèles"),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Statistiques des ventes")
    .addStringOption((o) =>
      o.setName("periode").setDescription("Période").setRequired(true)
        .addChoices(
          { name: "Aujourd'hui", value: "today" },
          { name: "7 derniers jours", value: "week" },
          { name: "30 derniers jours", value: "month" },
          { name: "Tout", value: "all" }
        )
    )
    .addUserOption((o) => o.setName("membre").setDescription("Filtrer sur un chatteur")),
  new SlashCommandBuilder().setName("clockout").setDescription("Terminer ton shift"),
].map((c) => c.toJSON());

client.once("ready", async () => {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log(`Connecté en tant que ${client.user.tag}`);
});

// ================== INTERACTIONS ==================
client.on("interactionCreate", async (i) => {
  try {
    const uid = i.user.id;

    // ---------- Autocomplete ----------
    if (i.isAutocomplete()) {
      const focus = i.options.getFocused().toLowerCase();
      return i.respond(
        data.modeles.filter((m) => m.name.toLowerCase().includes(focus)).slice(0, 25)
          .map((m) => ({ name: m.name, value: m.name }))
      );
    }

    // ---------- Slash commands ----------
    if (i.isChatInputCommand()) {
      const adminCmds = ["chatteur_add", "chatteur_remove", "chatteur_list", "modele_add", "modele_remove", "modele_list", "stats"];
      if (adminCmds.includes(i.commandName) && !isAdmin(i))
        return i.reply({ content: "❌ Admin uniquement.", ephemeral: true });

      switch (i.commandName) {
        case "chatteur_add": {
          const m = i.options.getUser("membre");
          const s = i.options.getString("shift");
          data.chatteurs[m.id] = s;
          saveData();
          return i.reply({ content: `✅ <@${m.id}> ajouté au shift **${s}**.`, ephemeral: true });
        }
        case "chatteur_remove": {
          const m = i.options.getUser("membre");
          delete data.chatteurs[m.id];
          saveData();
          return i.reply({ content: `🗑️ <@${m.id}> retiré.`, ephemeral: true });
        }
        case "chatteur_list": {
          const txt = Object.entries(data.chatteurs).map(([u, s]) => `<@${u}> — ${s}`).join("\n") || "Aucun chatteur.";
          return i.reply({ content: txt, ephemeral: true });
        }
        case "modele_add": {
          const nom = i.options.getString("nom");
          const devise = i.options.getString("devise");
          if (data.modeles.find((m) => m.name === nom))
            return i.reply({ content: "⚠️ Ce modèle existe déjà.", ephemeral: true });
          data.modeles.push({ name: nom, devise });
          saveData();
          return i.reply({ content: `✅ Modèle **${nom}** (${devise}) ajouté.`, ephemeral: true });
        }
        case "modele_remove": {
          const nom = i.options.getString("nom");
          data.modeles = data.modeles.filter((m) => m.name !== nom);
          saveData();
          return i.reply({ content: `🗑️ Modèle **${nom}** retiré.`, ephemeral: true });
        }
        case "modele_list": {
          const txt = data.modeles.map((m) => `• ${m.name} (${m.devise})`).join("\n") || "Aucun modèle.";
          return i.reply({ content: txt, ephemeral: true });
        }
        case "stats":
          return handleStats(i);
        case "clockout":
          return startClockOut(i);
      }
    }

    // ---------- Boutons ----------
    if (i.isButton()) {
      // Clock In
      if (i.customId.startsWith("clockin_")) {
        const shift = i.customId.split("_")[1];
        if (!data.chatteurs[uid])
          return i.reply({ content: "❌ Tu n'es pas dans la liste des chatteurs.", ephemeral: true });
        if (data.sessions[uid])
          return i.reply({ content: "⚠️ Tu es déjà clock in.", ephemeral: true });
        if (data.modeles.length === 0)
          return i.reply({ content: "❌ Aucun modèle configuré.", ephemeral: true });
        return i.reply({
          content: "Choisis ton/tes modèle(s) :",
          ephemeral: true,
          components: [
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(`clockin_models_${shift}`)
                .setPlaceholder("Modèle(s)")
                .setMinValues(1)
                .setMaxValues(data.modeles.length)
                .addOptions(data.modeles.map((m) => ({ label: m.name, value: m.name })))
            ),
          ],
        });
      }

      // Clock Out
      if (i.customId === "clockout") return startClockOut(i);

      // Fiche : ajouter une vente
      if (i.customId === "fiche_add") {
        const f = fiches.get(uid);
        if (!f) return i.reply({ content: "Session expirée, refais /clockout.", ephemeral: true });
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
      // Choix des modèles au clock in
      if (i.customId.startsWith("clockin_models_")) {
        const shift = i.customId.split("_")[2];
        const t = Date.now();
        data.sessions[uid] = { shift, clockIn: t, modeles: i.values };
        saveData();
        await i.update({ content: "✅ Clock in enregistré !", components: [] });
        const ch = await client.channels.fetch(CLOCKING_CHANNEL_ID);
        return ch.send(`<@${uid}> CLOCK IN ✅ ${fmtTime(t)} | Shift ${shift} | Modèle(s) : ${i.values.join(", ")}`);
      }
      // Choix du modèle dans la fiche
      if (i.customId === "fiche_modele") {
        const f = fiches.get(uid);
        const s = data.sessions[uid];
        if (!f || !s) return i.reply({ content: "Session expirée.", ephemeral: true });
        f.currentModele = i.values[0];
        return i.update({ content: ficheText(uid), components: ficheComponents(uid, s) });
      }
    }

    // ---------- Modal ----------
    if (i.isModalSubmit() && i.customId === "fiche_modal") {
      const f = fiches.get(uid);
      const s = data.sessions[uid];
      if (!f || !s) return i.reply({ content: "Session expirée.", ephemeral: true });
      const fan = i.fields.getTextInputValue("fan");
      const montant = parseFloat(i.fields.getTextInputValue("montant").replace(",", ".").replace(/[$€\s]/g, ""));
      if (isNaN(montant)) return i.reply({ content: "❌ Montant invalide.", ephemeral: true });
      f.ventes.push({ modele: f.currentModele, fan, montant });
      return i.update({ content: ficheText(uid), components: ficheComponents(uid, s) });
    }
  } catch (err) {
    console.error(err);
    if (!i.replied && !i.deferred) i.reply({ content: "❌ Erreur.", ephemeral: true }).catch(() => {});
  }
});

// ================== CLOCK OUT ==================
async function startClockOut(i) {
  const uid = i.user.id;
  const s = data.sessions[uid];
  if (!s) return i.reply({ content: "❌ Tu n'es pas clock in.", ephemeral: true });
  fiches.set(uid, { ventes: [], currentModele: s.modeles[0] });
  return i.reply({ content: ficheText(uid), components: ficheComponents(uid, s), ephemeral: true });
}

async function finalizeClockOut(i) {
  const uid = i.user.id;
  const s = data.sessions[uid];
  const f = fiches.get(uid);
  if (!s || !f) return i.reply({ content: "Session introuvable.", ephemeral: true });

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
      { name: "📊 Shift", value: s.shift },
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
  await ventesCh.send({ embeds: [embed] });
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

  return i.update({ content: "✅ Shift terminé, fiche envoyée !", components: [] });
}

// ================== STATS ==================
async function handleStats(i) {
  const periode = i.options.getString("periode");
  const membre = i.options.getUser("membre");
  const now = Date.now();
  const limits = { today: 24 * 3600e3, week: 7 * 24 * 3600e3, month: 30 * 24 * 3600e3, all: Infinity };
  const since = now - limits[periode];

  const list = data.historique.filter(
    (h) => h.clockOut >= since && (!membre || h.userId === membre.id)
  );
  if (!list.length) return i.reply({ content: "Aucun shift sur cette période.", ephemeral: true });

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

  const embed = new EmbedBuilder()
    .setTitle(`📈 Stats — ${{ today: "Aujourd'hui", week: "7 jours", month: "30 jours", all: "Total" }[periode]}`)
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

  return i.reply({ embeds: [embed], ephemeral: true });
}

client.login(TOKEN);
