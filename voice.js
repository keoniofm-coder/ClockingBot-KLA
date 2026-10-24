// ================== VOCAUX : ARRIVÉES ET DÉPARTS ==================
// Quand quelqu'un rejoint ou quitte un des vocaux suivis, une ligne est postée dans le chat d'un salon
// (par défaut celui de Live Anna et Axelle), sans notifier personne. S'il part pendant son shift, les admins
// ont deux boutons : ✂️ Coupure et 🔁 Remplacer. Une micro-coupure (retour en moins de 30 s) n'affiche rien.
const { ModalBuilder, TextInputBuilder, TextInputStyle, ButtonStyle } = require("discord.js");
const { reply, row, button } = require("./ui");

const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
// Live Zoé, Live Anna et Axelle, Live formation
const VOICE_IDS = new Set(list(process.env.VOICE_CHANNEL_IDS ?? "1553562313083326524,1548280432595050556,1548281600414978109"));
// Salon où tout est posté (vide = dans le chat de chaque vocal)
const VOICE_LOG_ID = (process.env.VOICE_LOG_CHANNEL_ID ?? "1548280432595050556").trim();
const GRACE = Math.max(0, Number(process.env.VOICE_GRACE_S ?? 30) || 0) * 1000; // micro-coupure ignorée
const BACK_WITHIN = 4 * 3600e3; // « est revenu » si parti depuis moins de 4 h

// Fourni par index.js : client, isAdmin(i), fmtTime(t), sessionText(uid), openReplace(i, uid), coupure(i, uid, { min, raison })
const ctx = {};
const pending = new Map(); // uid -> { timer, channelId, t } : départ pas encore posté
const lastLeft = new Map(); // uid -> heure du dernier départ posté

const watched = (ch) => !!ch && VOICE_IDS.has(ch.id);
const chName = (ch) => `🔊 ${ch?.name || "vocal"}`;

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
    return post(to, { content: `➡️ <@${uid}> est passé de **${chName(from)}** à **${chName(to)}** · ${time}` });
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
    return post(to, {
      content: back
        ? `🟢 <@${uid}> est revenu sur **${chName(to)}** · ${time} · parti ${Math.max(1, Math.round((t - left) / 60000))} min`
        : `🟢 <@${uid}> a rejoint **${chName(to)}** · ${time}`,
    });
  }
  // départ : posté après GRACE secondes s'il n'est pas revenu
  clearTimeout(pending.get(uid)?.timer);
  const send = () => {
    pending.delete(uid);
    lastLeft.set(uid, t);
    const shift = ctx.sessionText?.(uid);
    return post(from, {
      content: `🔴 <@${uid}> a quitté **${chName(from)}** · ${time}${shift ? ` · en shift ${shift}` : ""}`,
      ...(shift
        ? { components: [row(button(`vc_cut_${uid}`, "Coupure", "✂️", ButtonStyle.Secondary), button(`vc_rep_${uid}`, "Remplacer", "🔁", ButtonStyle.Secondary))] }
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
  if (act === "cut")
    return i.showModal(
      new ModalBuilder().setCustomId(`vc_cutm_${uid}`).setTitle("Coupure").addComponents(
        row(new TextInputBuilder().setCustomId("min").setLabel("Durée en minutes (optionnel)").setPlaceholder("ex : 15").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4)),
        row(new TextInputBuilder().setCustomId("raison").setLabel("Raison (le chatteur la verra, optionnel)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200))
      )
    );
  if (act === "cutm") {
    const min = Math.round(Number(String(i.fields.getTextInputValue("min") || "").replace(",", "."))) || null;
    return ctx.coupure(i, uid, { min: min && min > 0 && min <= 720 ? min : null, raison: (i.fields.getTextInputValue("raison") || "").trim() });
  }
  if (act === "rep") return ctx.openReplace(i, uid);
  return reply(i, { content: "Ce bouton a expiré." });
}

module.exports = { ctx, onVoice, handle, VOICE_IDS, VOICE_LOG_ID };
