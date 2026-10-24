// ================== PLANNING MODIFIABLE DEPUIS DISCORD ==================
// Sous le planning du salon planning : ✏️ Modifier, 🔁 Remplacer, ➕ Ajouter (admins, en message éphémère).
// Chaque changement est écrit tout de suite dans le planning de l'app (plan/<date>, comme l'app le fait),
// puis le message du salon se met à jour. L'app reste la vue complète ; Discord sert à saisir vite.
const { StringSelectMenuBuilder, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const planning = require("./planning");
const { reply, done, showView, row, button, opt, selectMenus, EPHEMERAL } = require("./ui");
const { SLOTS, withEmoji, boxList, boxesS, dayLabel } = planning;

// Fourni par index.js : isAdmin(i), refresh(date), notify(payload), coupure({ cid, slot, date })
const ctx = {};
const states = new Map(); // userId -> { date, only, view, sid, bm, cid, slot, out, inn, cut, note }

const slotOf = (k) => SLOTS.find((s) => s.k === k) || { k, l: k, emoji: "", h: "" };
const BOX_OPTS = [["all", "All Inbox"], ...Array.from({ length: 15 }, (_, k) => [String(k + 1), `Box ${k + 1}`])];

// Tout ce qu'il faut pour un jour : planning, chatteurs, comptes de l'app, day off
async function load(date) {
  const [day, cat] = await Promise.all([appSync.planningDay(date), appSync.appCatalog()]);
  const byId = Object.fromEntries(day.chatters.map((c) => [c.id, c]));
  const plan = day.plan
    .filter((s) => byId[s.chatterId])
    .sort((a, b) => SLOTS.findIndex((x) => x.k === a.slot) - SLOTS.findIndex((x) => x.k === b.slot) || byId[a.chatterId].name.localeCompare(byId[b.chatterId].name, "fr"));
  const mName = (mid) => withEmoji(cat.models[mid]?.name || mid);
  return { ...day, plan, byId, cat, off: new Set(day.offs), mName };
}
const midsOf = (accts) => [...new Set((accts || []).map((k) => k.split("|")[0]).filter(Boolean))];
// « **Anna 🍑** Telegram **B1·2** · **Axelle 🍒** Telegram **B4** »
function acctsText(d, accts, boxes, md = true) {
  const b = (x) => (md ? `**${x}**` : x);
  const parts = midsOf(accts).map((mid) => {
    const plats = (accts || []).filter((k) => k.startsWith(mid + "|")).map((k) => d.cat.platName(k.split("|")[1]));
    const bx = boxesS(boxList(boxes?.[mid]));
    return [b(d.mName(mid)), plats.join(" + "), bx ? b(bx) : ""].filter(Boolean).join(" ");
  });
  return parts.join(" · ") || "aucun compte";
}
const whoMd = (c) => `**${c.name}**`;
const chatterOpts = (d, { except = [], date } = {}) =>
  Object.values(d.byId)
    .filter((c) => c.active && !except.includes(c.id))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"))
    .map((c) => {
      const h = c.shift && slotOf(c.shift.slot);
      const desc = d.off.has(c.id) ? "En day off ce jour-là" : h?.l ? `Habituellement ${h.l} · ${acctsText(d, c.shift.accts, null, false)}` : "";
      return opt(c.name, c.id, desc, d.off.has(c.id) ? "🏖️" : h?.emoji || undefined);
    });
const entryOpts = (d, list = d.plan) =>
  list.map((s) => opt(`${d.byId[s.chatterId].name} · ${slotOf(s.slot).l}${d.off.has(s.chatterId) ? " (day off)" : ""}`, s.sid, acctsText(d, s.accts, s.boxes, false), slotOf(s.slot).emoji || undefined));
const slotMenu = (id, cur, placeholder = "Shift") =>
  row(
    new StringSelectMenuBuilder()
      .setCustomId(id)
      .setPlaceholder(placeholder)
      .addOptions(SLOTS.map((s) => opt(`${s.l} (${s.h})`, s.k, null, s.emoji, s.k === cur)))
  );
const navRow = (extra = []) =>
  row(
    ...extra,
    button("pe_day_-1", "Jour d'avant", "◀️", ButtonStyle.Secondary),
    button("pe_day_1", "Jour d'après", "▶️", ButtonStyle.Secondary)
  );
// Lignes affichées : tout le jour, ou seulement le shift du message de début de shift
const shown = (st, d) => (st.only ? d.plan.filter((s) => s.slot === st.only) : d.plan);
const backBtn = () => button("pe_back", "Retour", "↩️", ButtonStyle.Secondary);
const head = (st, lines) => [st.note, ...lines].filter(Boolean).join("\n");

// ---------- Vues ----------
const VIEWS = {
  // Liste des chatteurs du jour
  async list(st) {
    const d = await load(st.date);
    const list = shown(st, d);
    const only = st.only && slotOf(st.only);
    return {
      content: head(st, [
        `✏️ **Planning du ${dayLabel(st.date)}**${only ? ` · ${only.emoji} ${only.l}` : ""}`,
        list.length ? "Choisis un chatteur pour changer son shift, ses comptes ou ses box." : "_Personne au planning : ajoute quelqu'un avec ➕._",
      ]),
      components: [
        ...selectMenus("pe_pick", entryOpts(d, list), { placeholder: "Chatteur à modifier", max: 3 }),
        navRow([
          button("pe_add", "Ajouter", "➕", ButtonStyle.Success),
          button("pe_rep", "Remplacer", "🔁", ButtonStyle.Primary, !list.length),
        ]),
      ],
    };
  },
  // Un chatteur : shift, comptes, box
  async edit(st) {
    const d = await load(st.date);
    const e = d.plan.find((s) => s.sid === st.sid);
    if (!e) return VIEWS.list({ ...st, note: "⚠️ Cette ligne n'est plus au planning (changée dans l'app ?)." });
    const c = d.byId[e.chatterId];
    const mids = midsOf(e.accts);
    if (!mids.includes(st.bm)) st.bm = mids[0];
    const accts = d.cat.accounts.slice(0, 25);
    const boxes = boxList(e.boxes?.[st.bm]);
    const sl = slotOf(e.slot);
    const comps = [
      slotMenu("pe_slot", e.slot, "Changer de shift"),
      row(
        new StringSelectMenuBuilder()
          .setCustomId("pe_acc")
          .setPlaceholder("Comptes (modèle et plateforme)")
          .setMinValues(0)
          .setMaxValues(Math.max(1, accts.length))
          .addOptions(accts.length ? accts.map((a) => opt(`${withEmoji(a.model)} · ${a.platform}`, a.key, null, null, (e.accts || []).includes(a.key))) : [opt("Aucun compte dans l'app", "none")])
      ),
    ];
    if (st.bm)
      comps.push(
        row(
          new StringSelectMenuBuilder()
            .setCustomId("pe_box")
            .setPlaceholder(`Box sur ${d.mName(st.bm)}`.slice(0, 150))
            .setMinValues(0)
            .setMaxValues(BOX_OPTS.length)
            .addOptions(BOX_OPTS.map(([v, l]) => opt(`${l} · ${d.mName(st.bm)}`, v, null, null, boxes.includes(v))))
        )
      );
    const next = mids.length > 1 && mids[(mids.indexOf(st.bm) + 1) % mids.length];
    comps.push(
      row(
        ...(next ? [button("pe_bm", `Box de ${d.mName(next)}`.slice(0, 80), "🔀", ButtonStyle.Secondary)] : []),
        button("pe_del", "Retirer du planning", "🗑️", ButtonStyle.Danger),
        backBtn()
      )
    );
    return {
      content: head(st, [
        `✏️ ${whoMd(c)} · ${sl.emoji} ${sl.l} · ${dayLabel(st.date)}${d.off.has(c.id) ? " · 🏖️ day off" : ""}`,
        acctsText(d, e.accts, e.boxes),
        mids.length > 1 ? `_Les box se règlent modèle par modèle : 🔀 pour passer à l'autre._` : "",
      ]),
      components: comps,
    };
  },
  // Ajouter quelqu'un
  async add(st) {
    const d = await load(st.date);
    const c = st.cid && d.byId[st.cid];
    return {
      content: head(st, [
        `➕ **Ajouter au planning du ${dayLabel(st.date)}**`,
        "Choisis le chatteur et son shift : ses comptes habituels sont repris, tu pourras les changer juste après.",
        c ? `Chatteur : ${whoMd(c)}${st.slot ? ` · ${slotOf(st.slot).emoji} ${slotOf(st.slot).l}` : ""}` : "",
      ]),
      components: [
        ...selectMenus("pe_ac", chatterOpts(d), { placeholder: "Chatteur", max: 3, chosen: [st.cid] }),
        slotMenu("pe_as", st.slot),
        row(button("pe_addok", "Ajouter", "✅", ButtonStyle.Success, !(c && st.slot)), backBtn()),
      ],
    };
  },
  // Remplacer : qui part, qui le remplace (il reprend les comptes et les box)
  async rep(st) {
    const d = await load(st.date);
    const e = st.out && d.plan.find((s) => s.sid === st.out);
    const r = st.inn && d.byId[st.inn];
    return {
      content: head(st, [
        `🔁 **Remplacer un chatteur** · ${dayLabel(st.date)}`,
        "Le remplaçant reprend les comptes et les box de celui qui part. Celui qui part reste au planning, sans box.",
        e ? `Part : ${whoMd(d.byId[e.chatterId])} · ${slotOf(e.slot).emoji} ${slotOf(e.slot).l} · ${acctsText(d, e.accts, e.boxes)}` : "",
        r ? `Le remplace : ${whoMd(r)}${d.off.has(r.id) ? " · ⚠️ en day off ce jour-là" : ""}` : "",
      ]),
      components: [
        ...selectMenus("pe_ro", entryOpts(d, shown(st, d)), { placeholder: "Qui part ?", max: 2, chosen: [st.out] }),
        ...selectMenus("pe_ri", chatterOpts(d, { except: e ? [e.chatterId] : [] }), { placeholder: "Qui le remplace ?", max: 2, chosen: [st.inn] }),
        row(
          button("pe_cut", st.cut ? "Noter une coupure : oui" : "Noter une coupure : non", "✂️", st.cut ? ButtonStyle.Primary : ButtonStyle.Secondary),
          button("pe_repok", "Remplacer", "🔁", ButtonStyle.Success, !(e && r)),
          backBtn()
        ),
      ],
    };
  },
};
const render = async (i, st, fresh) => showView(i, await VIEWS[st.view](st), fresh);

// ---------- Ouverture (boutons du salon planning, message vocal) ----------
async function open(i, date, view, extra = {}) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  if (!appSync.enabled()) return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  const st = { date, view, cut: false, ...extra };
  states.set(i.user.id, st);
  await i.deferReply({ flags: EPHEMERAL });
  return render(i, st);
}
// Depuis le message « a quitté le vocal » : remplacer ce chatteur sur son shift en cours
async function openReplaceFor(i, uid) {
  const now = Date.now();
  let extra = {};
  let date = appSync.parisParts(now).date;
  if (appSync.enabled()) {
    const p = await appSync.plannedSlotAt(uid, [], now).catch(() => null);
    if (p) {
      date = p.date;
      const c = (await appSync.appChatters()).find((x) => x.discordId === uid);
      const e = c && (await appSync.planOf(p.date)).find((s) => s.chatterId === c.id && s.slot === p.slot);
      if (e) extra = { out: e.sid, cut: true };
    }
  }
  return open(i, date, "rep", extra);
}

