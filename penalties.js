// ================== PÉNALITÉS ==================
// Le barème de l'agence, saisi à la main par un admin depuis le salon gestion (rien d'automatique avec le clocking).
// Chaque pénalité est gardée dans l'app (penalties/<id>) et annoncée dans le salon pénalités :
//   « @chatteur AVERTISSEMENT N°3 | Ne chatte pas pendant son shift » puis « Pénalité de -10 € »
// Le numéro compte les fautes du même type ce mois-ci (il repart à 1 chaque mois). Montants en euros.
// Les paies se font par quinzaine : le 16 et le 1er à 2 h, le récap de la quinzaine qui finit part dans le salon
// (une ligne par chatteur avec son total), et l'onglet Paies de l'app retire ces montants de sa paie.
// ⚠️ Pénalités (sous le panneau du shift) ouvre une petite fiche : le chatteur (recherche), la faute, et pour une pénalité
// ✏️ Personnalisée le montant et la raison ; 📋 le récap de la quinzaine reste un menu (annuler une erreur, l'envoyer).
const { UserSelectMenuBuilder, StringSelectMenuBuilder, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const { reply, done, showView, row, button, opt, plS, EPHEMERAL } = require("./ui");

const PENALTY_CHANNEL_ID = (process.env.PENALTY_CHANNEL_ID ?? "1553910044204994601").trim();
// Fourni par index.js : isAdmin(i), client, nameOf(uid), getData(), saveData()
const ctx = {};
const states = new Map(); // userId -> état du menu en cours

// free : avertissements sans pénalité avant la première ; tiers (retards) : [n-ième retard du mois, montant],
// pénalité seulement à ces retards-là (3e, 5e, 8e…), les autres sont des avertissements ; au-delà du dernier palier, chaque retard au dernier montant
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
// Pénalité personnalisée : montant et raison écrits à la main (numéro compté parmi ses personnalisées du mois)
const PERSO = { k: "perso", l: "Personnalisée", e: "✏️", cat: "Autre" };
const faultOf = (k) => FAULTS.find((f) => f.k === k) || (k === PERSO.k ? PERSO : null);
// montant de la n-ième faute du mois (0 = avertissement seul)
function amountFor(f, n) {
  if (f.tiers) {
    const last = f.tiers[f.tiers.length - 1];
    return n > last[0] ? last[1] : f.tiers.find(([th]) => th === n)?.[1] || 0;
  }
  return n > f.free ? f.amount : 0;
}
const ruleTxt = (f) =>
  f.tiers
    ? `${f.tiers.map(([th, amt]) => `${th}e -${amt} €`).join(", ")}, les autres en avertissement`
    : f.free ? `${f.free} avertissements, puis -${f.amount} €` : `-${f.amount} € dès la 1re fois`;
const euros = (n) => `${Number(n).toLocaleString("fr-FR")} €`;

// Jour de paie d'un instant : jusqu'à 2 h du matin, c'est encore la veille (les quinzaines se coupent le 1er
// et le 16 à 2 h, comme le shift du soir). Le compteur du mois repart donc le 1er à 2 h.
const workDay = (t = Date.now()) => appSync.parisParts(t - 121 * 60e3).date;
const today = () => workDay();
const monthOf = (date) => date.slice(0, 7);
// Quinzaine : « 2026-10-A » (du 1er au 15) ou « 2026-10-B » (du 16 à la fin du mois), comme l'onglet Paies
const periodOf = (date) => `${date.slice(0, 7)}-${Number(date.slice(8, 10)) <= 15 ? "A" : "B"}`;
const monthEnd = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
function periodStep(k, n) {
  let [m, h] = [k.slice(0, 7), k.slice(8)];
  for (let x = 0; x < Math.abs(n); x++)
    if (n > 0) [m, h] = h === "A" ? [m, "B"] : [addMonths(m, 1), "A"];
    else [m, h] = h === "B" ? [m, "A"] : [addMonths(m, -1), "B"];
  return `${m}-${h}`;
}
const inPeriod = (p, k) => periodOf(p.date) === k;
function periodLabel(k) {
  const m = k.slice(0, 7);
  const ml = monthLabel(m);
  return k.endsWith("A") ? `du 1er au 15 ${ml}` : `du 16 au ${monthEnd(m)} ${ml}`;
}
// jour où on verse la paie de cette quinzaine : le 16, ou le 1er du mois suivant
const payDayLabel = (k) => (k.endsWith("A") ? `16 ${monthLabel(k.slice(0, 7)).split(" ")[0]}` : `1er ${monthLabel(addMonths(k.slice(0, 7), 1)).split(" ")[0]}`);
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
          button("pn_sum", "Récap de la quinzaine", "📋", ButtonStyle.Secondary),
          button("pn_x", "Fermer", null, ButtonStyle.Secondary)
        ),
      ],
    };
  },
  // Récap d'une quinzaine de paie : par chatteur, ses avertissements et le total à retirer ; annuler une erreur de saisie
  async sum(st) {
    const k = (st.period ||= periodOf(today()));
    const list = (await periodList(k)).sort((a, b) => b.at - a.at);
    const rows = recapRows(list);
    const del = st.del && list.find((p) => p.id === st.del);
    const total = rows.reduce((a, r) => a + r.total, 0);
    const sent = ctx.getData?.().penRecaps?.[k];
    return {
      content: [
        st.note,
        `📋 **Pénalités ${periodLabel(k)}**${total ? ` · -${euros(total)} au total` : ""} · paie du ${payDayLabel(k)}`,
        rows.length
          ? rows.map((r) => `<@${r.uid}> · ${r.l.length} avertissement${plS(r.l.length)} · **${r.total ? `-${euros(r.total)}` : "0 €"}**\n-# ${detail(r.l)}`).join("\n").slice(0, 1800)
          : "_Aucune pénalité sur cette quinzaine._",
        sent ? `-# Récap envoyé dans le salon pénalités le ${dayShort(workDay(sent.at + 121 * 60e3))}.` : "",
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
          button("pn_pe_-1", "Quinzaine d'avant", "◀️", ButtonStyle.Secondary),
          button("pn_pe_1", "Quinzaine d'après", "▶️", ButtonStyle.Secondary, k >= periodOf(today())),
          ...(del ? [] : [button("pn_post", "Envoyer le récap", "📣", ButtonStyle.Secondary, !rows.length)]),
          button("pn_add", "Nouvelle pénalité", "⚠️", ButtonStyle.Primary),
          button("pn_x", "Fermer", null, ButtonStyle.Secondary)
        ),
      ],
    };
  },
};

