// ================== PETITS OUTILS DISCORD (partagés par tous les menus du bot) ==================
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags, ContainerBuilder, SectionBuilder, SeparatorBuilder, TextDisplayBuilder,
} = require("discord.js");

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

// ---------- Messages en grand (Components V2) ----------
// Le texte s'affiche à la taille d'un message (plus gros qu'un embed), avec des titres # / ##, et une Section met un
// bouton à droite de sa ligne : la colonne des box est alignée. Discord : 40 composants par message (ceux d'un
// conteneur, d'une section ou d'une rangée comptent), 4000 caractères de texte. Au-delà, la suite part dans un
// message de plus ; les rangées de boutons vont sous le dernier.
// items : { text } | { sep: true } | { text, button } ; keep : reste avec ce qui suit (un titre ne finit pas un message) ;
// cont : titre répété en haut du message suivant quand la liste y continue
const V2_MAX = 40, V2_TEXT = 3900;
function v2Messages(items, { color = null, rows = [] } = {}) {
  const rowCost = rows.reduce((n, r) => n + 1 + r.components.length, 0);
  const cap = V2_MAX - 1 - rowCost;
  const cost = (it) => (it.button ? 3 : 1);
  const pages = [];
  let page = null, n = 0, chars = 0;
  for (const it of items) {
    const len = (it.text || "").length;
    if (!page || (page.length && (n + cost(it) > cap || chars + len > V2_TEXT))) {
      // un titre resté en bas du message part avec sa liste
      const carry = [];
      while (page && page.length > 1 && (page.at(-1).keep || page.at(-1).sep)) carry.unshift(page.pop());
      page = carry.filter((x) => !x.sep);
      pages.push(page);
      n = page.reduce((a, x) => a + cost(x), 0);
      chars = page.reduce((a, x) => a + (x.text || "").length, 0);
      if (it.sep) continue;
      if (it.cont && pages.length > 1 && !page.length) page.push({ text: it.cont }), (n += 1), (chars += it.cont.length);
    }
    page.push(it);
    n += cost(it);
    chars += len;
  }
  if (!pages.length) pages.push([{ text: "\u200b" }]);
  return pages.map((items, k) => {
    const box = new ContainerBuilder();
    if (color != null) box.setAccentColor(color);
    for (const it of items) {
      if (it.sep) box.addSeparatorComponents(new SeparatorBuilder());
      else if (it.button) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(it.text)).setButtonAccessory(it.button));
      else box.addTextDisplayComponents(new TextDisplayBuilder().setContent(it.text));
    }
    return { flags: MessageFlags.IsComponentsV2, components: [box, ...(k === pages.length - 1 ? rows : [])], allowedMentions: { parse: [] } };
  });
}

// Un bout d'id neuf à chaque ouverture d'une fenêtre préremplie : Discord remet sinon le texte d'une fenêtre fermée
// sans l'envoyer (même id), même si elle montre autre chose (✏️ Axelle affichait la liste d'Anna)
const BOOT = Date.now().toString(36).slice(-4);
let seq = 0;
const fresh = () => `${BOOT}${(++seq).toString(36)}`;

module.exports = { EPHEMERAL, EPHEMERAL_TTL, reply, done, showView, row, button, opt, chunk, selectMenus, fit, plS, v2Messages, fresh, ButtonStyle };