// ---------- Actions ----------
async function save(st, patch) {
  await appSync.writePlan(st.date, patch);
  ctx.refresh?.(st.date);
}
async function handle(i) {
  const id = i.customId;
  // boutons sous le planning du salon : pl_<vue>_<date>, ou sous le message de début de shift : pl_edit_<date>_<créneau>
  const pub = id.match(/^pl_(edit|rep|add)_(\d{4}-\d{2}-\d{2})(?:_([a-z]+))?$/);
  if (pub) return open(i, pub[2], { edit: "list", rep: "rep", add: "add" }[pub[1]], pub[3] ? { only: pub[3], slot: pub[3] } : {});
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const st = states.get(i.user.id);
  if (!st) return done(i, "Ce menu a expiré : reclique sur un bouton du planning.", 8000);
  st.note = "";
  const [, act, arg] = id.split("_");
  const v = i.values?.[0];
  await i.deferUpdate();

  if (act === "back") st.view = "list";
  else if (act === "day") {
    st.date = appSync.addDays(st.date, Number(arg) || 0);
    st.view = "list";
  } else if (act === "add") Object.assign(st, { view: "add", cid: null, slot: st.only || null });
  else if (act === "rep") Object.assign(st, { view: "rep", out: null, inn: null, cut: false });
  else if (act === "pick") Object.assign(st, { view: "edit", sid: v, bm: null });
  else if (act === "bm") {
    const d = await load(st.date);
    const mids = midsOf(d.plan.find((s) => s.sid === st.sid)?.accts);
    st.bm = mids[(mids.indexOf(st.bm) + 1) % mids.length];
  } else if (act === "slot" || act === "acc" || act === "box" || act === "del") {
    const d = await load(st.date);
    const e = d.plan.find((s) => s.sid === st.sid);
    if (!e) st.view = "list";
    else if (act === "slot") {
      if (v !== e.slot && d.plan.some((s) => s.chatterId === e.chatterId && s.slot === v))
        st.note = `⚠️ ${whoMd(d.byId[e.chatterId])} est déjà au planning sur ce shift.`;
      else if (v !== e.slot) {
        await save(st, { [e.sid]: { slot: v } });
        st.note = `✅ Passé en ${slotOf(v).emoji} ${slotOf(v).l}.`;
      }
    } else if (act === "acc") {
      const accts = i.values.filter((x) => x !== "none");
      const gone = midsOf(e.accts).filter((m) => !midsOf(accts).includes(m));
      const boxes = Object.fromEntries(Object.keys(e.boxes || {}).filter((m) => gone.includes(m)).map((m) => [m, null]));
      await save(st, { [e.sid]: { accts, ...(Object.keys(boxes).length ? { boxes } : {}) } });
      st.note = "✅ Comptes enregistrés.";
    } else if (act === "box") {
      const before = boxList(e.boxes?.[st.bm]);
      let l = boxList(i.values);
      // All Inbox seul, ou des box numérotées
      if (l.includes("all") && l.length > 1) l = before.includes("all") ? l.filter((x) => x !== "all") : ["all"];
      await save(st, { [e.sid]: { boxes: { [st.bm]: l.length ? l : null } } });
      st.note = `✅ Box sur ${d.mName(st.bm)} : **${l.length ? boxesS(l) : "aucune"}**.`;
    } else {
      await save(st, { [e.sid]: null });
      st.view = "list";
      st.note = `🗑️ ${whoMd(d.byId[e.chatterId])} retiré du ${slotOf(e.slot).l}.`;
    }
  } else if (act === "ac") {
    st.cid = v;
    const c = (await appSync.appChatters()).find((x) => x.id === v);
    if (!st.slot && c?.shift?.slot) st.slot = c.shift.slot; // son shift habituel par défaut
  }
  else if (act === "as") st.slot = v;
  else if (act === "addok") {
    const d = await load(st.date);
    const c = d.byId[st.cid];
    const e = c && d.plan.find((s) => s.chatterId === c.id && s.slot === st.slot);
    if (!c || !st.slot) st.note = "Choisis le chatteur et le shift.";
    else if (d.off.has(c.id)) st.note = `⛔ ${whoMd(c)} est en day off ce jour-là.`;
    else if (e) Object.assign(st, { view: "edit", sid: e.sid, bm: null, note: `ℹ️ ${whoMd(c)} est déjà sur ce shift : modifie-le ici.` });
    else {
      const sid = appSync.newId();
      await save(st, { [sid]: { slot: st.slot, chatterId: c.id, accts: c.shift?.accts || [] } });
      Object.assign(st, { view: "edit", sid, bm: null, note: `✅ ${whoMd(c)} ajouté en ${slotOf(st.slot).emoji} ${slotOf(st.slot).l}. Règle ses comptes et ses box :` });
    }
  } else if (act === "ro") {
    st.out = v;
    st.inn = null;
  } else if (act === "ri") st.inn = v;
  else if (act === "cut") st.cut = !st.cut;
  else if (act === "repok") st.note = await replace(st);
  return render(i, st);
}

