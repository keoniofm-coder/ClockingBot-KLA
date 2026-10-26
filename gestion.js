// ================== LES BOUTONS DES ADMINS (🛠️ Admin sous le message du salon box) ==================
// Dans le salon clocking, les chatteurs ne voient que Clock In / Clock Out. 🛠️ Admin, sous le message du salon box, ouvre
// pour l'admin seul (Discord ne cache pas un bouton d'un message public) la barre de recherche et un bouton par sujet. Presque tout s'ouvre en petite fiche (une fenêtre Discord) : 🔎 la fiche d'un chatteur (barre de recherche du haut),
// ➕ Ajouter un chatteur, ✏️ Modifier le shift, 💪🏼 Renfort, ⚡ Coupure, 🔙 Retour de coupure, ⚠️ Pénalités, 💃 Modèles,
// 🛡️ Admins, 🔔 Renvoyer le panneau, 🚫 Virer. 📋 Pointer reste un menu visible seulement par
// l'admin qui a cliqué (un seul à la fois, voir menus.js). Les commandes restent en secours.
// L'ancien panneau du salon gestion n'est plus envoyé (sauf si GESTION_CHANNEL_ID est réglé dans Railway).
const { StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const planning = require("./planning");
const { reply, done, showView, row, button, opt, selectMenus, EPHEMERAL } = require("./ui");
const { pickRow, altButton, picked } = require("./pick");

const GESTION_CHANNEL_ID = (process.env.GESTION_CHANNEL_ID ?? "").trim();
// Fourni par index.js : isAdmin, client, getData, saveData, SHIFTS, liveEmbed(), currentShift(), shiftBoard(name, date),
// setMark(date, slot, cid, patch), openMenu(i, menu), openChatters(i), openPlanning(i, date, view, extra), openPenalties(i), heldText(date, slot, cid),
// dayoffView(month), coupure(i, user, opts), retour(i, target, opts), retours(i, cids, giveBack), postPlanning(date), announceShift(name),
// dayChoices(), fireTargets(), firePreview(target), fire(target), openModels(i), openAdmins(i), openPlanPick(i, date),
// modals : { replace(i, { date, slot }), change(i, { date, slot, mode }) } (quickmodal.js), fiche(i, { date, slot, cid }),
// fresh(i, { date, slot }), find(i, { date, slot, uid }) (fiche.js), refreshPanels(date) : remet les panneaux de ce jour à jour
const ctx = {};
const states = new Map(); // userId -> état du menu en cours

const DURATIONS = [5, 10, 15, 20, 30, 45, 60, 90, 120];
// Raison d'une coupure (fiche ⚡ Coupure) : écrite dans la ligne du salon clocking et au pointage
const CUT_WHY = [
  ["", "Je ne sais pas", "❔"], ["courant", "Coupure de courant", "🔌"], ["internet", "Internet / connexion", "🌐"],
  ["appareil", "Ordinateur ou téléphone", "💻"], ["pause", "Pause", "☕"], ["urgence", "Urgence perso", "🚨"],
];
const today = () => appSync.parisParts(Date.now()).date;

// ---------- Le panneau ----------
// Un seul message : le pointage du shift en cours en direct (comme Pointage dans l'app), puis les boutons.
// Il passe tout seul au shift suivant (même message, rien ne s'empile dans le salon).
function panelView(live) {
  return {
    embeds: [
      live || {
        title: "🛠️ Gestion · KL Agency",
        color: 0x5bae8c,
        description: "Tout se gère d'ici (réservé aux admins). Chaque bouton ouvre un menu que toi seul vois.",
      },
    ],
    components: [
      row(
        button("g_chat", "Chatteurs", "👥", ButtonStyle.Primary),
        button("g_mod", "Modèles", "💃", ButtonStyle.Secondary),
        button("g_adm", "Admins", "🛡️", ButtonStyle.Secondary)
      ),
      row(
        button("g_plan", "Planning", "📅", ButtonStyle.Primary),
        button("g_rep", "Remplacer", "🔁", ButtonStyle.Secondary),
        button("g_mv", "Déplacer", "🔀", ButtonStyle.Secondary),
        button("g_ren", "Renfort", "💪🏼", ButtonStyle.Secondary),
        button("g_send", "Envoyer le planning", "📣", ButtonStyle.Secondary)
      ),
      row(
        button("g_att", "Pointer", "📋", ButtonStyle.Primary),
        button("g_cut", "Coupure", "⚡", ButtonStyle.Secondary),
        button("g_back", "Retour de coupure", "🔙", ButtonStyle.Secondary),
        button("g_off", "Day off", "🏖️", ButtonStyle.Secondary),
        button("g_shift", "Message de shift", "🔔", ButtonStyle.Secondary)
      ),
      row(button("g_box", "Modifier le shift", "✏️", ButtonStyle.Secondary), button("g_pen", "Pénalités", "⚠️", ButtonStyle.Primary), button("g_fire", "Virer un chatteur", "🚫", ButtonStyle.Danger)),
    ],
    allowedMentions: { parse: [] },
  };
}
// 🛠️ Admin (sous le message du salon box) : d'abord la barre 🔎 Modifs chatteurs (on tape un nom, sa fiche
// s'ouvre), puis les boutons ; ceux qui portent ce shift (~date~créneau) le visent directement ; ✏️ ouvre la fenêtre pour
// modifier tout le shift d'un coup (shiftmodal.js). unlinked : nombre de chatteurs de l'app pas reliés à Discord.
let whoN = 0; // change l'id de la barre après chaque choix : Discord la remet à zéro (sinon le même nom ne se rechoisit pas)
function panelRows(date, slot, { unlinked = 0 } = {}) {
  const c = (id) => `${id}~${date}~${slot}`;
  return [
    row(
      new UserSelectMenuBuilder()
        .setCustomId(`g_find~${date}~${slot}~${whoN}`)
        .setPlaceholder("🔎 Modifs chatteurs : tape un nom, sa fiche s'ouvre")
        .setMinValues(1)
        .setMaxValues(1)
    ),
    row(
      button(`pm_open~${date}~${slot}`, "Modifier le shift", "✏️", ButtonStyle.Primary),
      button(c("g_att"), "Pointer", "📋", ButtonStyle.Primary),
      button(c("g_ren"), "Renfort", "💪🏼", ButtonStyle.Secondary),
      button("g_cut", "Coupure", "⚡", ButtonStyle.Secondary),
      button("g_back", "Retour de coupure", "🔙", ButtonStyle.Secondary)
    ),
    row(
      button("g_pen", "Pénalités", "⚠️", ButtonStyle.Primary),
      button(c("g_plan"), "Planning", "📅", ButtonStyle.Primary),
      button("g_mod", "Modèles", "💃", ButtonStyle.Secondary),
      button("g_adm", "Admins", "🛡️", ButtonStyle.Secondary)
    ),
    row(
      button(c("g_new"), "Ajouter un chatteur", "➕", ButtonStyle.Success),
      ...(unlinked ? [button(c("g_nd"), `Pas sur Discord (${unlinked})`, "👤", ButtonStyle.Secondary)] : []),
      button("g_shift", "Renvoyer le panneau", "🔔", ButtonStyle.Secondary),
      button("g_fire", "Virer un chatteur", "🚫", ButtonStyle.Danger)
    ),
  ];
}
const hashOf = (v) => require("crypto").createHash("md5").update(JSON.stringify({ e: v.embeds, c: v.components.map((r) => r.toJSON()) })).digest("hex");

// Envoie le panneau (ou le met à jour s'il a changé) ; resend : le renvoie en bas du salon. Un appel après l'autre.
let chain = Promise.resolve();
function ensurePanel(opts = {}) {
  const run = chain.then(() => updatePanel(opts));
  chain = run.catch(() => {});
  return run;
}
// Mise à jour quelques secondes après un clock in, une coupure, un changement de planning…
let soonTimer = null;
function panelSoon() {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => ensurePanel().catch((e) => console.error("Panneau gestion :", e.message)), 3000);
}
async function updatePanel({ resend = false }) {
  if (!GESTION_CHANNEL_ID) return null;
  const data = ctx.getData();
  let live = null;
  if (appSync.enabled())
    try {
      live = await ctx.liveEmbed();
    } catch (e) {
      console.error("Pointage en direct :", e.message);
    }
  const v = panelView(live);
  const hash = hashOf(v);
  const ch = await ctx.client.channels.fetch(GESTION_CHANNEL_ID);
  const p = data.gestionPanel;
  if (p?.messageId && p.channelId === ch.id && !resend) {
    if (p.hash === hash) return p;
    try {
      await ch.messages.edit(p.messageId, v);
      p.hash = hash;
      ctx.saveData();
      return p;
    } catch (e) {
      console.warn("Panneau gestion introuvable, renvoyé :", e.message);
    }
  }
  if (p?.messageId && p.channelId === ch.id) await ch.messages.delete(p.messageId).catch(() => {});
  const msg = await ch.send(v);
  data.gestionPanel = { channelId: ch.id, messageId: msg.id, hash, url: msg.url };
  ctx.saveData();
  return data.gestionPanel;
}

