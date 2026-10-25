// ================== SALON DAY OFF ==================
// Un tableau du mois dans le salon day off : les day off à venir (qui, quel jour, sur quel shift et quel
// modèle) et le compteur de chaque chatteur (0/3). Les admins posent et retirent les day off depuis Discord,
// avec les règles de l'agence : 3 par mois et par chatteur, un seul off par shift et par modèle le même jour.
// Tout est écrit dans l'app (offs/<id>), qui reste la vue complète.
const { StringSelectMenuBuilder, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const planning = require("./planning");
const { reply, done, showView, row, button, opt, selectMenus, EPHEMERAL } = require("./ui");
const { pickRow, altButton, picked } = require("./pick");
const { SLOTS, withEmoji } = planning;

const DAYOFF_CHANNEL_ID = (process.env.DAYOFF_CHANNEL_ID ?? "1563679742711037992").trim();
// Fourni par index.js : isAdmin(i), getData(), saveData(), client, refreshPlanning(date)
const ctx = {};
const states = new Map(); // userId -> { view, cid, date, rm, pick, note }

const monthOf = (date) => date.slice(0, 7);
const addMonths = (m, n) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const monthLabel = (m, short) =>
  new Date(m + "-15T12:00:00Z").toLocaleDateString("fr-FR", short ? { month: "short", timeZone: "UTC" } : { month: "long", year: "numeric", timeZone: "UTC" });
// « sam. 25 oct. »
const dayShort = (date) =>
  new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const today = () => appSync.parisParts(Date.now()).date;
const who = (c) => (c.discordId ? `<@${c.discordId}>` : `**${c.name}**`);

// « 🌆 Soir · Anna 🍑 »
async function scopeText(sc) {
  const cat = await appSync.appCatalog();
  const slots = sc.slots.map((k) => SLOTS.find((s) => s.k === k)).filter(Boolean).map((s) => `${s.emoji} ${s.l}`).join(" + ");
  const models = sc.mids.filter((m) => cat.models[m]).map((m) => withEmoji(cat.models[m].name)).join(", ");
  return [slots, models].filter(Boolean).join(" · ");
}
// Day off d'une période, avec chatteur et portée (shift + modèles)
async function offsWithScope(from, to) {
  const [offs, chatters] = await Promise.all([appSync.offsBetween(from, to), appSync.appChatters()]);
  const byId = Object.fromEntries(chatters.map((c) => [c.id, c]));
  const list = offs.filter((o) => byId[o.chatterId]).sort((a, b) => a.date.localeCompare(b.date) || byId[a.chatterId].name.localeCompare(byId[b.chatterId].name, "fr"));
  // anciens day off sans shift enregistré : planning du jour, sinon shift habituel
  const dates = [...new Set(list.filter((o) => !o.slots?.length).map((o) => o.date))];
  const plans = Object.fromEntries(await Promise.all(dates.map(async (d) => [d, await appSync.planOf(d)])));
  for (const o of list) {
    o.chatter = byId[o.chatterId];
    o.scope = appSync.offScope(o.chatter, o.date, o, plans[o.date] || []);
    o.scopeTxt = await scopeText(o.scope);
  }
  return { list, chatters };
}

// ---------- Tableau du mois ----------
async function boardView(month, { board = false, admin = true } = {}) {
  const [{ list, chatters }, quota] = await Promise.all([offsWithScope(`${month}-01`, `${month}-31`), appSync.dayOffQuota()]);
  const td = today();
  const cur = month === monthOf(td);
  const shown = cur ? list.filter((o) => o.date >= td) : list;
  const up = shown.map((o) => `**${dayShort(o.date)}** · ${who(o.chatter)}${o.scopeTxt ? ` · ${o.scopeTxt}` : ""}${o.note ? ` · _${o.note}_` : ""}`);
  const top = {
    title: `🏖️ Day off · ${monthLabel(month)}`,
    color: 0xe8875c,
    description: [
      `**${cur ? "À venir" : "Day off du mois"}**`,
      ...(up.length ? up : [cur ? "_Aucun day off à venir ce mois-ci._" : "_Aucun day off ce mois-ci._"]),
    ].join("\n").slice(0, 4000),
  };
  const mine = (id) => list.filter((o) => o.chatterId === id).map((o) => o.date);
  const rows = chatters
    .filter((c) => c.active || mine(c.id).length)
    .map((c) => ({ c, dates: mine(c.id) }))
    .sort((a, b) => b.dates.length - a.dates.length || a.c.name.localeCompare(b.c.name, "fr"));
  const dots = (n) => "●".repeat(Math.min(n, quota)) + "○".repeat(Math.max(0, quota - n)) + (n > quota ? " ⚠️" : "");
  const counter = {
    title: `Compteur · ${quota} day off par chatteur`,
    color: 0x5bae8c,
    // ceux qui en ont pris : une ligne chacun ; les autres : regroupés sur une ligne
    description: [
      ...rows.filter((r) => r.dates.length).map(({ c, dates }) => `\`${dots(dates.length)}\` **${dates.length}/${quota}** ${who(c)} · ${dates.map((d) => +d.slice(8)).join(", ")}`),
      ...(rows.some((r) => !r.dates.length) ? [`\`${dots(0)}\` **0/${quota}** · ${rows.filter((r) => !r.dates.length).map((r) => who(r.c)).join(" ")}`] : []),
    ]
      .join("\n")
      .slice(0, 4000) || "_Aucun chatteur dans l'app._",
    footer: { text: `Règles : ${quota} day off par mois · un seul chatteur off par shift et par modèle le même jour` },
  };
  const prev = addMonths(month, -1), next = addMonths(month, 1);
  const nav = board ? "do_mb" : "do_mv";
  // le tableau est visible par tous : chacun voit ses day off avec 🙋 ; poser / retirer reste aux admins
  const btns = [
    ...(admin ? [button("do_add", "Poser un day off", "➕", ButtonStyle.Success), button("do_rem", "Retirer", "➖", ButtonStyle.Secondary)] : []),
    ...(board ? [button("do_me", "Mes day off", "🙋", ButtonStyle.Primary)] : []),
    button(`${nav}_${prev}`, cap(monthLabel(prev, true)), "◀️", ButtonStyle.Secondary),
    button(`${nav}_${next}`, cap(monthLabel(next, true)), "▶️", ButtonStyle.Secondary),
  ];
  return { embeds: [top, counter], components: [row(...btns)], allowedMentions: { parse: [] } };
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const hashOf = (v) => require("crypto").createHash("md5").update(JSON.stringify({ e: v.embeds, c: v.components.map((r) => r.toJSON()) })).digest("hex");

// Envoie (resend) ou met à jour le tableau du salon day off, un appel après l'autre
let boardChain = Promise.resolve();
function refreshBoard(opts = {}) {
  if (!DAYOFF_CHANNEL_ID || !appSync.enabled()) return Promise.resolve(null);
  const run = boardChain.then(() => updateBoard(opts));
  boardChain = run.catch(() => {});
  return run;
}
async function updateBoard({ resend = false }) {
  const data = ctx.getData();
  const v = await boardView(monthOf(today()), { board: true });
  const hash = hashOf(v);
  const ch = await ctx.client.channels.fetch(DAYOFF_CHANNEL_ID);
  const b = data.dayoffBoard;
  if (b?.messageId && b.channelId === ch.id && !resend) {
    if (b.hash === hash) return b;
    try {
      await ch.messages.edit(b.messageId, v);
      b.hash = hash;
      ctx.saveData();
      return b;
    } catch (e) {
      console.warn("Tableau day off introuvable, renvoyé :", e.message);
    }
  }
  if (b?.messageId && b.channelId === ch.id) await ch.messages.delete(b.messageId).catch(() => {});
  const msg = await ch.send(v);
  data.dayoffBoard = { channelId: ch.id, messageId: msg.id, hash, url: msg.url };
  ctx.saveData();
  return data.dayoffBoard;
}

// ---------- Poser un day off ----------
async function addView(st) {
  const td = today();
  const [{ list, chatters }, quota] = await Promise.all([offsWithScope(td, appSync.addDays(td, 62)), appSync.dayOffQuota()]);
  const month = monthOf(st.date || td);
  const monthOffs = (await appSync.offsBetween(`${month}-01`, `${month}-31`));
  const count = (id) => monthOffs.filter((o) => o.chatterId === id).length;
  const c = chatters.find((x) => x.id === st.cid);
  const habit = (x) => {
    const sc = appSync.offScope(x, st.date || td, null, []);
    return sc.slots.length ? sc : null;
  };
  const chOpts = chatters
    .filter((x) => x.active)
    .sort((a, b) => a.name.localeCompare(b.name, "fr"))
    .map((x) => {
      const h = habit(x);
      const sl = h && SLOTS.find((s) => s.k === h.slots[0]);
      return opt(`${x.name} (${count(x.id)}/${quota})`, x.id, sl ? `Habituellement ${sl.l}` : "", sl?.emoji);
    });
  const days = Array.from({ length: 25 }, (_, k) => appSync.addDays(td, k)).map((d) => {
    const offs = list.filter((o) => o.date === d);
    const desc = offs.length ? `Off : ${offs.map((o) => `${o.chatter.name}${o.scopeTxt ? ` (${o.scopeTxt})` : ""}`).join(", ")}` : "Personne en day off";
    return opt(cap(dayShort(d)), d, desc, offs.length ? "🏖️" : "📅", d === st.date);
  });
  return {
    content: [
      st.note,
      "➕ **Poser un day off**",
      "Choisis le chatteur et le jour. Règles : 3 par mois, un seul off par shift et par modèle le même jour.",
      c ? `Chatteur : **${c.name}** · ${count(c.id)}/${quota} en ${monthLabel(month, true)}` : "",
      st.date ? `Jour : **${planning.dayLabel(st.date)}**` : "",
    ].filter(Boolean).join("\n"),
    components: [
      pickRow("do_ac", { alt: st.alt, opts: chOpts, chatters, cid: st.cid }),
      row(new StringSelectMenuBuilder().setCustomId("do_ad").setPlaceholder("Jour").addOptions(days)),
      row(
        button("do_addok", "Poser le day off", "✅", ButtonStyle.Success, !(c && st.date)),
        button("do_rm", st.rm ? "Retirer ses shifts : oui" : "Retirer ses shifts : non", "🗓️", st.rm ? ButtonStyle.Primary : ButtonStyle.Secondary),
        ...altButton("do_alt", { alt: st.alt, opts: chOpts, chatters }),
        button("do_cancel", "Annuler", null, ButtonStyle.Secondary)
      ),
    ],
  };
}
async function addOk(i, st) {
  const r = await appSync.addOff({ cid: st.cid, date: st.date, removeShifts: st.rm });
  const day = planning.dayLabel(st.date);
  if (r.error === "unknown") return "⛔ Chatteur introuvable dans l'app.";
  if (r.error === "already") return `⛔ **${r.chatter.name}** est déjà en day off le ${day}.`;
  if (r.error === "quota")
    return `⛔ Pas possible : **${r.chatter.name}** a déjà pris ${r.quota} day off en ${monthLabel(monthOf(st.date), true)} (le ${r.taken.map((d) => +d.slice(8)).join(", ")}).`;
  if (r.error === "conflict")
    return `⛔ Pas possible : **${r.other.name}** est déjà off le ${day} sur ${await scopeText(r.otherScope)} (un seul off par shift et par modèle).`;
  const sc = await scopeText(r.scope);
  ctx.refreshPlanning?.(st.date);
  refreshBoard().catch((e) => console.error("Tableau day off :", e.message));
  states.delete(i.user.id);
  return done(
    i,
    [
      `✅ Day off posé : **${r.chatter.name}** le ${day}${sc ? ` (${sc})` : ""} · ${r.count}/${r.quota} ce mois-ci.`,
      r.removed ? `🗓️ Retiré du planning ce jour-là (${r.removed} shift${r.removed > 1 ? "s" : ""}).` : "",
    ].filter(Boolean).join("\n"),
    30000
  );
}

// ---------- Retirer ----------
async function remView(st) {
  const td = today();
  const { list } = await offsWithScope(td, appSync.addDays(td, 90));
  const opts = list.slice(0, 25).map((o) => opt(`${cap(dayShort(o.date))} · ${o.chatter.name}`, o.id, o.scopeTxt, "🏖️"));
  const pick = (st.pick || []).filter((id) => list.some((o) => o.id === id));
  return {
    content: [
      st.note,
      "➖ **Retirer un day off**",
      opts.length ? "Coche les day off à retirer. Ses shifts ne reviennent pas tout seuls au planning (➕ Ajouter dans le salon planning)." : "_Aucun day off à venir._",
    ].filter(Boolean).join("\n"),
    components: [
      ...(opts.length
        ? [row(new StringSelectMenuBuilder().setCustomId("do_rs").setPlaceholder("Day off à retirer").setMinValues(0).setMaxValues(opts.length).addOptions(opts.map((o) => ({ ...o, default: pick.includes(o.value) }))))]
        : []),
      row(
        button("do_remok", pick.length ? `Retirer (${pick.length})` : "Retirer", "🗑️", ButtonStyle.Danger, !pick.length),
        button("do_cancel", "Annuler", null, ButtonStyle.Secondary)
      ),
    ],
  };
}
async function remOk(i, st) {
  const td = today();
  const { list } = await offsWithScope(td, appSync.addDays(td, 90));
  const gone = list.filter((o) => (st.pick || []).includes(o.id));
  for (const o of gone) await appSync.delDoc("offs", o.id);
  for (const d of new Set(gone.map((o) => o.date))) ctx.refreshPlanning?.(d);
  refreshBoard().catch((e) => console.error("Tableau day off :", e.message));
  states.delete(i.user.id);
  return done(i, gone.length ? `🗑️ Day off retiré : ${gone.map((o) => `**${o.chatter.name}** (${dayShort(o.date)})`).join(", ")}.` : "Rien à retirer.", 30000);
}

// ---------- Mes day off (pour chaque chatteur) ----------
async function mine(i) {
  await i.deferReply({ flags: EPHEMERAL });
  const names = [i.member?.displayName, i.user.globalName, i.user.username].filter(Boolean);
  const c = await appSync.chatterOf(i.user.id, names, false);
  if (!c) return done(i, "Ton compte Discord n'est relié à aucun chatteur de l'app : demande à un admin.", 30000);
  const td = today();
  const m = monthOf(td), next = addMonths(m, 1);
  const [{ list }, quota] = await Promise.all([offsWithScope(`${m}-01`, `${next}-31`), appSync.dayOffQuota()]);
  const my = list.filter((o) => o.chatterId === c.id);
  const line = (mo) => {
    const l = my.filter((o) => monthOf(o.date) === mo);
    return `**${cap(monthLabel(mo))}** : ${l.length}/${quota}${l.length ? ` · ${l.map((o) => `${dayShort(o.date)}${o.scopeTxt ? ` (${o.scopeTxt})` : ""}${o.date < td ? " ✓" : ""}`).join(", ")}` : ""}`;
  };
  const left = Math.max(0, quota - my.filter((o) => monthOf(o.date) === m).length);
  return done(i, [`🏖️ **Tes day off, ${c.name}**`, line(m), line(next), `-# Il t'en reste ${left} ce mois-ci. Pour en poser un, demande à un admin.`].join("\n"), 60000);
}

// ---------- Interactions (boutons et menus do_…) ----------
async function handle(i) {
  const id = i.customId;
  if (!appSync.enabled()) return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  // autre mois : depuis le tableau (nouveau message éphémère) ou depuis ce message éphémère
  const nav = id.match(/^do_m([bv])_(\d{4}-\d{2})$/);
  if (nav) {
    if (nav[1] === "b") await i.deferReply({ flags: EPHEMERAL });
    else await i.deferUpdate();
    return i.editReply(await boardView(nav[2], { admin: false }));
  }
  if (id === "do_me") return mine(i);
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Seuls les admins posent ou retirent les day off : demande à un admin. Tes day off : 🙋 **Mes day off**." });
  if (id === "do_add" || id === "do_rem") {
    const st = { view: id === "do_add" ? "add" : "rem", rm: true };
    states.set(i.user.id, st);
    await i.deferReply({ flags: EPHEMERAL });
    return showView(i, await (st.view === "add" ? addView(st) : remView(st)));
  }
  const st = states.get(i.user.id);
  if (!st) return done(i, "Ce menu a expiré : reclique sur le tableau des day off.", 8000);
  st.note = "";
  if (id === "do_cancel") {
    states.delete(i.user.id);
    return done(i, "Annulé.", 5000);
  }
  await i.deferUpdate();
  if (id.startsWith("do_ac")) {
    const r = await picked(i, (await appSync.appChatters()).filter((x) => x.active), { why: "inactif" });
    if (r.c) st.cid = r.c.id;
    else st.note = r.error;
  } else if (id === "do_alt") st.alt = !st.alt;
  else if (id === "do_ad") st.date = i.values[0];
  else if (id === "do_rm") st.rm = !st.rm;
  else if (id === "do_rs") st.pick = i.values;
  else if (id === "do_addok") {
    const r = await addOk(i, st);
    if (typeof r === "string") st.note = r;
    else return r;
  } else if (id === "do_remok") return remOk(i, st);
  return showView(i, await (st.view === "add" ? addView(st) : remView(st)));
}

module.exports = { ctx, handle, refreshBoard, boardView, DAYOFF_CHANNEL_ID, states };