// Le remplaçant reprend les comptes et les box ; celui qui part garde sa place sans box (et sa coupure)
async function replace(st) {
  const d = await load(st.date);
  const e = d.plan.find((s) => s.sid === st.out);
  const r = d.byId[st.inn];
  if (!e || !r) return "Choisis qui part et qui le remplace.";
  if (r.id === e.chatterId) return "⚠️ Choisis un autre chatteur pour le remplacer.";
  if (d.off.has(r.id)) return `⛔ ${whoMd(r)} est en day off ce jour-là.`;
  const out = d.byId[e.chatterId];
  const boxes = Object.fromEntries(Object.entries(e.boxes || {}).map(([m, v]) => [m, boxList(v)]).filter(([m, v]) => v.length && midsOf(e.accts).includes(m)));
  const target = d.plan.find((s) => s.chatterId === r.id && s.slot === e.slot);
  const patch = {};
  if (target) {
    const merged = { ...Object.fromEntries(Object.entries(target.boxes || {}).map(([m, v]) => [m, boxList(v)])) };
    for (const [m, v] of Object.entries(boxes)) merged[m] = boxList([...(merged[m] || []), ...v]);
    patch[target.sid] = { accts: [...new Set([...(target.accts || []), ...(e.accts || [])])], ...(Object.keys(boxes).length ? { boxes: merged } : {}) };
  } else patch[appSync.newId()] = { slot: e.slot, chatterId: r.id, accts: [...(e.accts || [])], ...(Object.keys(boxes).length ? { boxes } : {}) };
  if (Object.keys(e.boxes || {}).length) patch[e.sid] = { boxes: Object.fromEntries(Object.keys(e.boxes).map((m) => [m, null])) };
  await save(st, patch);
  const sl = slotOf(e.slot);
  const what = acctsText(d, e.accts, e.boxes);
  let cut = "";
  if (st.cut) {
    const res = await ctx.coupure?.({ cid: out.id, slot: e.slot, date: st.date }).catch((err) => ({ error: err.message }));
    cut = res?.error ? ` ⚠️ Coupure pas notée : ${String(res.error).slice(0, 120)}` : " ✂️ Coupure notée au pointage.";
  }
  // prévient les deux dans le salon clocking si le shift est en cours (ou commence bientôt)
  const start = appSync.parisMs(st.date, appSync.START_OF[e.slot]);
  if (Date.now() >= start - 2 * 3600e3 && Date.now() < start + 6 * 3600e3) {
    const tag = (c) => (c.discordId ? `<@${c.discordId}>` : `**${c.name}**`);
    await ctx.notify?.({
      content: `🔁 ${tag(r)} remplace ${tag(out)}${st.cut ? " (✂️ coupure)" : ""} · ${sl.emoji} ${sl.l} · ${what}`,
      allowedMentions: { users: [r.discordId, out.discordId].filter(Boolean) },
    }).catch((err) => console.error("Remplacement (salon clocking) :", err.message));
  }
  Object.assign(st, { view: "list", out: null, inn: null, cut: false });
  return `✅ ${whoMd(r)} reprend ${what} de ${whoMd(out)} sur ${sl.emoji} ${sl.l}.${cut}`;
}

// Boutons sous le planning du salon
const planButtons = (date) => [
  row(
    button(`pl_edit_${date}`, "Modifier", "✏️", ButtonStyle.Primary),
    button(`pl_rep_${date}`, "Remplacer", "🔁", ButtonStyle.Secondary),
    button(`pl_add_${date}`, "Ajouter", "➕", ButtonStyle.Success)
  ),
];

module.exports = { ctx, handle, open, openReplaceFor, planButtons, states };
