// ================== UN SEUL MENU À LA FOIS ==================
// Chaque admin n'a qu'un menu du bot (message éphémère avec des boutons) ouvert à la fois : en ouvrir un autre
// supprime le précédent, et un menu qu'on ne touche plus pendant 3 min (MENU_IDLE_S dans Railway) se supprime tout seul.
// Les petits messages sans boutons (« ⛔ Réservé aux admins », « Ce menu a expiré ») ne comptent pas : ils partent seuls.
// Discord ne laisse supprimer un message éphémère qu'avec le jeton d'une interaction qui l'a ouvert ou touché
// (valable 15 min) : chaque clic sur le menu en donne un nouveau.
const { MessageFlags } = require("discord.js");

const IDLE = Math.max(1, Number(process.env.MENU_IDLE_S ?? 180) || 180) * 1000;
const MODAL_IDLE = 14 * 60e3; // une fenêtre ouverte depuis le menu : le temps de la remplir
const TOKEN = 14.5 * 60e3; // durée d'un jeton d'interaction (15 min), avec de la marge
const open = new Map(); // userId -> { id, origin, ways: [{ i, ref, t }], timer }

const flagsOf = (f) => (Array.isArray(f) ? f.reduce((a, x) => a | flagsOf(x), 0) : typeof f === "number" ? f : Number(f?.bitfield ?? f) || 0);
const ephemeral = (p) => !!p && typeof p === "object" && ((flagsOf(p.flags) & MessageFlags.Ephemeral) !== 0 || p.ephemeral === true);
const withButtons = (p) => Array.isArray(p?.components) && p.components.length > 0;
const isEphMsg = (m) => !!m && (flagsOf(m.flags) & MessageFlags.Ephemeral) !== 0;

// Supprime le menu avec le jeton le plus récent encore valable
function kill(m) {
  clearTimeout(m.timer);
  const w = m.ways.filter((x) => Date.now() - x.t < TOKEN).pop();
  if (w) w.i.deleteReply(w.ref).catch(() => {});
}
function arm(uid, m, ms = IDLE) {
  clearTimeout(m.timer);
  m.timer = setTimeout(() => {
    if (open.get(uid) === m) open.delete(uid);
    kill(m);
  }, ms);
  m.timer.unref?.();
}
const same = (m, msg) => (m.id ? m.id === msg.id : !!m.origin && msg.interactionMetadata?.id === m.origin);

// Un nouveau menu (réponse ou suite) : le précédent est supprimé
function opened(uid, i, ref, id) {
  const prev = open.get(uid);
  if (prev) kill(prev);
  const m = { id: id || null, origin: i.id, ways: [{ i, ref, t: Date.now() }] };
  open.set(uid, m);
  arm(uid, m);
  // son id, pour reconnaître les clics dessus
  if (!id)
    Promise.resolve()
      .then(() => i.fetchReply())
      .then((msg) => msg?.id && (m.id = msg.id))
      .catch(() => {});
}
// Un clic sur un menu : il reste le menu ouvert (un autre encore affiché est supprimé), le délai repart
function touched(uid, msg, way) {
  let m = open.get(uid);
  if (!m || !same(m, msg)) {
    if (m) kill(m);
    m = { id: msg.id, origin: msg.interactionMetadata?.id || null, ways: [] };
    open.set(uid, m);
  }
  m.id = msg.id;
  if (way) m.ways = [...m.ways.filter((x) => Date.now() - x.t < TOKEN).slice(-3), way];
  arm(uid, m);
}
function seen(uid, msg, ms) {
  const m = open.get(uid);
  if (m && same(m, msg)) arm(uid, m, ms);
}

// À appeler au début de chaque interaction : suit les messages éphémères que le bot ouvre pour cet utilisateur
function track(i) {
  if (!i.isRepliable?.() || !i.user) return;
  const uid = i.user.id;
  const msg = isEphMsg(i.message) ? i.message : null;
  const wrap = (name, after) => {
    const f = i[name];
    if (typeof f !== "function") return;
    i[name] = async function (...args) {
      const r = await f.apply(this, args);
      try {
        after(args[0], r);
      } catch (e) {
        console.error("Menus :", e.message);
      }
      return r;
    };
  };
  wrap("reply", (p) => ephemeral(p) && withButtons(p) && opened(uid, i, "@original"));
  wrap("deferReply", (p) => ephemeral(p) && opened(uid, i, "@original"));
  wrap("followUp", (p, r) => ephemeral(p) && withButtons(p) && r?.id && opened(uid, i, r.id, r.id));
  if (!msg) return;
  seen(uid, msg);
  // le menu mis à jour par ce clic : ce jeton peut le supprimer
  wrap("update", () => touched(uid, msg, { i, ref: "@original", t: Date.now() }));
  wrap("deferUpdate", () => touched(uid, msg, { i, ref: "@original", t: Date.now() }));
  wrap("showModal", () => seen(uid, msg, MODAL_IDLE));
}

module.exports = { track, open, IDLE };