// ---------- Récap d'une quinzaine ----------
async function periodList(k) {
  return (await appSync.penaltiesIn(k.slice(0, 7))).filter((p) => inPeriod(p, k));
}
// une ligne par chatteur : ses fautes et son total, les plus grosses pénalités d'abord
function recapRows(list) {
  const by = new Map();
  for (const p of list) by.set(p.uid, [...(by.get(p.uid) || []), p]);
  return [...by.entries()]
    .map(([uid, l]) => ({ uid, l, total: l.reduce((a, p) => a + (Number(p.amount) || 0), 0) }))
    .sort((a, b) => b.total - a.total || b.l.length - a.l.length);
}
function detail(l) {
  const c = new Map();
  for (const p of l) c.set(p.fault, [...(c.get(p.fault) || []), p]);
  return [...c.entries()].map(([k, x]) => (k === PERSO.k ? x.map((p) => p.label).join(", ") : `${faultOf(k)?.l || x[0].label} ×${x.length}`)).join(", ");
}
// « 📋 Récap des pénalités du 1er au 15 octobre 2026 » : une ligne par @chatteur avec son total, puis le total
function recapText(k, list) {
  const rows = recapRows(list);
  const total = rows.reduce((a, r) => a + r.total, 0);
  const lines = rows.map((r) => `<@${r.uid}> · **${r.total ? `-${euros(r.total)}` : "0 €"}** · ${r.l.length} avertissement${plS(r.l.length)}`);
  let body = lines.join("\n");
  if (body.length > 1700) body = body.slice(0, body.lastIndexOf("\n", 1700)) + "\n…";
  return [
    `📋 **Récap des pénalités ${periodLabel(k)}**`,
    `-# À retirer de la paie du ${payDayLabel(k)}.`,
    "",
    rows.length ? body : "_Aucune pénalité sur cette quinzaine._ 🎉",
    ...(rows.length ? ["", `**Total : -${euros(total)}**`] : []),
  ].join("\n");
}
// Envoie le récap d'une quinzaine dans le salon pénalités
async function postRecap(k, t = Date.now()) {
  const list = await periodList(k);
  const ch = await ctx.client.channels.fetch(PENALTY_CHANNEL_ID);
  // chaque chatteur cité est notifié, comme pour ses pénalités
  const msg = await ch.send({ content: recapText(k, list), allowedMentions: { users: [...new Set(list.map((p) => p.uid))].slice(0, 100) } });
  const data = ctx.getData();
  data.penRecaps ||= {};
  data.penRecaps[k] = { channelId: ch.id, id: msg.id, at: t };
  for (const x of Object.keys(data.penRecaps)) if (x < periodStep(k, -6)) delete data.penRecaps[x];
  ctx.saveData();
  return list.length;
}
// Le 1er et le 16 à 2 h (et au démarrage, si le bot était éteint à ce moment-là) : récap de la quinzaine qui vient de finir
async function autoRecap(t = Date.now()) {
  if (!appSync.enabled() || !PENALTY_CHANNEL_ID) return null;
  const d = workDay(t);
  const cur = periodOf(d);
  const prev = periodStep(cur, -1);
  const since = Number(d.slice(8, 10)) - (cur.endsWith("A") ? 1 : 16); // jours depuis la coupure
  // déjà envoyé après la fin de la quinzaine (un envoi à la main avant la fin ne compte pas : il en manquait peut-être)
  const sent = ctx.getData().penRecaps?.[prev];
  if ((sent && periodOf(workDay(sent.at)) > prev) || since > 2) return null;
  await postRecap(prev, t);
  return prev;
}

