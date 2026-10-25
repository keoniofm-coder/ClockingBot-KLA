// ================== CHOISIR UN CHATTEUR EN TAPANT SON NOM ==================
// Dans Discord, seuls les menus de membres ont une recherche : pour choisir un chatteur parmi tous, on prend ce
// menu-là (on tape « bet », Béthel sort) et on retrouve son chatteur dans l'app (compte relié, sinon même prénom,
// sans rien relier). Ceux qui ne sont pas sur Discord ont leur liste à eux, derrière le bouton « Pas sur Discord ».
const { UserSelectMenuBuilder, StringSelectMenuBuilder, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const { row, button, opt } = require("./ui");

const unlinked = (opts, chatters) => {
  const byId = Object.fromEntries(chatters.map((c) => [c.id, c]));
  return opts.filter((o) => byId[o.value] && !byId[o.value].discordId);
};
// La ligne du choix : le menu des membres (id_u), ou (alt) la liste de ceux pas reliés à Discord (id_0).
// opts : les choix de la vue (value = id du chatteur de l'app) ; cid : le chatteur déjà choisi
function pickRow(id, { alt, opts, chatters, cid, placeholder = "Chatteur" }) {
  if (alt) {
    const l = unlinked(opts, chatters).slice(0, 25);
    const m = new StringSelectMenuBuilder().setCustomId(`${id}_0`).setPlaceholder(`${placeholder} (pas sur Discord)`.slice(0, 150));
    return row(l.length ? m.addOptions(l.map((o) => ({ ...o, default: o.value === cid }))) : m.setDisabled(true).addOptions(opt("—", "none")));
  }
  const uid = chatters.find((c) => c.id === cid)?.discordId;
  const m = new UserSelectMenuBuilder().setCustomId(`${id}_u`).setPlaceholder(`🔎 ${placeholder} : tape son nom`.slice(0, 150)).setMinValues(1).setMaxValues(1);
  return row(uid ? m.setDefaultUsers(uid) : m);
}
// Le bouton pour passer de l'un à l'autre, seulement s'il y a des chatteurs pas reliés à Discord
function altButton(id, { alt, opts, chatters }) {
  const n = unlinked(opts, chatters).length;
  if (!alt && !n) return [];
  return [button(id, alt ? "Taper un nom" : `Pas sur Discord (${n})`, alt ? "🔎" : "👤", ButtonStyle.Secondary)];
}
// Le chatteur choisi, parmi `list` (ceux qu'on peut choisir ici) : { c } ou { error }
async function picked(i, list, { why } = {}) {
  if (!i.isUserSelectMenu?.()) return { c: list.find((x) => x.id === i.values?.[0]) || null };
  const uid = i.values?.[0];
  const u = i.users?.get(uid), m = i.members?.get(uid);
  if (u?.bot) return { error: "❌ Choisis un chatteur, pas un bot." };
  const names = [m?.displayName, m?.nick, u?.globalName, u?.username].filter(Boolean);
  const c = list.find((x) => x.discordId === uid) || (await appSync.chatterOf(uid, names, false).catch(() => null));
  if (!c) return { error: `⚠️ **${names[0] || "Ce membre"}** n'est relié à aucun chatteur de l'app : relie son compte dans 👥 Chatteurs (#gestion), ou choisis-le avec 👤 Pas sur Discord.` };
  if (!list.some((x) => x.id === c.id)) return { error: `⚠️ **${c.name}** ne peut pas être choisi ici${why ? ` (${why})` : ""}.` };
  return { c: list.find((x) => x.id === c.id) };
}

module.exports = { pickRow, altButton, picked };
