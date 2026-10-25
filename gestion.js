// ================== SALON GESTION : LE PANNEAU DES ADMINS ==================
// Un message fixe dans le salon gestion avec un bouton par sujet, à la place des commandes « / ».
// Chaque bouton ouvre un menu visible seulement par l'admin qui a cliqué. Les commandes restent en secours.
const { StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const planning = require("./planning");
const { reply, done, showView, row, button, opt, selectMenus, EPHEMERAL } = require("./ui");

const GESTION_CHANNEL_ID = (process.env.GESTION_CHANNEL_ID ?? "1563688546303217784").trim();
// Fourni par index.js : isAdmin, client, getData, saveData, SHIFTS, liveEmbed(), currentShift(), shiftBoard(name, date),
// setMark(date, slot, cid, patch), openMenu(i, menu), openChatters(i), openPlanning(i, date, view, extra), openPenalties(i), heldText(date, slot, cid),
// dayoffView(month), coupure(i, user, opts), retour(i, target, opts), postPlanning(date), announceShift(name),
// dayChoices(), fireTargets(), firePreview(target), fire(target)
const ctx = {};
const states = new Map(); // userId -> état du menu en cours

const DURATIONS = [5, 10, 15, 20, 30, 45, 60, 90, 120];
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
        button("g_ren", "Renfort", "➕", ButtonStyle.Secondary),
        button("g_send", "Envoyer le planning", "📣", ButtonStyle.Secondary)
      ),
      row(
        button("g_att", "Pointer", "📋", ButtonStyle.Primary),
        button("g_cut", "Coupure", "✂️", ButtonStyle.Secondary),
        button("g_back", "Retour de coupure", "🟢", ButtonStyle.Secondary),
        button("g_off", "Day off", "🏖️", ButtonStyle.Secondary),
        button("g_shift", "Message de shift", "🔔", ButtonStyle.Secondary)
      ),
      row(button("g_pen", "Pénalités", "⚠️", ButtonStyle.Primary), button("g_fire", "Virer un chatteur", "🚫", ButtonStyle.Danger)),
    ],
    allowedMentions: { parse: [] },
  };
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
const STATUS = { present: ["Présent", "🟢", ButtonStyle.Success], retard: ["Retard", "🟠", ButtonStyle.Secondary], coupure: ["Coupure", "🔵", ButtonStyle.Secondary], absent: ["Absent", "🔴", ButtonStyle.Danger] };
const SEMOJI = { present: "🟢", retard: "🟠", coupure: "🔵", absent: "🔴", todo: "⚪", off: "🏖️" };
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
        p ? `\n**${p.name}** · ${SEMOJI[b.stOf(p)]} ${b.detail(p)}` : people.length ? "Choisis un chatteur, puis son statut." : "",
      ].filter(Boolean).join("\n"),
      components: [
        row(
          new StringSelectMenuBuilder()
            .setCustomId("g_as")
            .setPlaceholder("Shift")
            .addOptions(Object.entries(ctx.SHIFTS).map(([k, v]) => opt(`${k} (${v.label})`, k, null, v.emoji, k === st.name)))
        ),
        ...selectMenus("g_ac", people.map((x) => opt(x.name, x.id, b.detail(x), SEMOJI[b.stOf(x)])), { placeholder: "Chatteur", max: 1, chosen: [st.cid] }),
        row(
          ...Object.entries(STATUS).map(([k, [l, e, style]]) => button(`g_st_${k}`, l, e, style, !p || p.off)),
          button("g_st_clear", "Effacer", "↩️", ButtonStyle.Secondary, !p?.mark?.status)
        ),
        row(
          button("g_allp", todo.length ? `Tous les autres présents (${todo.length})` : "Tous les autres présents", "✅", ButtonStyle.Success, !todo.length),
          button("g_ad_-1", "Jour d'avant", "◀️", ButtonStyle.Secondary),
          button("g_ad_1", "Jour d'après", "▶️", ButtonStyle.Secondary),
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
        "✂️ **Noter une coupure**",
        "Le chatteur est notifié dans le salon clocking et passe en « Coupure » au pointage. À son retour : 🟢 **Retour de coupure**.",
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
          button("g_cok", "Noter la coupure", "✂️", ButtonStyle.Primary, !st.user),
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
        "🟢 **Retour de coupure**",
        list.length ? "Choisis qui revient : le temps de coupure est compté au pointage, comme un retard." : "_Personne n'est en coupure en ce moment._",
        held ? `📦 Ses box pendant la coupure : ${held}${st.give === false ? " · il ne les reprend pas" : " · il les reprend à son retour"}` : "",
      ].filter(Boolean).join("\n"),
      components: [
        ...(list.length
          ? selectMenus(
              "g_bs",
              list.map((c) => opt(c.name, c.id, `En coupure depuis ${fmt(c.since)}${sl(c.slot) ? ` · ${sl(c.slot).l}` : ""}`, "✂️")),
              { placeholder: "Qui revient ?", max: 1, chosen: [st.cid] }
            )
          : []),
        row(
          button("g_bok", "Retour", "🟢", ButtonStyle.Success, !st.cid),
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
  // Renvoyer le message de début de shift (boutons Clock In / Clock Out)
  shift() {
    return {
      content: "🔔 **Renvoyer le message de début de shift** dans le salon clocking.",
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
    const lines = [st.note, "🚫 **Virer un chatteur**", "Il sort de partout : clocking, shift habituel, planning à venir (box comprises), day off à venir. Il passe inactif dans l'app ; ses ventes, paies et pointages passés restent."].filter(Boolean);
    if (t) lines.push("", `**${t.label}** :`, ...(await ctx.firePreview(t)).map((x) => `• ${x}`));
    return {
      content: lines.join("\n"),
      components: [
        ...selectMenus("g_fs", targets.map((x) => opt(x.label, x.value, x.desc, x.emoji)), { placeholder: "Le chatteur à virer", max: 2, chosen: [st.target] }),
        row(button("g_fok", t ? `Oui, virer ${t.label}`.slice(0, 80) : "Virer", "🚫", ButtonStyle.Danger, !t), cancelBtn()),
      ],
    };
  },
};
const fmt = (t) => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
const open = async (i, view, st = {}) => {
  states.set(i.user.id, { view, ...st });
  await i.deferReply({ flags: EPHEMERAL });
  return showView(i, await VIEWS[view](states.get(i.user.id)));
};

// ---------- Interactions g_… ----------
async function handle(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const id = i.customId;
  const needApp = ["g_plan", "g_rep", "g_mv", "g_ren", "g_send", "g_back", "g_off", "g_fire", "g_att", "g_chat", "g_pen"];
  if (needApp.includes(id) && !appSync.enabled())
    return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  // boutons du panneau
  switch (id) {
    case "g_chat": return ctx.openChatters(i);
    case "g_mod": return ctx.openMenu(i, "mhome");
    case "g_adm": return ctx.openMenu(i, "ahome");
    case "g_plan": return ctx.openPlanning(i, today(), "list");
    // remplacer / déplacer : sur le shift en cours
    case "g_rep":
    case "g_mv": {
      const cur = ctx.currentShift();
      return ctx.openPlanning(i, cur.date, id === "g_rep" ? "rep" : "mv", { slot: appSync.SLOT_OF[cur.name] });
    }
    // renfort : sur le shift en cours ou un des suivants
    case "g_ren": return ctx.openPlanning(i, today(), "ren", { live: true });
    case "g_pen": return ctx.openPenalties(i);
    case "g_off":
      await i.deferReply({ flags: EPHEMERAL });
      return i.editReply(await ctx.dayoffView(today().slice(0, 7)));
    case "g_att": return open(i, "att", ctx.currentShift());
    case "g_cut": return open(i, "cut");
    case "g_back": return open(i, "back");
    case "g_send": return open(i, "send");
    case "g_shift": return open(i, "shift");
    case "g_fire": return open(i, "fire");
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
      return done(i, `✅ Message du shift **${i.values[0]}** envoyé dans le salon clocking.`);
    }
    const r = await ctx.postPlanning(i.values[0]);
    return done(i, `✅ Planning du ${planning.dayLabel(i.values[0])} envoyé (${r.count} chatteur${r.count > 1 ? "s" : ""}) : ${r.url}`, 60000);
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
  else if (id.startsWith("g_ac")) st.cid = i.values[0];
  else if (id.startsWith("g_ad_")) Object.assign(st, { date: appSync.addDays(st.date, Number(id.slice(5)) || 0), cid: null });
  else if (id === "g_cu") {
    const u = i.users?.get(i.values[0]);
    if (u?.bot) st.note = "❌ Choisis un chatteur, pas un bot.";
    else st.user = u ? { id: u.id, username: u.username, globalName: u.globalName, bot: false } : { id: i.values[0] };
  } else if (id === "g_cd") st.min = Number(i.values[0]) || null;
  else if (id.startsWith("g_bs")) Object.assign(st, { cid: i.values[0], give: true });
  else if (id === "g_bgv") st.give = st.give === false;
  else if (id.startsWith("g_fs")) st.target = i.values[0];
  return showView(i, await VIEWS[st.view](st));
}

module.exports = { ctx, handle, ensurePanel, panelSoon, panelView, GESTION_CHANNEL_ID, states };