// ---------- La petite fiche ----------
const label = (l, d) => (d ? new LabelBuilder().setLabel(l).setDescription(d) : new LabelBuilder().setLabel(l));
const text = (id, placeholder, max = 200) => new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(max).setPlaceholder(placeholder);
function modal() {
  const faults = [
    ...FAULTS.map((x) => ({ label: x.l, value: x.k, emoji: x.e, description: `${x.cat} · ${ruleTxt(x)}`.slice(0, 100) })),
    { label: "Personnalisée", value: PERSO.k, emoji: PERSO.e, description: "Tu écris le montant et la raison" },
    { label: "Juste voir le récap de la quinzaine", value: "_sum", emoji: "📋", description: "Rien n'est envoyé ; annuler une erreur, envoyer le récap" },
  ];
  return new ModalBuilder().setCustomId("pn_new").setTitle(`⚠️ Pénalité · ${monthLabel(monthOf(today()))}`.slice(0, 45)).addLabelComponents(
    label("Chatteur").setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId("who").setRequired(false).setMinValues(0).setMaxValues(1).setPlaceholder("🔎 Tape son nom")),
    label("La faute", "Le numéro d'avertissement et la pénalité suivent le barème du mois").setStringSelectMenuComponent(
      new StringSelectMenuBuilder().setCustomId("fault").setRequired(true).setMinValues(1).setMaxValues(1).addOptions(faults)
    ),
    label("Montant (Personnalisée)", "En euros, ex : 15 · 0 = avertissement seul").setTextInputComponent(text("amount", "ex : 15", 6)),
    label("Raison ou détail", "Le chatteur le verra ; obligatoire pour une Personnalisée").setTextInputComponent(text("note", "ex : retard de 2 h sans prévenir"))
  );
}
async function open(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  if (!appSync.enabled()) return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  return i.showModal(modal());
}
const field = (i, fn, id) => {
  try {
    return i.fields[fn](id);
  } catch {
    return null;
  }
};
// La fiche envoyée : la pénalité part dans le salon (ou le récap s'affiche)
async function submit(i) {
  const u = field(i, "getSelectedUsers", "who")?.first?.();
  const k = (field(i, "getStringSelectValues", "fault") || [])[0];
  const note = String(field(i, "getTextInputValue", "note") || "").trim();
  await i.deferReply({ flags: EPHEMERAL });
  if (k === "_sum") {
    const st = { view: "sum" };
    states.set(i.user.id, st);
    return showView(i, await VIEWS.sum(st));
  }
  const f = faultOf(k);
  const raw = String(field(i, "getTextInputValue", "amount") || "").replace(",", ".").replace(/[€\s]/g, "");
  const amount = Math.round(Number(raw) * 100) / 100;
  const errors = [
    !u && "choisis le chatteur.",
    u?.bot && "choisis un chatteur, pas un bot.",
    !f && "choisis la faute.",
    f === PERSO && !(raw && Number.isFinite(amount) && amount >= 0 && amount <= 1000) && "écris le montant en euros (ex : 15, 0 pour un avertissement seul).",
    f === PERSO && !note && "écris la raison.",
  ].filter(Boolean);
  if (errors.length) return done(i, `⚠️ Rien n'est envoyé : ${errors.join(" ")}`, 30000);
  const st = { uid: u.id, fault: f.k, ...(f === PERSO ? { custom: { amount, label: note } } : {}) };
  await send(i, st, f === PERSO ? "" : note);
  states.set(i.user.id, { view: "sum" });
  return showView(i, {
    content: st.note,
    components: [row(button("pn_add", "Nouvelle pénalité", "⚠️", ButtonStyle.Primary), button("pn_sum", "Récap de la quinzaine", "📋", ButtonStyle.Secondary), button("pn_x", "Fermer", null, ButtonStyle.Secondary))],
  });
}

