// ================== VOCAUX : ARRIVÉES ET DÉPARTS ==================
// Quand quelqu'un rejoint ou quitte un des vocaux suivis, une ligne est postée dans le chat du vocal Live Anna et Axelle
// (VOICE_LOG_CHANNEL_ID pour un autre salon), sans notifier personne, avec ses box à droite de son nom.
// S'il part pendant son shift (clock in, ou au planning d'un shift commencé), les admins ont deux boutons :
// ⚡ Coupure (notée tout de suite, puis quoi faire de ses box : quelqu'un le remplace, redonnées, retirées) et
// 🔁 Remplacer (la fenêtre : qui le remplace, ou ses box retirées). À son retour, s'il est en coupure : 🔙 Retour de coupure.
// Une micro-coupure (retour en moins de 30 s) n'affiche rien.
const { ButtonStyle } = require("discord.js");
const { reply, row, button } = require("./ui");

const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
// Live Zoé, Live Anna et Axelle, Live formation
const VOICE_IDS = new Set(list(process.env.VOICE_CHANNEL_IDS ?? "1553562313083326524,1548280432595050556,1548281600414978109"));
// Salon où tout est posté : le chat du vocal Live Anna et Axelle par défaut (le salon clocking était trop rempli ;
// VOICE_LOG_CHANNEL_ID vide = dans le chat de chaque vocal)
const VOICE_LOG_ID = (process.env.VOICE_LOG_CHANNEL_ID ?? "1548280432595050556").trim();
const GRACE = Math.max(0, Number(process.env.VOICE_GRACE_S ?? 30) || 0) * 1000; // micro-coupure ignorée
const BACK_WITHIN = 4 * 3600e3; // « est revenu » si parti depuis moins de 4 h

// Fourni par index.js : client, isAdmin(i), fmtTime(t), shiftText(uid), boxTag(uid), inCoupure(uid), depart(i, uid, { cut }),
// replace(i, uid) (la fenêtre 🔁 Remplacer), retour(i, uid)
const ctx = {};
const pending = new Map(); // uid -> { timer, channelId, t } : départ pas encore posté
const lastLeft = new Map(); // uid -> heure du dernier départ posté

const watched = (ch) => !!ch && VOICE_IDS.has(ch.id);
const chName = (ch) => `🔊 ${ch?.name || "vocal"}`;
// « <@id> (Box : 2️⃣ & 3️⃣) » : ses box sur son shift, à droite du nom
async function who(uid) {
  const tag = await Promise.resolve(ctx.boxTag?.(uid)).catch(() => "");
  return `<@${uid}>${tag ? ` (${tag})` : ""}`;
}

async function post(voiceCh, payload) {
  try {
    const ch = VOICE_LOG_ID ? await ctx.client.channels.fetch(VOICE_LOG_ID) : voiceCh;
    await ch.send({ allowedMentions: { parse: [] }, ...payload });
  } catch (e) {
    console.error("Message vocal :", e.message);
  }
}

async function onVoice(oldS, newS) {
  const member = newS.member || oldS.member;
  const uid = member?.id || newS.id;
  if (!uid || member?.user?.bot) return;
  const from = watched(oldS.channel) ? oldS.channel : null;
  const to = watched(newS.channel) ? newS.channel : null;
  if (oldS.channelId === newS.channelId || (!from && !to)) return; // micro, caméra, autre salon
  const t = Date.now();
  const time = ctx.fmtTime(t);

  // passe d'un vocal suivi à un autre
  if (from && to) {
    clearTimeout(pending.get(uid)?.timer);
    pending.delete(uid);
    return post(to, { content: `➡️ ${await who(uid)} est passé de **${chName(from)}** à **${chName(to)}** · ${time}` });
  }
  if (to) {
    const p = pending.get(uid);
    if (p) {
      // revenu avant que le départ soit posté : rien à dire
      clearTimeout(p.timer);
      pending.delete(uid);
      if (p.channelId === to.id) return;
    }
    const left = lastLeft.get(uid);
    lastLeft.delete(uid);
    const back = left && t - left < BACK_WITHIN;
    const [w, cut] = await Promise.all([who(uid), Promise.resolve(ctx.inCoupure?.(uid)).catch(() => false)]);
    return post(to, {
      content: back
        ? `🟢 ${w} est revenu sur **${chName(to)}** · ${time} · parti ${Math.max(1, Math.round((t - left) / 60000))} min`
        : `🟢 ${w} a rejoint **${chName(to)}** · ${time}`,
      ...(cut ? { components: [row(button(`vc_back_${uid}`, "Retour de coupure", "🔙", ButtonStyle.Success))] } : {}),
    });
  }
  // départ : posté après GRACE secondes s'il n'est pas revenu
  clearTimeout(pending.get(uid)?.timer);
  const send = async () => {
    pending.delete(uid);
    lastLeft.set(uid, t);
    const shift = await Promise.resolve(ctx.shiftText?.(uid)).catch(() => "");
    return post(from, {
      content: `🔴 ${await who(uid)} a quitté **${chName(from)}** · ${time}${shift ? ` · en shift ${shift}` : ""}`,
      ...(shift
        ? { components: [row(button(`vc_cut_${uid}`, "Coupure", "⚡", ButtonStyle.Secondary), button(`vc_rep_${uid}`, "Remplacer", "🔁", ButtonStyle.Secondary))] }
        : {}),
    });
  };
  if (!GRACE) return send();
  pending.set(uid, { channelId: from.id, t, timer: setTimeout(() => send().catch(() => {}), GRACE) });
}

// Boutons du message « a quitté » (admins)
async function handle(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const [, act, uid] = i.customId.split("_");
  if (act === "cut") return ctx.depart(i, uid, { cut: true });
  if (act === "rep") return ctx.replace ? ctx.replace(i, uid) : ctx.depart(i, uid, { cut: false });
  if (act === "back") return ctx.retour(i, uid);
  return reply(i, { content: "Ce bouton a expiré." });
}

module.exports = { ctx, onVoice, handle, VOICE_IDS, VOICE_LOG_ID };
