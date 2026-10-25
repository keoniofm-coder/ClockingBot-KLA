// ================== PÉNALITÉS ==================
// Le barème de l'agence, saisi à la main par un admin depuis le salon gestion (rien d'automatique avec le clocking).
// Chaque pénalité est gardée dans l'app (penalties/<id>) et annoncée dans le salon pénalités :
//   « @chatteur AVERTISSEMENT N°3 | Ne chatte pas pendant son shift » puis « Pénalité de -10 € »
// Le numéro compte les fautes du même type ce mois-ci (il repart à 1 chaque mois). Montants en euros.
const { UserSelectMenuBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const { reply, done, showView, row, button, opt, plS, EPHEMERAL } = require("./ui");

const PENALTY_CHANNEL_ID = (process.env.PENALTY_CHANNEL_ID ?? "1553910044204994601").trim();
// Fourni par index.js : isAdmin(i), client, nameOf(uid)
const ctx = {};
const states = new Map(); // userId -> état du menu en cours

// free : avertissements sans pénalité avant la première ; tiers (retards) : [n-ième retard du mois, montant]
const FAULTS = [
  { k: "retard", l: "Retard de +5 min", e: "⏰", cat: "Présence", tiers: [[3, 2], [5, 5], [8, 10], [10, 15], [12, 17], [15, 20]] },
  { k: "absence", l: "Absence non prévenue ou injustifiée", e: "📅", cat: "Présence", amount: 10, free: 0 },
  { k: "coupure", l: "Coupure de courant / internet", e: "🔌", cat: "Présence", amount: 5, free: 2 },
  { k: "erreur", l: "Erreur de chatting", e: "💬", cat: "Chatting", amount: 5, free: 2 },
  { k: "inactif", l: "Ne chatte pas pendant son shift", e: "⏸️", cat: "Chatting", amount: 10, free: 2 },
  { k: "manager", l: "N'écoute pas son manager", e: "👤", cat: "Comportement", amount: 5, free: 2 },
  { k: "respect", l: "Manque de respect", e: "🛡️", cat: "Comportement", amount: 20, free: 0 },
  { k: "vip_parle", l: "Parler à un VIP sans autorisation", e: "👑", cat: "VIP", amount: 20, free: 0 },
  { k: "vip_paye", l: "Faire payer un VIP sans autorisation", e: "💲", cat: "VIP", amount: 30, free: 0 },
];
const faultOf = (k) => FAULTS.find((f) => f.k === k);
// montant de la n-ième faute du mois (0 = avertissement seul)
function amountFor(f, n) {
  if (f.tiers) return f.tiers.reduce((a, [th, amt]) => (n >= th ? amt : a), 0);
  return n > f.free ? f.amount : 0;
}
const ruleTxt = (f) =>
  f.tiers
    ? f.tiers.map(([th, amt]) => `${th}e -${amt} €`).join(", ")
    : f.free ? `${f.free} avertissements, puis -${f.amount} €` : `-${f.amount} € dès la 1re fois`;
const euros = (n) => `${Number(n).toLocaleString("fr-FR")} €`;

const today = () => appSync.parisParts(Date.now()).date;
const monthOf = (date) => date.slice(0, 7);
const addMonths = (m, n) => {
  const d = new Date(`${m}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};
const monthLabel = (m) => new Date(`${m}-01T12:00:00Z`).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
const dayShort = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Le message du salon : « @chatteur AVERTISSEMENT N°3 | Ne chatte pas pendant son shift » + la pénalité
const lineOf = (p) =>
  [`<@${p.uid}> **AVERTISSEMENT N°${p.n}** | ${p.label}`, p.amount ? `Pénalité de **-${euros(p.amount)}**` : "", p.note ? `-# ${p.note}` : ""]
    .filter(Boolean)
    .join("\n");

// ---------- Vues ----------
const VIEWS = {
  // Nouvelle pénalité : le chatteur, la faute ; le numéro et le montant suivent le barème
  async add(st) {
    const m = monthOf(today());
    const list = st.uid ? (await appSync.penaltiesIn(m)).filter((p) => p.uid === st.uid) : [];
    const f = faultOf(st.fault);
    const n = f ? list.filter((p) => p.fault === f.k).length + 1 : 0;
    const amount = f ? amountFor(f, n) : 0;
    st.next = f ? { n, amount } : null;
    const total = list.reduce((a, p) => a + (Number(p.amount) || 0), 0);
    return {
      content: [
        st.note,
        `⚠️ **Pénalités** · ${monthLabel(m)}`,
        "Choisis le chatteur et la faute : le numéro d'avertissement et la pénalité suivent le barème (le compteur repart à 1 chaque mois). Le message part dans le salon pénalités.",
        st.uid ? `Chatteur : <@${st.uid}> · ce mois-ci : ${list.length ? `${list.length} avertissement${plS(list.length)}${total ? `, -${euros(total)}` : ""}` : "rien"}` : "",
        f ? `\n${f.e} **AVERTISSEMENT N°${n}** | ${f.l}\n${amount ? `Pénalité de **-${euros(amount)}**` : "_Avertissement seul, sans pénalité._"}` : "",
      ].filter(Boolean).join("\n"),
      components: [
        row(new UserSelectMenuBuilder().setCustomId("pn_u").setPlaceholder("Le chatteur").setMinValues(1).setMaxValues(1)),
        row(
          new StringSelectMenuBuilder()
            .setCustomId("pn_f")
            .setPlaceholder("La faute")
            .addOptions(FAULTS.map((x) => opt(x.l, x.k, `${x.cat} · ${ruleTxt(x)}`, x.e, x.k === st.fault)))
        ),
        row(
          button("pn_ok", "Envoyer", "⚠️", ButtonStyle.Danger, !(st.uid && f)),
          button("pn_why", "Avec un détail…", "✍️", ButtonStyle.Secondary, !(st.uid && f)),
          button("pn_sum", "Récap du mois", "📋", ButtonStyle.Secondary),
          button("pn_x", "Fermer", null, ButtonStyle.Secondary)
        ),
      ],
    };
  },
  // Récap d'un mois : par chatteur, ses avertissements et le total à retirer ; annuler une erreur de saisie
  async sum(st) {
    const m = st.month || monthOf(today());
    const list = (await appSync.penaltiesIn(m)).sort((a, b) => b.at - a.at);
    const by = new Map();
    for (const p of list) by.set(p.uid, [...(by.get(p.uid) || []), p]);
    const rows = [...by.entries()]
      .map(([uid, l]) => ({ uid, l, total: l.reduce((a, p) => a + (Number(p.amount) || 0), 0) }))
      .sort((a, b) => b.total - a.total || b.l.length - a.l.length);
    const detail = (l) => {
      const c = new Map();
      for (const p of l) c.set(p.fault, [...(c.get(p.fault) || []), p]);
      return [...c.entries()].map(([k, x]) => `${faultOf(k)?.l || x[0].label} ×${x.length}`).join(", ");
    };
    const del = st.del && list.find((p) => p.id === st.del);
    const total = rows.reduce((a, r) => a + r.total, 0);
    return {
      content: [
        st.note,
        `📋 **Pénalités · ${monthLabel(m)}**${total ? ` · -${euros(total)} au total` : ""}`,
        rows.length
          ? rows.map((r) => `<@${r.uid}> · ${r.l.length} avertissement${plS(r.l.length)} · **${r.total ? `-${euros(r.total)}` : "0 €"}**\n-# ${detail(r.l)}`).join("\n").slice(0, 1800)
          : "_Aucune pénalité ce mois-ci._",
        del ? `\n🗑️ Annuler : <@${del.uid}> N°${del.n} ${del.label}${del.amount ? ` (-${euros(del.amount)})` : ""} du ${dayShort(del.date)} ?` : "",
      ].filter(Boolean).join("\n"),
      components: [
        ...(list.length
          ? [
              row(
                new StringSelectMenuBuilder()
                  .setCustomId("pn_ds")
                  .setPlaceholder("Annuler une pénalité (erreur de saisie)")
                  .addOptions(
                    list.slice(0, 25).map((p) =>
                      opt(`${dayShort(p.date)} · ${p.name} · N°${p.n} ${p.label}`, p.id, p.amount ? `-${euros(p.amount)}` : "Avertissement seul", faultOf(p.fault)?.e, p.id === st.del)
                    )
                  )
              ),
            ]
          : []),
        row(
          ...(del ? [button("pn_dok", "Oui, annuler", "🗑️", ButtonStyle.Danger)] : []),
          button("pn_mo_-1", "Mois d'avant", "◀️", ButtonStyle.Secondary),
          button("pn_mo_1", "Mois d'après", "▶️", ButtonStyle.Secondary, m >= monthOf(today())),
          button("pn_add", "Nouvelle pénalité", "⚠️", ButtonStyle.Primary),
          button("pn_x", "Fermer", null, ButtonStyle.Secondary)
        ),
      ],
    };
  },
};

async function open(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  if (!appSync.enabled()) return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  const st = { view: "add" };
  states.set(i.user.id, st);
  await i.deferReply({ flags: EPHEMERAL });
  return showView(i, await VIEWS.add(st));
}

// Enregistre la pénalité et l'annonce dans le salon pénalités
async function send(i, st, note) {
  const f = faultOf(st.fault);
  const date = today();
  const m = monthOf(date);
  // recalculé au moment d'envoyer (un autre admin a pu en mettre une entre-temps)
  const n = (await appSync.penaltiesIn(m)).filter((p) => p.uid === st.uid && p.fault === f.k).length + 1;
  const c = await appSync.chatterOf(st.uid, [ctx.nameOf(st.uid)].filter(Boolean), false).catch(() => null);
  const p = {
    id: `${m}-${appSync.newId()}`, month: m, date, at: Date.now(), by: i.user.id,
    uid: st.uid, chatterId: c?.id || null, name: c?.name || ctx.nameOf(st.uid),
    fault: f.k, label: f.l, n, amount: amountFor(f, n), currency: "EUR", note: note || "",
  };
  let where = "";
  try {
    const ch = await ctx.client.channels.fetch(PENALTY_CHANNEL_ID);
    const msg = await ch.send({ content: lineOf(p), allowedMentions: { users: [p.uid] } });
    p.msg = { channelId: ch.id, id: msg.id };
    where = ` dans <#${ch.id}>`;
  } catch (e) {
    console.error("Pénalité (salon) :", e.message);
    where = ` ⚠️ Message pas envoyé dans le salon pénalités : ${String(e.message).slice(0, 150)}`;
  }
  await appSync.addPenalty(p);
  Object.assign(st, { fault: null, note: `✅ Envoyé${where} : <@${p.uid}> **AVERTISSEMENT N°${p.n}** | ${p.label}${p.amount ? ` · -${euros(p.amount)}` : ""}` });
}

// ---------- Interactions pn_… ----------
async function handle(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const id = i.customId;
  const st = states.get(i.user.id);
  if (!st) return done(i, "Ce menu a expiré : reclique sur ⚠️ Pénalités dans le salon gestion.", 8000);
  st.note = "";
  if (id === "pn_x") {
    states.delete(i.user.id);
    return done(i, "✅ C'est noté.", 4000);
  }
  if (id === "pn_why")
    return i.showModal(
      new ModalBuilder().setCustomId("pn_m").setTitle("Pénalité").addComponents(
        row(new TextInputBuilder().setCustomId("note").setLabel("Détail (le chatteur le verra)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200))
      )
    );
  await i.deferUpdate();
  if (id === "pn_u") {
    const u = i.users?.get(i.values[0]);
    if (u?.bot) st.note = "❌ Choisis un chatteur, pas un bot.";
    else st.uid = i.values[0];
  } else if (id === "pn_f") st.fault = i.values[0];
  else if (id === "pn_ok" || id === "pn_m") {
    if (!st.uid || !faultOf(st.fault)) st.note = "Choisis le chatteur et la faute.";
    else await send(i, st, id === "pn_m" ? (i.fields.getTextInputValue("note") || "").trim() : "");
  } else if (id === "pn_sum") Object.assign(st, { view: "sum", month: null, del: null });
  else if (id === "pn_add") st.view = "add";
  else if (id.startsWith("pn_mo_")) Object.assign(st, { month: addMonths(st.month || monthOf(today()), Number(id.slice(6)) || 0), del: null });
  else if (id === "pn_ds") st.del = i.values[0];
  else if (id === "pn_dok") {
    const p = (await appSync.penaltiesIn(st.month || monthOf(today()))).find((x) => x.id === st.del);
    if (p) {
      await appSync.delPenalty(p.id);
      // le message du salon reste, barré
      if (p.msg)
        await ctx.client.channels
          .fetch(p.msg.channelId)
          .then((ch) => ch.messages.edit(p.msg.id, { content: `~~${lineOf({ ...p, note: "" }).replace(/\n/g, "~~\n~~")}~~\n-# Annulée par <@${i.user.id}>`, allowedMentions: { parse: [] } }))
          .catch((e) => console.warn("Pénalité annulée (message) :", e.message));
      st.note = `🗑️ Annulée : ${p.name} N°${p.n} ${p.label}.`;
    }
    st.del = null;
  }
  return showView(i, await VIEWS[st.view](st));
}

module.exports = { ctx, open, handle, FAULTS, amountFor, ruleTxt, PENALTY_CHANNEL_ID, states };