// ---------- Menus ----------
const cancelBtn = (l = "Annuler") => button("g_x", l, null, ButtonStyle.Secondary);
const STATUS = { present: ["Présent", "✅", ButtonStyle.Success], retard: ["Retard", "🟠", ButtonStyle.Secondary], coupure: ["Coupure", "⚡", ButtonStyle.Secondary], absent: ["Absent", "❌", ButtonStyle.Danger] };
const SEMOJI = { present: "✅", retard: "🟠", coupure: "⚡", absent: "❌", todo: "⭕", off: "🏖️" };
const VIEWS = {
  // Pointer à la main, comme Pointage dans l'app : statut, minutes, note, « tous les autres présents »
  async att(st) {
    const b = await ctx.shiftBoard(st.name, st.date);
    const sh = ctx.SHIFTS[st.name];
    const people = [...b.staff].sort((x, y) => x.name.localeCompare(y.name, "fr"));
    const p = people.find((x) => x.id === st.cid);
    const due = people.filter((x) => !x.off);
    const count = (k) => due.filter((x) => b.stOf(x) === k).length;
    const sum = ["present", "retard", "coupure", "absent", "todo"].filter((k) => count(k)).map((k) => `${SEMOJI[k]} ${count(k)}`).join(" · ");
    const todo = due.filter((x) => !x.mark?.status);
    // gardé pour ouvrir la fenêtre des minutes tout de suite (Discord laisse 3 s pour répondre)
    st.sel = p ? { name: p.name, min: p.mark?.min || "", note: p.mark?.note || "" } : null;
    return {
      content: [
        st.note,
        `📋 **Pointer** · ${sh.emoji} ${st.name} ${sh.label} · ${planning.dayLabel(st.date)}`,
        due.length ? `**${due.length - count("todo")}/${due.length}** pointés · ${sum}` : "_Personne au planning sur ce shift._",
        todo.length ? `-# À pointer : ${todo.map((x) => x.name).join(", ")}` : "",
        p ? `\n**${p.name}** · ${SEMOJI[b.stOf(p)]} ${b.detail(p)}` : people.length ? "Tape le nom du chatteur, puis choisis son statut." : "",
      ].filter(Boolean).join("\n"),
      components: [
        row(
          new StringSelectMenuBuilder()
            .setCustomId("g_as")
            .setPlaceholder("Shift")
            .addOptions(Object.entries(ctx.SHIFTS).map(([k, v]) => opt(`${k} (${v.label})`, k, null, v.emoji, k === st.name)))
        ),
        pickRow("g_ac", { alt: st.alt, opts: people.map((x) => opt(x.name, x.id, b.detail(x), SEMOJI[b.stOf(x)])), chatters: people, cid: st.cid }),
        row(
          ...Object.entries(STATUS).map(([k, [l, e, style]]) => button(`g_st_${k}`, l, e, style, !p || p.off)),
          button("g_st_clear", "Effacer", "↩️", ButtonStyle.Secondary, !p?.mark?.status)
        ),
        row(
          button("g_allp", todo.length ? `Tous les autres présents (${todo.length})` : "Tous les autres présents", "✅", ButtonStyle.Success, !todo.length),
          button("g_ad_-1", "Jour d'avant", "◀️", ButtonStyle.Secondary),
          button("g_ad_1", "Jour d'après", "▶️", ButtonStyle.Secondary),
          ...altButton("g_alt", { alt: st.alt, opts: people.map((x) => opt(x.name, x.id)), chatters: people }),
          cancelBtn("Fermer")
        ),
      ],
    };
  },
  // Coupure : qui, combien de temps, raison optionnelle
  cut(st) {
    return {
      content: [
        st.note,
        "⚡ **Noter une coupure**",
        "Le chatteur est notifié dans le salon clocking et passe en « Coupure » au pointage. À son retour : 🔙 **Retour de coupure**.",
        st.user ? `Chatteur : <@${st.user.id}>${st.min ? ` · ${st.min} min` : ""}` : "",
      ].filter(Boolean).join("\n"),
      components: [
        row(new UserSelectMenuBuilder().setCustomId("g_cu").setPlaceholder("Le chatteur").setMinValues(1).setMaxValues(1)),
        row(
          new StringSelectMenuBuilder()
            .setCustomId("g_cd")
            .setPlaceholder("Durée prévue (optionnel)")
            .addOptions([opt("Je ne sais pas", "0", null, "❔", !st.min), ...DURATIONS.map((m) => opt(`${m} min`, String(m), null, "⏱️", st.min === m))])
        ),
        row(
          button("g_cok", "Noter la coupure", "⚡", ButtonStyle.Primary, !st.user),
          button("g_cwhy", "Avec une raison…", "✍️", ButtonStyle.Secondary, !st.user),
          cancelBtn()
        ),
      ],
    };
  },
  // Retour : parmi ceux en coupure en ce moment ; s'il a été remplacé, il peut reprendre ses box
  async back(st) {
    const list = await appSync.openCoupures();
    const sl = (k) => planning.SLOTS.find((s) => s.k === k);
    const c = st.cid && list.find((x) => x.id === st.cid);
    const held = c ? await ctx.heldText(c.date, c.slot, c.id).catch(() => "") : "";
    st.held = !!held;
    return {
      content: [
        st.note,
        "🔙 **Retour de coupure**",
        list.length ? "Choisis qui revient : le temps de coupure est compté au pointage, comme un retard." : "_Personne n'est en coupure en ce moment._",
        held ? `📦 Pendant sa coupure, ses ${held}${st.give === false ? " · il ne les reprend pas" : " · il les reprend à son retour"}` : "",
      ].filter(Boolean).join("\n"),
      components: [
        ...(list.length
          ? selectMenus(
              "g_bs",
              list.map((c) => opt(c.name, c.id, `En coupure depuis ${fmt(c.since)}${sl(c.slot) ? ` · ${sl(c.slot).l}` : ""}`, "⚡")),
              { placeholder: "Qui revient ?", max: 1, chosen: [st.cid] }
            )
          : []),
        row(
          button("g_bok", "Retour", "🔙", ButtonStyle.Success, !st.cid),
          ...(held ? [button("g_bgv", st.give === false ? "Reprend ses box : non" : "Reprend ses box : oui", "📦", st.give === false ? ButtonStyle.Secondary : ButtonStyle.Primary)] : []),
          cancelBtn()
        ),
      ],
    };
  },
  // Envoyer le planning d'un jour dans le salon planning
  send() {
    return {
      content: "📣 **Envoyer le planning** dans le salon planning (il remplace celui du même jour et se met à jour tout seul).",
      components: [
        row(new StringSelectMenuBuilder().setCustomId("g_sd").setPlaceholder("Quel jour ?").addOptions(ctx.dayChoices().map((c) => opt(c.name, c.value)))),
        row(cancelBtn()),
      ],
    };
  },
  // Renvoyer le panneau d'un shift (pointage, Clock In / Clock Out et ces boutons) en bas du salon clocking
  shift() {
    return {
      content: "🔔 **Renvoyer le panneau d'un shift** en bas du salon clocking (il remplace le précédent du même shift).",
      components: [
        row(
          new StringSelectMenuBuilder()
            .setCustomId("g_ss")
            .setPlaceholder("Quel shift ?")
            .addOptions(Object.entries(ctx.SHIFTS).map(([k, v]) => opt(`${k} (${v.label})`, k, null, v.emoji)))
        ),
        row(cancelBtn()),
      ],
    };
  },
  // Virer : choix, puis confirmation avec ce qui va changer
  async fire(st) {
    const targets = await ctx.fireTargets();
    const t = st.target && targets.find((x) => x.value === st.target);
    const pseudo = targets.map((x) => ({ id: x.value, discordId: x.uid }));
    const lines = [st.note, "🚫 **Virer un chatteur**", "Il sort de partout : clocking, shift habituel, planning à venir (box comprises), day off à venir. Il passe inactif dans l'app ; ses ventes, paies et pointages passés restent."].filter(Boolean);
    if (t) lines.push("", `**${t.label}** :`, ...(await ctx.firePreview(t)).map((x) => `• ${x}`));
    return {
      content: lines.join("\n"),
      components: [
        pickRow("g_fs", { alt: st.alt, opts: targets.map((x) => opt(x.label, x.value, x.desc, x.emoji)), chatters: pseudo, cid: st.target, placeholder: "Le chatteur à virer" }),
        row(
          button("g_fok", t ? `Oui, virer ${t.label}`.slice(0, 80) : "Virer", "🚫", ButtonStyle.Danger, !t),
          ...altButton("g_alt", { alt: st.alt, opts: targets.map((x) => opt(x.label, x.value)), chatters: pseudo }),
          cancelBtn()
        ),
      ],
    };
  },
};
const fmt = (t) => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });

// ---------- Les petites fiches (fenêtres Discord) ----------
const label = (l, d) => (d ? new LabelBuilder().setLabel(l).setDescription(d) : new LabelBuilder().setLabel(l));
const pick = (id, opts, { min = 1, max = 1, required = min > 0, placeholder } = {}) => {
  const m = new StringSelectMenuBuilder().setCustomId(id).setRequired(required).setMinValues(min).setMaxValues(Math.max(1, Math.min(max, opts.length)))
    .addOptions(opts.map((o) => ({ ...o, label: String(o.label).slice(0, 100), ...(o.description ? { description: String(o.description).slice(0, 100) } : {}) })));
  return placeholder ? m.setPlaceholder(placeholder) : m;
};
const users = (id, { required = true, max = 1, def = [], placeholder = "🔎 Tape son nom" } = {}) => {
  const m = new UserSelectMenuBuilder().setCustomId(id).setRequired(required).setMinValues(required ? 1 : 0).setMaxValues(max).setPlaceholder(placeholder);
  return def.length ? m.setDefaultUsers(...def) : m;
};
const textIn = (id, { placeholder, required = false, max = 200, value } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(max);
  if (placeholder) t.setPlaceholder(placeholder);
  return value ? t.setValue(value) : t;
};
const field = (i, fn, id) => {
  try {
    return i.fields[fn](id);
  } catch {
    return null;
  }
};
const vals = (i, id) => field(i, "getStringSelectValues", id) || [];
// lu à temps pour ouvrir la fenêtre (Discord laisse 3 s), sinon null
const quick = (p, ms = 2000) => Promise.race([Promise.resolve(p).catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]);

