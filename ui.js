// ================== PETITS OUTILS DISCORD (partagés par tous les menus du bot) ==================
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require("discord.js");

const EPHEMERAL_TTL = 25000; // 25 secondes
const EPHEMERAL = MessageFlags.Ephemeral;

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
// Affiche une vue dans le message éphémère en cours (ou dans un nouveau, s'il vient d'un message public)
async function showView(i, view, fresh = false) {
  const payload = { content: "", embeds: [], allowedMentions: { parse: [] }, ...view };
  if (fresh) return i.deferred || i.replied ? i.followUp({ ...payload, flags: EPHEMERAL }) : i.reply({ ...payload, flags: EPHEMERAL });
  return i.deferred || i.replied ? i.editReply(payload) : i.update(payload);
}

const row = (...c) => new ActionRowBuilder().addComponents(...c);
function button(id, label, emoji, style, disabled = false) {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
  return emoji ? b.setEmoji(emoji) : b;
}
const opt = (label, value, description, emoji, def) => ({
  label: String(label).slice(0, 100), value: String(value),
  ...(description ? { description: String(description).slice(0, 100) } : {}), ...(emoji ? { emoji } : {}), ...(def ? { default: true } : {}),
});
const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, k) => list.slice(k * n, k * n + n));
// Menus de choix : 25 choix par menu (limite Discord), `max` menus au plus ; id de chaque menu : `${id}_${n}`
function selectMenus(id, options, { placeholder, multi = false, max = 2, chosen = [] } = {}) {
  const groups = chunk(options, 25).slice(0, max);
  return groups.map((g, k) =>
    row(
      new StringSelectMenuBuilder()
        .setCustomId(`${id}_${k}`)
        .setPlaceholder(String(groups.length > 1 ? `${placeholder} (${k + 1}/${groups.length})` : placeholder).slice(0, 150))
        .setMinValues(multi ? 0 : 1)
        .setMaxValues(multi ? g.length : 1)
        .addOptions(g.map((o) => ({ ...o, default: chosen.includes(o.value) })))
    )
  );
}
const fit = (lines, max = 1024) => {
  let out = "";
  for (const l of lines) {
    if (out.length + l.length + 3 > max) return out + "\n…";
    out += (out ? "\n" : "") + l;
  }
  return out;
};
const plS = (n) => (n > 1 ? "s" : "");

module.exports = { EPHEMERAL, EPHEMERAL_TTL, reply, done, showView, row, button, opt, chunk, selectMenus, fit, plS, ButtonStyle };