// Enregistre la pénalité et l'annonce dans le salon pénalités
async function send(i, st, note) {
  const f = faultOf(st.fault);
  const date = today(); // jour de paie (avant 2 h : la veille)
  const m = monthOf(date);
  // recalculé au moment d'envoyer (un autre admin a pu en mettre une entre-temps)
  const n = (await appSync.penaltiesIn(m)).filter((p) => p.uid === st.uid && p.fault === f.k).length + 1;
  const custom = f === PERSO ? st.custom : null;
  const c = await appSync.chatterOf(st.uid, [ctx.nameOf(st.uid)].filter(Boolean), false).catch(() => null);
  const p = {
    id: `${m}-${appSync.newId()}`, month: m, date, at: Date.now(), by: i.user.id,
    uid: st.uid, chatterId: c?.id || null, name: c?.name || ctx.nameOf(st.uid),
    fault: f.k, label: custom ? custom.label : f.l, n, amount: custom ? custom.amount : amountFor(f, n), currency: "EUR", note: note || "",
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
  if (id === "pn_new") return submit(i);
  // ⚠️ Nouvelle pénalité : la petite fiche
  if (id === "pn_add") return i.showModal(modal());
  if (id === "pn_sum" && !states.get(i.user.id)) states.set(i.user.id, { view: "sum" });
  const st = states.get(i.user.id);
  if (!st) return done(i, "Ce menu a expiré : reclique sur ⚠️ Pénalités sous le panneau du shift.", 8000);
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
  } else if (id === "pn_sum") Object.assign(st, { view: "sum", period: null, del: null });
  else if (id.startsWith("pn_pe_")) Object.assign(st, { period: periodStep(st.period || periodOf(today()), Number(id.slice(6)) || 0), del: null });
  else if (id === "pn_post") {
    const n = await postRecap(st.period).catch((e) => ({ error: e.message }));
    st.note = n?.error ? `⚠️ Récap pas envoyé : ${String(n.error).slice(0, 150)}` : `📣 Récap ${periodLabel(st.period)} envoyé dans <#${PENALTY_CHANNEL_ID}>.`;
  } else if (id === "pn_ds") st.del = i.values[0];
  else if (id === "pn_dok") {
    const p = (await periodList(st.period)).find((x) => x.id === st.del);
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

module.exports = { ctx, open, handle, modal, FAULTS, PERSO, amountFor, ruleTxt, PENALTY_CHANNEL_ID, states, autoRecap, postRecap, recapText, periodOf, periodStep, workDay };