const FICHES = {
  // ⚡ Coupure : le chatteur (recherche), la durée prévue, la raison
  cut() {
    return new ModalBuilder().setCustomId("g_cutm").setTitle("⚡ Noter une coupure").addLabelComponents(
      label("Chatteur", "Notifié dans le salon clocking, « Coupure » au pointage").setUserSelectMenuComponent(users("who")),
      label("Durée prévue").setStringSelectMenuComponent(pick("min", [{ label: "Je ne sais pas", value: "0", emoji: "❔", default: true }, ...DURATIONS.map((m) => ({ label: `${m} min`, value: String(m), emoji: "⏱️" }))])),
      label("Raison").setStringSelectMenuComponent(pick("why", CUT_WHY.map(([value, l, emoji]) => ({ label: l, value: value || "_", emoji, default: !value })))),
      label("Détail (optionnel)", "Le chatteur le verra").setTextInputComponent(textIn("note", { placeholder: "ex : orage, box internet en panne" }))
    );
  },
  // 🔙 Retour de coupure : seulement ceux en coupure en ce moment
  back(list) {
    const sl = (k) => planning.SLOTS.find((s) => s.k === k);
    return new ModalBuilder().setCustomId("g_backm").setTitle("🔙 Retour de coupure").addLabelComponents(
      label("Qui revient ?", "Le temps de coupure est compté au pointage, comme un retard").setStringSelectMenuComponent(
        pick("who", list.slice(0, 25).map((c) => ({ label: c.name, value: c.id, emoji: "⚡", description: `En coupure depuis ${fmt(c.since)}${sl(c.slot) ? ` · ${sl(c.slot).l}` : ""}`, default: list.length === 1 })), { max: 25 })
      ),
      label("Il reprend ses box ?", "S'il a été remplacé pendant sa coupure").setStringSelectMenuComponent(
        pick("give", [{ label: "Oui, il reprend ses box", value: "yes", emoji: "📦", default: true }, { label: "Non, elles restent à son remplaçant", value: "no", emoji: "🔁" }])
      )
    );
  },
  // 📣 Envoyer le planning d'un jour dans le salon planning
  send() {
    return new ModalBuilder().setCustomId("g_sendm").setTitle("📣 Envoyer le planning").addLabelComponents(
      label("Quel jour ?", "Il remplace celui du même jour et se met à jour tout seul").setStringSelectMenuComponent(
        pick("day", ctx.dayChoices().slice(0, 25).map((c, k) => ({ label: c.name, value: c.value, default: k === 0 })))
      )
    );
  },
  // 🔔 Renvoyer le panneau d'un shift en bas du salon clocking
  shift(cur) {
    return new ModalBuilder().setCustomId("g_shiftm").setTitle("🔔 Renvoyer le panneau").addLabelComponents(
      label("Quel shift ?", "Il remplace le panneau précédent du même shift").setStringSelectMenuComponent(
        pick("shift", Object.entries(ctx.SHIFTS).map(([k, v]) => ({ label: `${k} (${v.label})`, value: k, emoji: v.emoji, default: k === cur })))
      )
    );
  },
  // 🚫 Virer : le chatteur (recherche, ou ceux pas sur Discord), puis confirmer
  fire(targets) {
    const nd = targets.filter((t) => t.cid && !t.uid).slice(0, 25);
    const m = new ModalBuilder().setCustomId("g_firem").setTitle("🚫 Virer un chatteur").addLabelComponents(
      label("Chatteur", "Il sort de partout : clocking, planning à venir, day off à venir").setUserSelectMenuComponent(users("who", { required: !nd.length }))
    );
    if (nd.length)
      m.addLabelComponents(label("Ou pas sur Discord").setStringSelectMenuComponent(pick("nd", nd.map((t) => ({ label: t.label, value: t.value, emoji: t.emoji, description: t.desc })), { min: 0, placeholder: "Pas relié à Discord" })));
    return m.addLabelComponents(
      label("Tu confirmes ?", "Inactif dans l'app ; ses ventes, paies et pointages passés restent").setStringSelectMenuComponent(
        pick("ok", [{ label: "Oui, il sort de partout", value: "yes", emoji: "🚫" }], { placeholder: "Choisis pour confirmer" })
      )
    );
  },
};
// Le chatteur choisi dans la barre de recherche ou une fiche : { id, username, globalName } (null : rien, ou un bot)
const chosenUser = (u) => (u && !u.bot ? { id: u.id, username: u.username, globalName: u.globalName, bot: false } : null);

const open = async (i, view, st = {}) => {
  states.set(i.user.id, { view, ...st });
  await i.deferReply({ flags: EPHEMERAL });
  return showView(i, await VIEWS[view](states.get(i.user.id)));
};

// ---------- Interactions g_… ----------
async function handle(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  // bouton sous le panneau d'un shift : g_xxx~date~créneau vise ce shift-là
  const [id, pDate, pSlot] = i.customId.split("~");
  const pinned = pDate && appSync.START_OF[pSlot] != null ? { date: pDate, slot: pSlot, name: ctx.shiftOfSlot(pSlot) } : null;
  const cur = pinned || ctx.currentShift();
  const needApp = ["g_menu", "g_who", "g_find", "g_new", "g_nd", "g_ndp", "g_plan", "g_rep", "g_mv", "g_ren", "g_box", "g_send", "g_back", "g_off", "g_fire", "g_att", "g_chat", "g_pen"];
  if (needApp.includes(id) && !appSync.enabled())
    return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  // boutons du panneau
  switch (id) {
    // 🛠️ Admin : la gestion du shift de ce panneau, dans un message que l'admin est seul à voir
    case "g_menu": {
      const list = await quick(appSync.appChatters());
      const unlinked = (list || []).filter((c) => c.active && !c.discordId).length;
      const s = ctx.SHIFTS[cur.name];
      return reply(i, { content: `🛠️ **Admin · ${s?.emoji || ""} ${cur.name} · ${planning.dayLabel(cur.date)}**`, components: panelRows(cur.date, appSync.SLOT_OF[cur.name], { unlinked }) }, false);
    }
    // 🔎 Modifs chatteurs : on tape un nom, sa fiche s'ouvre (pas encore dans l'app : ➕ sa fiche de nouveau chatteur)
    case "g_find": {
      const at = { date: cur.date, slot: appSync.SLOT_OF[cur.name] };
      const uid = i.values?.[0];
      const u = i.users?.get(uid);
      whoN = (whoN + 1) % 1000;
      if (u?.bot) return reply(i, { content: "❌ Choisis un chatteur, pas un bot." });
      return ctx.modals.find(i, { ...at, uid, user: u, member: i.members?.get(uid) });
    }
    case "g_new": return ctx.modals.fresh(i, { date: cur.date, slot: appSync.SLOT_OF[cur.name] });
    // 👤 Pas sur Discord : la liste de ceux qui ne sont pas reliés, choisir ouvre sa fiche
    case "g_nd": {
      const list = (await appSync.appChatters()).filter((c) => c.active && !c.discordId).sort((a, b) => a.name.localeCompare(b.name, "fr"));
      if (!list.length) return reply(i, { content: "Tous les chatteurs de l'app sont reliés à Discord : cherche-les dans 🔎 Modifs chatteurs." });
      return reply(i, {
        content: "👤 **Pas sur Discord** : choisis le chatteur, sa fiche s'ouvre (relie son compte Discord dedans).",
        components: [row(new StringSelectMenuBuilder().setCustomId(`g_ndp~${cur.date}~${appSync.SLOT_OF[cur.name]}`).setPlaceholder("Le chatteur").addOptions(list.slice(0, 25).map((c) => opt(c.name, c.id, null, "👤"))))],
      }, false);
    }
    case "g_ndp": return ctx.modals.fiche(i, { date: cur.date, slot: appSync.SLOT_OF[cur.name], cid: i.values?.[0] });
    // 👤 Chatteur (anciens panneaux) : sa fiche, ➕ un nouveau, 🔎 un autre (pas sur ce shift)
    case "g_who": {
      if (!ctx.modals) return ctx.openChatters(i);
      const v = i.values?.[0];
      const at = { date: cur.date, slot: appSync.SLOT_OF[cur.name] };
      const r = v === "_new" ? ctx.modals.fresh(i, at) : v === "_other" ? ctx.modals.change(i, { ...at, mode: "any" }) : ctx.modals.fiche(i, { ...at, cid: v });
      whoN = (whoN + 1) % 1000;
      setTimeout(() => ctx.refreshPanels?.(cur.date), 1500);
      return r;
    }
    case "g_chat": return ctx.openChatters(i);
    case "g_mod": return ctx.openModels ? ctx.openModels(i) : ctx.openMenu(i, "mhome");
    case "g_adm": return ctx.openAdmins ? ctx.openAdmins(i) : ctx.openMenu(i, "ahome");
    // 📅 Planning : la barre « ✏️ Modif par shift » du jour du panneau et du lendemain
    case "g_plan": return ctx.openPlanPick ? ctx.openPlanPick(i, cur.date) : ctx.openPlanning(i, cur.date, "sh", { live: true, slot: appSync.SLOT_OF[cur.name] });
    // remplacer / déplacer / renfort : une fenêtre sur le shift du panneau (ou celui en cours, dès 15 min avant son début)
    case "g_rep":
      if (ctx.modals) return ctx.modals.replace(i, { date: cur.date, slot: appSync.SLOT_OF[cur.name] });
      return ctx.openPlanning(i, cur.date, "rep", { slot: appSync.SLOT_OF[cur.name] });
    case "g_mv":
    case "g_ren":
      if (ctx.modals) return ctx.modals.change(i, { date: cur.date, slot: appSync.SLOT_OF[cur.name], mode: id === "g_ren" ? "ren" : "mv" });
      return ctx.openPlanning(i, cur.date, id === "g_ren" ? "ren" : "mv", { live: id === "g_ren", slot: appSync.SLOT_OF[cur.name] });
    case "g_box": return ctx.openPlanning(i, cur.date, "bx", { live: true, slot: appSync.SLOT_OF[cur.name] });
    case "g_pen": return ctx.openPenalties(i);
    case "g_off":
      await i.deferReply({ flags: EPHEMERAL });
      return i.editReply(await ctx.dayoffView(today().slice(0, 7)));
    case "g_att": return open(i, "att", { name: cur.name, date: cur.date });
    case "g_cut": return i.showModal(FICHES.cut());
    case "g_back": {
      const list = await quick(appSync.openCoupures());
      if (!list) return reply(i, { content: "⏳ L'app répond lentement : réessaie dans un instant." });
      if (!list.length) return reply(i, { content: "🔙 Personne n'est en coupure en ce moment." });
      return i.showModal(FICHES.back(list));
    }
    // l'ancien « Envoyer le planning » (anciens messages) : le salon box le remplace, son message est renvoyé
    case "g_send": {
      await i.deferReply({ flags: EPHEMERAL });
      const r = await ctx.postPlanning();
      return done(i, r?.url ? `✅ Message du salon box renvoyé : ${r.url}` : "⚠️ Lien avec l'app désactivé.", 60000);
    }
    case "g_shift": return i.showModal(FICHES.shift(ctx.currentShift().name));
    case "g_fire": {
      const targets = await quick(ctx.fireTargets());
      if (!targets) return reply(i, { content: "⏳ L'app répond lentement : réessaie dans un instant." });
      return i.showModal(FICHES.fire(targets));
    }
    // ---- fiches envoyées ----
    case "g_cutm": {
      const u = chosenUser(field(i, "getSelectedUsers", "who")?.first?.());
      if (!u) return reply(i, { content: "❌ Choisis le chatteur (pas un bot)." });
      const why = CUT_WHY.find(([k]) => k === (vals(i, "why")[0] || "_").replace("_", ""));
      const note = String(field(i, "getTextInputValue", "note") || "").trim();
      const raison = [why?.[0] ? why[1] : "", note].filter(Boolean).join(" · ");
      return ctx.coupure(i, u, { min: Number(vals(i, "min")[0]) || null, raison });
    }
    case "g_backm": return ctx.retours(i, vals(i, "who"), (vals(i, "give")[0] || "yes") === "yes");
    case "g_sendm": {
      const date = vals(i, "day")[0];
      if (!date) return reply(i, { content: "Choisis le jour." });
      await i.deferReply({ flags: EPHEMERAL });
      const r = await ctx.postPlanning(date);
      return done(i, `✅ Message du salon box renvoyé : ${r?.url}`, 60000);
    }
    case "g_shiftm": {
      const name = vals(i, "shift")[0];
      if (!ctx.SHIFTS[name]) return reply(i, { content: "Choisis le shift." });
      await i.deferReply({ flags: EPHEMERAL });
      await ctx.announceShift(name);
      return done(i, `✅ Panneau du shift **${name}** envoyé dans le salon clocking.`);
    }
    case "g_firem": {
      if (vals(i, "ok")[0] !== "yes") return reply(i, { content: "Rien n'est fait : confirme dans la dernière case." });
      await i.deferReply({ flags: EPHEMERAL });
      const targets = await ctx.fireTargets();
      const u = field(i, "getSelectedUsers", "who")?.first?.();
      const nd = vals(i, "nd")[0];
      const t = u ? targets.find((x) => x.uid === u.id) : nd ? targets.find((x) => x.value === nd) : null;
      if (u?.bot) return done(i, "❌ Choisis un chatteur, pas un bot.", 30000);
      if (u && nd) return done(i, "⚠️ Rien n'est fait : choisis un seul chatteur (la recherche ou la liste pas sur Discord).", 30000);
      if (!t) return done(i, u ? `⚠️ <@${u.id}> n'est ni un chatteur de l'app ni dans le clocking : rien à faire.` : "⚠️ Choisis le chatteur à virer.", 30000);
      return done(i, await ctx.fire(t), 60000);
    }
  }
  const st = states.get(i.user.id);
  if (!st) return done(i, "Ce menu a expiré : reclique sur le panneau.", 8000);
  st.note = "";
  if (id === "g_x") {
    states.delete(i.user.id);
    return done(i, "Annulé.", 5000);
  }
  // raison de la coupure : fenêtre, puis on note
  if (id === "g_cwhy")
    return i.showModal(
      new ModalBuilder().setCustomId("g_cm").setTitle("Coupure").addComponents(
        row(new TextInputBuilder().setCustomId("raison").setLabel("Raison (le chatteur la verra)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200))
      )
    );
  if (id === "g_cok" || id === "g_cm") {
    if (!st.user) return done(i, "Choisis d'abord le chatteur.", 8000);
    states.delete(i.user.id);
    const raison = id === "g_cm" ? (i.fields.getTextInputValue("raison") || "").trim() : "";
    return ctx.coupure(i, st.user, { min: st.min || null, raison, update: true });
  }
  // pointage : retard et coupure demandent les minutes (fenêtre), présent / absent / effacer s'écrivent tout de suite
  if (id === "g_st_retard" || id === "g_st_coupure") {
    const p = st.sel;
    if (!p) return done(i, "Choisis d'abord le chatteur.", 8000);
    const k = id.slice(5);
    const input = (cid, label, v, max) => {
      const t = new TextInputBuilder().setCustomId(cid).setLabel(label).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(max);
      return row(v ? t.setValue(String(v)) : t);
    };
    return i.showModal(
      new ModalBuilder().setCustomId(`g_am_${k}`).setTitle(`${STATUS[k][0]} · ${p.name}`.slice(0, 45)).addComponents(
        input("min", "Minutes", p.min, 4),
        input("note", "Commentaire (optionnel)", p.note, 200)
      )
    );
  }
  if (id === "g_bok") {
    states.delete(i.user.id);
    return ctx.retour(i, { cid: st.cid }, { update: true, giveBack: !st.held || st.give !== false });
  }
  if (id === "g_sd" || id === "g_ss") {
    states.delete(i.user.id);
    await i.deferUpdate();
    if (id === "g_ss") {
      await ctx.announceShift(i.values[0]);
      return done(i, `✅ Panneau du shift **${i.values[0]}** envoyé dans le salon clocking.`);
    }
    const r = await ctx.postPlanning(i.values[0]);
    return done(i, `✅ Message du salon box renvoyé : ${r?.url}`, 60000);
  }
  if (id === "g_fok") {
    const t = (await ctx.fireTargets()).find((x) => x.value === st.target);
    if (!t) return done(i, "Chatteur introuvable : recommence.", 8000);
    states.delete(i.user.id);
    await i.deferUpdate();
    return done(i, await ctx.fire(t), 60000);
  }
  await i.deferUpdate();
  const slotOf = () => appSync.SLOT_OF[st.name];
  if (id.startsWith("g_am_")) {
    const k = id.slice(5);
    const min = Math.round(Number(String(i.fields.getTextInputValue("min") || "").replace(",", "."))) || "";
    await ctx.setMark(st.date, slotOf(), st.cid, { status: k, min: min > 0 ? min : "", note: (i.fields.getTextInputValue("note") || "").trim() });
    st.note = `✅ ${STATUS[k][1]} ${STATUS[k][0]}${min > 0 ? ` · ${min} min` : ""} enregistré.`;
  } else if (id === "g_st_present" || id === "g_st_absent" || id === "g_st_clear") {
    const k = id.slice(5);
    await ctx.setMark(st.date, slotOf(), st.cid, { status: k === "clear" ? "" : k, min: "" });
    st.note = k === "clear" ? "↩️ Pointage effacé." : `✅ ${STATUS[k][1]} ${STATUS[k][0]} enregistré.`;
  } else if (id === "g_allp") {
    const b = await ctx.shiftBoard(st.name, st.date);
    const todo = b.staff.filter((x) => !x.off && !x.mark?.status);
    for (const x of todo) await ctx.setMark(st.date, slotOf(), x.id, { status: "present", min: "" });
    st.note = `✅ ${todo.length} chatteur${todo.length > 1 ? "s" : ""} pointé${todo.length > 1 ? "s" : ""} présent${todo.length > 1 ? "s" : ""}.`;
  } else if (id === "g_as") Object.assign(st, { name: i.values[0], cid: null });
  else if (id.startsWith("g_ac")) {
    const r = await picked(i, (await ctx.shiftBoard(st.name, st.date)).staff, { why: "pas au planning sur ce shift" });
    if (r.c) st.cid = r.c.id;
    else st.note = r.error;
  } else if (id === "g_alt") st.alt = !st.alt;
  else if (id.startsWith("g_ad_")) Object.assign(st, { date: appSync.addDays(st.date, Number(id.slice(5)) || 0), cid: null });
  else if (id === "g_cu") {
    const u = i.users?.get(i.values[0]);
    if (u?.bot) st.note = "❌ Choisis un chatteur, pas un bot.";
    else st.user = u ? { id: u.id, username: u.username, globalName: u.globalName, bot: false } : { id: i.values[0] };
  } else if (id === "g_cd") st.min = Number(i.values[0]) || null;
  else if (id.startsWith("g_bs")) Object.assign(st, { cid: i.values[0], give: true });
  else if (id === "g_bgv") st.give = st.give === false;
  else if (id.startsWith("g_fs")) {
    // tapé dans le menu des membres : le chatteur relié à ce compte, ou ce compte du clocking
    const t = i.isUserSelectMenu?.() ? (await ctx.fireTargets()).find((x) => x.uid === i.values[0]) : { value: i.values[0] };
    if (t) st.target = t.value;
    else st.note = "⚠️ Ce membre n'est ni un chatteur de l'app ni dans le clocking.";
  }
  return showView(i, await VIEWS[st.view](st));
}

module.exports = { ctx, handle, ensurePanel, panelSoon, panelView, panelRows, GESTION_CHANNEL_ID, states };
