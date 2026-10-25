// ================== PLANNING MODIFIABLE DEPUIS DISCORD ==================
// Sous le planning du salon planning : ✏️ Modifier, 🔁 Remplacer, 🔀 Déplacer, ➕ Ajouter, 📋 Préparer le lendemain,
// et un menu par shift pour changer vite les box d'un chatteur (admins, en message éphémère).
// Chaque changement est écrit tout de suite dans le planning de l'app (plan/<date>, comme l'app le fait),
// puis le message du salon se met à jour. L'app reste la vue complète ; Discord sert à saisir vite.
// Une box donnée à quelqu'un est retirée à celui du même shift et de la même modèle qui l'avait.
const { StringSelectMenuBuilder, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const planning = require("./planning");
const { reply, done, showView, row, button, opt, selectMenus, EPHEMERAL } = require("./ui");
const { SLOTS, withEmoji, boxList, boxesS, boxesE, dayLabel } = planning;

// Fourni par index.js : isAdmin(i), refresh(date), notify(payload), coupure({ cid, slot, date }), postPlanning(date)
const ctx = {};
const states = new Map(); // userId -> état du menu en cours (voir open)

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
const platsOf = (d, accts, mid) => (accts || []).filter((k) => k.startsWith(mid + "|")).map((k) => d.cat.platName(k.split("|")[1]));
// md : « **ANNA 🍑** Telegram [1][2] · **AXELLE 🍒** Telegram [4] » ; sinon (menus) « Anna 🍑 Telegram B1·2 · … »
function acctsText(d, accts, boxes, md = true, only) {
  const parts = midsOf(accts)
    .filter((mid) => !only || only.includes(mid))
    .map((mid) => {
      const bx = boxList(boxes?.[mid]);
      return md
        ? [`**${d.mName(mid).toLocaleUpperCase("fr")}**`, platsOf(d, accts, mid).join(" + "), boxesE(bx)].filter(Boolean).join(" ")
        : [d.mName(mid), platsOf(d, accts, mid).join(" + "), boxesS(bx)].filter(Boolean).join(" ");
    });
  return parts.join(" · ") || "aucun compte";
}
const whoMd = (c) => `**${c.name}**`;
const tag = (c) => (c.discordId ? `<@${c.discordId}>` : `**${c.name}**`);
const habitTxt = (d, c) => {
  const l = appSync.habSlots(c.shift).map(slotOf);
  return l.length ? `Habituellement ${l.map((s) => s.l).join(" + ")} · ${acctsText(d, c.shift.accts, null, false)}` : "";
};
const chatterOpts = (d, { except = [] } = {}) =>
  Object.values(d.byId)
    .filter((c) => c.active && !except.includes(c.id))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"))
    .map((c) => opt(c.name, c.id, d.off.has(c.id) ? "En day off ce jour-là" : habitTxt(d, c), d.off.has(c.id) ? "🏖️" : slotOf(appSync.habSlots(c.shift)[0]).emoji || undefined));
const entryOpts = (d, list = d.plan) =>
  list.map((s) => opt(`${d.byId[s.chatterId].name} · ${slotOf(s.slot).l}${d.off.has(s.chatterId) ? " (day off)" : ""}`, s.sid, acctsText(d, s.accts, s.boxes, false), slotOf(s.slot).emoji || undefined));
const slotMenu = (id, cur, placeholder = "Shift") =>
  row(
    new StringSelectMenuBuilder()
      .setCustomId(id)
      .setPlaceholder(placeholder)
      .addOptions(SLOTS.map((s) => opt(`${s.l} (${s.h})`, s.k, null, s.emoji, s.k === cur)))
  );
const boxMenu = (id, d, mid, cur, placeholder) =>
  new StringSelectMenuBuilder()
    .setCustomId(id)
    .setPlaceholder(String(placeholder || `Box sur ${d.mName(mid)}`).slice(0, 150))
    .setMinValues(0)
    .setMaxValues(BOX_OPTS.length)
    .addOptions(BOX_OPTS.map(([v, l]) => opt(`${l} · ${d.mName(mid)}`, v, null, null, cur.includes(v))));
// un menu vide n'est pas permis par Discord : un choix grisé à la place
const emptyMenu = (id, placeholder) =>
  new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setDisabled(true).addOptions(opt("—", "none"));
const navRow = () => row(button("pe_day_-1", "Jour d'avant", "◀️", ButtonStyle.Secondary), button("pe_day_1", "Jour d'après", "▶️", ButtonStyle.Secondary));
const backBtn = () => button("pe_back", "Retour", "↩️", ButtonStyle.Secondary);
const head = (st, lines) => [st.note, ...lines].filter(Boolean).join("\n");
// Lignes affichées : tout le jour, ou seulement le shift du message de début de shift
const shown = (st, d) => (st.only ? d.plan.filter((s) => s.slot === st.only) : d.plan);
// All Inbox seul, ou des box numérotées (celle choisie en dernier gagne)
const cleanBoxes = (values, before) => {
  const l = boxList(values);
  return l.includes("all") && l.length > 1 ? (before.includes("all") ? l.filter((x) => x !== "all") : ["all"]) : l;
};

// Shift travaillé dans Remplacer / Déplacer : celui choisi, sinon celui en cours si c'est ce jour-là, sinon le premier rempli
function workSlot(st, d) {
  const filled = SLOTS.filter((s) => d.plan.some((e) => e.slot === s.k)).map((s) => s.k);
  if (st.slot && (filled.includes(st.slot) || !filled.length)) return st.slot;
  if (st.only && filled.includes(st.only)) return st.only;
  const now = Date.now();
  const cur = SLOTS.find((s) => {
    const start = appSync.parisMs(st.date, appSync.START_OF[s.k]);
    return now >= start - 2 * 3600e3 && now < start + 6 * 3600e3;
  });
  return (cur && filled.includes(cur.k) ? cur.k : filled[0]) || "soir";
}
const slotCycle = (st, d) => {
  const filled = SLOTS.filter((s) => d.plan.some((e) => e.slot === s.k));
  const cur = slotOf(workSlot(st, d));
  return button("pe_sl", `Shift : ${cur.l}`, cur.emoji || null, ButtonStyle.Secondary, filled.length < 2);
};
const running = (date, slot) => {
  const start = appSync.parisMs(date, appSync.START_OF[slot]);
  return Date.now() >= start - 2 * 3600e3 && Date.now() < start + 6 * 3600e3;
};

// ---------- Box : celui qui reçoit une box la prend à celui qui l'avait (même shift, même modèle) ----------
function addPatch(patch, sid, v) {
  if (v === null || patch[sid] === null) return void (patch[sid] = v === null ? null : patch[sid]);
  const cur = patch[sid] || {};
  patch[sid] = { ...cur, ...v, ...(v.boxes || cur.boxes ? { boxes: { ...(cur.boxes || {}), ...(v.boxes || {}) } } : {}) };
}
function takeBoxes(d, slot, mid, l, except, patch) {
  const nums = l.filter((b) => b !== "all");
  const taken = [];
  if (!nums.length) return taken;
  for (const s of d.plan) {
    if (s.slot !== slot || except.includes(s.sid) || !midsOf(s.accts).includes(mid) || patch[s.sid] === null) continue;
    const cur = boxList(patch[s.sid]?.boxes?.[mid] !== undefined ? patch[s.sid].boxes[mid] : s.boxes?.[mid]);
    const lost = cur.filter((b) => nums.includes(b));
    if (!lost.length) continue;
    const left = cur.filter((b) => !nums.includes(b));
    addPatch(patch, s.sid, { boxes: { [mid]: left.length ? left : null } });
    taken.push(`${boxesS(lost).replace(/^B/, "box ")} retirée${lost.length > 1 ? "s" : ""} à ${d.byId[s.chatterId].name}`);
  }
  return taken;
}
async function setBoxes(st, d, e, mid, values) {
  const l = cleanBoxes(values, boxList(e.boxes?.[mid]));
  const patch = {};
  const taken = takeBoxes(d, e.slot, mid, l, [e.sid], patch);
  addPatch(patch, e.sid, { boxes: { [mid]: l.length ? l : null } });
  await save(st, patch);
  return `✅ Box de ${whoMd(d.byId[e.chatterId])} sur ${d.mName(mid)} : **${l.length ? boxesS(l) : "aucune"}**.${taken.length ? ` ↪️ ${cap(taken.join(", "))}.` : ""}`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Que deviennent les box d'un chatteur qui part sur une autre modèle : il les garde (renfort), elles restent
// libres, ou elles vont à un autre chatteur du même shift sur cette modèle
function fateOpts(d, slot, who, mids, exclude) {
  const names = mids.map(d.mName).join(", ");
  const bx = mids.map((m) => boxesS(boxList(who.boxes?.[m]))).filter(Boolean).join(" · ");
  const others = d.plan.filter((s) => s.slot === slot && !exclude.includes(s.chatterId) && midsOf(s.accts).some((m) => mids.includes(m)));
  return [
    opt(`Il garde aussi ${names} (renfort sur les deux)`, "keep", null, "➕"),
    opt(`Il quitte ${names}${bx ? ` : ${bx} libres` : ""}`, "free", null, "🚪"),
    ...others.slice(0, 23).map((s) => opt(`Il quitte ${names} : ${bx || "ses box"} → ${d.byId[s.chatterId].name}`, `give:${s.sid}`, acctsText(d, s.accts, s.boxes, false), "🎁")),
  ];
}
// Applique ce choix sur l'entrée `who` (qui quitte les modèles `mids`) ; renvoie le texte du message clocking
function applyFate(d, fate, who, mids, patch) {
  if (!mids.length || !fate || fate === "keep") return mids.length ? ` · garde aussi ${mids.map((m) => `**${d.mName(m)}**`).join(", ")}` : "";
  const given = fate.startsWith("give:") && d.plan.find((s) => s.sid === fate.slice(5));
  const lines = [];
  for (const mid of mids) {
    const l = boxList(who.boxes?.[mid]);
    addPatch(patch, who.sid, { boxes: { [mid]: null } });
    if (given && midsOf(given.accts).includes(mid) && l.length) {
      const cur = boxList(patch[given.sid]?.boxes?.[mid] !== undefined ? patch[given.sid].boxes[mid] : given.boxes?.[mid]);
      addPatch(patch, given.sid, { boxes: { [mid]: boxList([...cur.filter((b) => b !== "all"), ...l]) } });
      lines.push(`ses box **${d.mName(mid)}** ${boxesE(l)} → ${tag(d.byId[given.chatterId])}`);
    } else lines.push(`quitte **${d.mName(mid)}**${l.length ? ` (${boxesE(l)} libres)` : ""}`);
  }
  return ` · ${lines.join(" · ")}`;
}

// Même texte pour le message éphémère : le prénom à la place de la mention
const noPing = (d, txt) =>
  String(txt || "").replace(/<@([^>]+)>/g, (m, id) => {
    const c = Object.values(d.byId).find((x) => x.discordId === id);
    return c ? whoMd(c) : m;
  });

// ---------- Vues ----------
const VIEWS = {
  // Liste des chatteurs du jour
  async list(st) {
    const d = await load(st.date);
    const list = shown(st, d);
    const only = st.only && slotOf(st.only);
    const n = new Set(list.filter((s) => !d.off.has(s.chatterId)).map((s) => s.chatterId)).size;
    return {
      content: head(st, [
        `✏️ **Planning du ${dayLabel(st.date)}**${only ? ` · ${only.emoji} ${only.l}` : ""}${list.length ? ` · ${n} chatteur${n > 1 ? "s" : ""}` : ""}`,
        list.length
          ? "Choisis un chatteur pour changer son shift, ses comptes ou ses box."
          : "_Personne au planning ce jour-là : 📋 copie un autre jour, ou ajoute quelqu'un avec ➕._",
      ]),
      components: [
        ...selectMenus("pe_pick", entryOpts(d, list), { placeholder: "Chatteur à modifier", max: 2 }),
        row(
          button("pe_add", "Ajouter", "➕", ButtonStyle.Success),
          button("pe_rep", "Remplacer", "🔁", ButtonStyle.Secondary, !list.length),
          button("pe_mv", "Déplacer", "🔀", ButtonStyle.Secondary, !list.length),
          button("pe_copy", "Copier un jour", "📋", ButtonStyle.Secondary),
          button("pe_send", "Envoyer", "📣", ButtonStyle.Primary, !d.plan.length)
        ),
        navRow(),
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
    if (st.bm) comps.push(row(boxMenu("pe_box", d, st.bm, boxList(e.boxes?.[st.bm]))));
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
  // Box d'un chatteur, tout de suite (menu sous le planning du salon) : un menu par modèle
  async qb(st) {
    const d = await load(st.date);
    const e = d.plan.find((s) => s.sid === st.sid);
    if (!e) return VIEWS.list({ ...st, note: "⚠️ Cette ligne n'est plus au planning (changée dans l'app ?)." });
    const mids = midsOf(e.accts).slice(0, 3);
    const sl = slotOf(e.slot);
    return {
      content: head(st, [
        `📦 **Box de ${d.byId[e.chatterId].name}** · ${sl.emoji} ${sl.l} · ${dayLabel(st.date)}`,
        acctsText(d, e.accts, e.boxes),
        mids.length ? "-# Une box donnée ici est retirée à celui du même shift qui l'avait." : "_Aucun compte : ✏️ pour en mettre._",
      ]),
      components: [
        ...mids.map((mid, k) => row(boxMenu(`pe_qbx_${k}`, d, mid, boxList(e.boxes?.[mid])))),
        row(button("pe_pick_qb", "Tout modifier", "✏️", ButtonStyle.Secondary), button("pe_x", "Fermer", null, ButtonStyle.Secondary)),
      ],
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
  // Remplacer : qui part, qui le remplace (il reprend ses comptes et ses box), et ce que deviennent les box
  // du remplaçant s'il était déjà sur une autre modèle de ce shift
  async rep(st) {
    const d = await load(st.date);
    const slot = workSlot(st, d);
    const sl = slotOf(slot);
    const here = d.plan.filter((s) => s.slot === slot);
    const e = st.out && here.find((s) => s.sid === st.out);
    const r = st.inn && d.byId[st.inn];
    const target = r && here.find((s) => s.chatterId === r.id);
    const leaving = target && e ? midsOf(target.accts).filter((m) => !midsOf(e.accts).includes(m)) : [];
    // remplaçants : ceux du même shift d'abord, puis les libres ce jour-là, puis ceux prévus sur un autre shift
    const rank = (c) => (here.some((s) => s.chatterId === c.id) ? 0 : d.plan.some((s) => s.chatterId === c.id) ? 2 : 1);
    const cands = Object.values(d.byId)
      .filter((c) => c.active && !d.off.has(c.id) && c.id !== e?.chatterId)
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "fr"))
      .slice(0, 25)
      .map((c) => {
        const mine = here.find((s) => s.chatterId === c.id);
        const other = !mine && d.plan.find((s) => s.chatterId === c.id);
        return opt(c.name, c.id, mine ? `Sur ce shift · ${acctsText(d, mine.accts, mine.boxes, false)}` : other ? `Prévu en ${slotOf(other.slot).l}` : "Libre ce jour-là", mine ? sl.emoji : other ? slotOf(other.slot).emoji : "🟢", c.id === st.inn);
      });
    if (!leaving.length) st.fate = "keep";
    return {
      content: head(st, [
        `🔁 **Remplacer un chatteur** · ${sl.emoji} ${sl.l} · ${dayLabel(st.date)}`,
        "Le remplaçant reprend ses comptes et ses box. Celui qui part reste au planning, sans box.",
        e ? `Part : ${whoMd(d.byId[e.chatterId])} · ${acctsText(d, e.accts, e.boxes)}` : "",
        r ? `Le remplace : ${whoMd(r)}${target ? ` (déjà sur ${acctsText(d, target.accts, target.boxes)})` : ""}` : "",
        leaving.length ? `⚠️ Que deviennent ses box sur ${leaving.map(d.mName).join(", ")} ? (menu du bas)` : "",
      ]),
      components: [
        row(here.length ? new StringSelectMenuBuilder().setCustomId("pe_ro").setPlaceholder("Qui part ?").addOptions(entryOpts(d, here.slice(0, 25)).map((o) => ({ ...o, default: o.value === st.out }))) : emptyMenu("pe_ro", "Personne sur ce shift")),
        row(cands.length ? new StringSelectMenuBuilder().setCustomId("pe_ri").setPlaceholder("Qui le remplace ?").addOptions(cands) : emptyMenu("pe_ri", "Personne de libre")),
        ...(leaving.length
          ? [row(new StringSelectMenuBuilder().setCustomId("pe_rf").setPlaceholder("Ses autres box").addOptions(fateOpts(d, slot, target, leaving, [r.id, e.chatterId]).map((o) => ({ ...o, default: o.value === (st.fate || "keep") }))))]
          : []),
        row(
          slotCycle(st, d),
          button("pe_cut", st.cut ? "Coupure : oui" : "Coupure : non", "✂️", st.cut ? ButtonStyle.Primary : ButtonStyle.Secondary),
          button("pe_repok", "Remplacer", "🔁", ButtonStyle.Success, !(e && r)),
          backBtn()
        ),
      ],
    };
  },
  // Déplacer : un chatteur va sur une autre modèle (renfort, ou à la place de quelqu'un) avec ses box
  async mv(st) {
    const d = await load(st.date);
    const slot = workSlot(st, d);
    const sl = slotOf(slot);
    const here = d.plan.filter((s) => s.slot === slot);
    const e = st.mvSid && here.find((s) => s.sid === st.mvSid);
    const tk = st.mvAcc;
    const tm = tk && tk.split("|")[0];
    const others = e && tm ? midsOf(e.accts).filter((m) => m !== tm) : [];
    if (!others.length) st.fate = "keep";
    const holders = tm ? here.filter((s) => s.sid !== e?.sid && midsOf(s.accts).includes(tm)) : [];
    const accts = d.cat.accounts.slice(0, 25);
    return {
      content: head(st, [
        `🔀 **Déplacer un chatteur** · ${sl.emoji} ${sl.l} · ${dayLabel(st.date)}`,
        "Envoie un chatteur sur une autre modèle (renfort, ou à la place de quelqu'un) et choisis ses box : elles sont retirées à celui qui les avait.",
        e ? `Chatteur : ${whoMd(d.byId[e.chatterId])} · ${acctsText(d, e.accts, e.boxes)}` : "",
        tk ? `Vers : **${d.mName(tm).toLocaleUpperCase("fr")}** ${d.cat.platName(tk.split("|")[1])}${st.mvBoxes?.length ? ` · ${boxesE(boxList(st.mvBoxes))}` : ""}${holders.length ? `\n-# Déjà dessus : ${holders.map((s) => `${d.byId[s.chatterId].name} ${boxesS(boxList(s.boxes?.[tm]))}`.trim()).join(", ")}` : ""}` : "",
      ]),
      components: [
        row(here.length ? new StringSelectMenuBuilder().setCustomId("pe_mw").setPlaceholder("Qui ?").addOptions(entryOpts(d, here.slice(0, 25)).map((o) => ({ ...o, default: o.value === st.mvSid }))) : emptyMenu("pe_mw", "Personne sur ce shift")),
        row(new StringSelectMenuBuilder().setCustomId("pe_mt").setPlaceholder("Vers quelle modèle ?").addOptions(accts.map((a) => opt(`${withEmoji(a.model)} · ${a.platform}`, a.key, null, null, a.key === tk)))),
        row(tm ? boxMenu("pe_mb", d, tm, boxList(st.mvBoxes), `Ses box sur ${d.mName(tm)}`) : emptyMenu("pe_mb", "Ses box (choisis d'abord la modèle)")),
        ...(others.length
          ? [row(new StringSelectMenuBuilder().setCustomId("pe_mf").setPlaceholder("Ses box actuelles").addOptions(fateOpts(d, slot, e, others, [e.chatterId]).map((o) => ({ ...o, default: o.value === (st.fate || "keep") }))))]
          : []),
        row(slotCycle(st, d), button("pe_mvok", "Déplacer", "🔀", ButtonStyle.Success, !(e && tk)), backBtn()),
      ],
    };
  },
  // Copier un autre jour sur ce jour (box comprises), puis on adapte
  async copy(st) {
    const from = appSync.addDays(st.date, -7), to = appSync.addDays(st.date, 7);
    const counts = await appSync.planCounts(from, to);
    st.src ||= appSync.addDays(st.date, -1);
    const days = Array.from({ length: 15 }, (_, k) => appSync.addDays(from, k)).filter((x) => x !== st.date);
    const here = counts[st.date] || 0;
    return {
      content: head(st, [
        `📋 **Préparer le ${dayLabel(st.date)}**`,
        "Choisis le jour à reprendre : tout le monde est copié avec ses comptes et ses box (sauf ceux en day off ce jour-là). Tu adaptes ensuite.",
        `Copier : **${dayLabel(st.src)}** (${counts[st.src] || 0} chatteur${(counts[st.src] || 0) > 1 ? "s" : ""})`,
        here ? (st.add ? `ℹ️ Le ${dayLabel(st.date)} a déjà ${here} chatteur${here > 1 ? "s" : ""} : seuls ceux qui manquent sont ajoutés.` : `⚠️ Le ${dayLabel(st.date)} a déjà ${here} chatteur${here > 1 ? "s" : ""} : son planning est remplacé.`) : "",
      ]),
      components: [
        row(
          new StringSelectMenuBuilder()
            .setCustomId("pe_cs")
            .setPlaceholder("Jour à copier")
            .addOptions(days.map((x) => opt(cap(dayLabel(x)), x, `${counts[x] || 0} chatteur${(counts[x] || 0) > 1 ? "s" : ""}`, "📅", x === st.src)))
        ),
        row(
          button("pe_cok", "Copier", "📋", ButtonStyle.Success, !counts[st.src]),
          button("pe_cm", st.add ? "Ajouter ceux qui manquent" : "Remplacer ce jour", "🔄", ButtonStyle.Secondary, !here),
          backBtn()
        ),
      ],
    };
  },
};
const render = async (i, st, fresh) => showView(i, await VIEWS[st.view](st), fresh);

// ---------- Ouverture (boutons du salon planning, message vocal, panneau gestion) ----------
async function open(i, date, view, extra = {}) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  if (!appSync.enabled()) return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  const st = { date, view, cut: false, fate: "keep", ...extra };
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
      extra = { slot: p.slot, ...(e ? { out: e.sid, cut: true } : {}) };
    }
  }
  return open(i, date, "rep", extra);
}

// ---------- Actions ----------
async function save(st, patch) {
  if (!Object.keys(patch).length) return;
  await appSync.writePlan(st.date, patch);
  ctx.refresh?.(st.date);
}
async function handle(i) {
  const id = i.customId;
  // sous le planning du salon : pl_<vue>_<date>, ou sous le message de début de shift : pl_edit_<date>_<créneau>
  const pub = id.match(/^pl_(edit|rep|add|mv|next)_(\d{4}-\d{2}-\d{2})(?:_([a-z]+))?$/);
  if (pub) {
    const [, act, date, slot] = pub;
    if (act === "next") return open(i, appSync.addDays(date, 1), "copy", { src: date });
    return open(i, date, { edit: "list", rep: "rep", add: "add", mv: "mv" }[act], slot ? { only: slot, slot } : {});
  }
  // menu « box » d'un shift sous le planning : pl_qb_<date>_<créneau>
  const qb = id.match(/^pl_qb_(\d{4}-\d{2}-\d{2})_([a-z]+)$/);
  if (qb) return open(i, qb[1], "qb", { sid: i.values?.[0], slot: qb[2] });
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const st = states.get(i.user.id);
  if (!st) return done(i, "Ce menu a expiré : reclique sur un bouton du planning.", 8000);
  st.note = "";
  const [, act, arg] = id.split("_");
  const v = i.values?.[0];
  if (act === "x") {
    states.delete(i.user.id);
    return done(i, "✅ C'est noté.", 4000);
  }
  await i.deferUpdate();

  if (act === "back") st.view = "list";
  else if (act === "day") {
    st.date = appSync.addDays(st.date, Number(arg) || 0);
    st.view = "list";
  } else if (act === "add") Object.assign(st, { view: "add", cid: null, slot: st.only || null });
  else if (act === "rep") Object.assign(st, { view: "rep", out: null, inn: null, cut: false, fate: "keep" });
  else if (act === "mv") Object.assign(st, { view: "mv", mvSid: null, mvAcc: null, mvBoxes: [], fate: "keep" });
  else if (act === "copy") Object.assign(st, { view: "copy", src: null, add: false });
  else if (act === "pick") Object.assign(st, { view: "edit", sid: arg === "qb" ? st.sid : v, bm: null });
  else if (act === "sl") {
    const d = await load(st.date);
    const filled = SLOTS.filter((s) => d.plan.some((e) => e.slot === s.k)).map((s) => s.k);
    st.slot = filled[(filled.indexOf(workSlot(st, d)) + 1) % filled.length];
    Object.assign(st, { out: null, inn: null, mvSid: null, mvBoxes: [], fate: "keep" });
  } else if (act === "send") {
    const r = await ctx.postPlanning(st.date).catch((e) => ({ error: e.message }));
    st.note = r?.error ? `⚠️ Pas envoyé : ${String(r.error).slice(0, 150)}` : `📣 Planning du ${dayLabel(st.date)} envoyé dans le salon planning (${r.count} chatteur${r.count > 1 ? "s" : ""}).`;
  } else if (act === "bm") {
    const d = await load(st.date);
    const mids = midsOf(d.plan.find((s) => s.sid === st.sid)?.accts);
    st.bm = mids[(mids.indexOf(st.bm) + 1) % mids.length];
  } else if (["slot", "acc", "box", "del", "qbx"].includes(act)) {
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
    } else if (act === "box") st.note = await setBoxes(st, d, e, st.bm, i.values);
    else if (act === "qbx") {
      const mid = midsOf(e.accts)[Number(arg) || 0];
      if (mid) st.note = await setBoxes(st, d, e, mid, i.values);
    } else {
      await save(st, { [e.sid]: null });
      st.view = "list";
      st.note = `🗑️ ${whoMd(d.byId[e.chatterId])} retiré du ${slotOf(e.slot).l}.`;
    }
  } else if (act === "ac") {
    st.cid = v;
    const c = (await appSync.appChatters()).find((x) => x.id === v);
    if (!st.slot) st.slot = appSync.habSlots(c?.shift)[0] || null; // son shift habituel par défaut
  } else if (act === "as") st.slot = v;
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
  } else if (act === "ro") Object.assign(st, { out: v, inn: null, fate: "keep" });
  else if (act === "ri") Object.assign(st, { inn: v, fate: "keep" });
  else if (act === "rf" || act === "mf") st.fate = v;
  else if (act === "cut") st.cut = !st.cut;
  else if (act === "repok") st.note = await replace(st);
  else if (act === "mw") Object.assign(st, { mvSid: v, fate: "keep" });
  else if (act === "mt") {
    const d = await load(st.date);
    const e = d.plan.find((s) => s.sid === st.mvSid);
    st.mvAcc = v;
    st.mvBoxes = e ? boxList(e.boxes?.[v.split("|")[0]]) : [];
  } else if (act === "mb") st.mvBoxes = cleanBoxes(i.values, boxList(st.mvBoxes));
  else if (act === "mvok") st.note = await move(st);
  else if (act === "cs") st.src = v;
  else if (act === "cm") st.add = !st.add;
  else if (act === "cok") {
    const r = await appSync.copyPlan(st.src, st.date, { replace: !st.add });
    ctx.refresh?.(st.date);
    Object.assign(st, {
      view: "list",
      note: `✅ ${r.added} ligne${r.added > 1 ? "s" : ""} copiée${r.added > 1 ? "s" : ""} depuis le ${dayLabel(st.src)}${r.skipped ? ` (${r.skipped} pas reprise${r.skipped > 1 ? "s" : ""} : day off ou inactif)` : ""}. Adapte ici, puis 📣 **Envoyer**.`,
    });
  }
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
  const mids = midsOf(e.accts);
  const boxes = Object.fromEntries(Object.entries(e.boxes || {}).map(([m, v]) => [m, boxList(v)]).filter(([m, v]) => v.length && mids.includes(m)));
  const target = d.plan.find((s) => s.chatterId === r.id && s.slot === e.slot);
  const patch = {};
  let fate = "";
  if (target) {
    const leaving = st.fate && st.fate !== "keep" ? midsOf(target.accts).filter((m) => !mids.includes(m)) : [];
    fate = applyFate(d, st.fate, target, leaving, patch);
    const merged = {};
    for (const [m, v] of Object.entries(boxes)) merged[m] = boxList([...boxList(target.boxes?.[m]), ...v]);
    const accts = [...new Set([...(target.accts || []).filter((k) => !leaving.includes(k.split("|")[0])), ...(e.accts || [])])];
    addPatch(patch, target.sid, { accts, ...(Object.keys(merged).length ? { boxes: merged } : {}) });
  } else addPatch(patch, appSync.newId(), { slot: e.slot, chatterId: r.id, accts: [...(e.accts || [])], ...(Object.keys(boxes).length ? { boxes } : {}) });
  if (Object.keys(e.boxes || {}).length) addPatch(patch, e.sid, { boxes: Object.fromEntries(Object.keys(e.boxes).map((m) => [m, null])) });
  await save(st, patch);
  const sl = slotOf(e.slot);
  const what = acctsText(d, e.accts, e.boxes);
  let cut = "";
  if (st.cut) {
    const res = await ctx.coupure?.({ cid: out.id, slot: e.slot, date: st.date }).catch((err) => ({ error: err.message }));
    cut = res?.error ? ` ⚠️ Coupure pas notée : ${String(res.error).slice(0, 120)}` : " ✂️ Coupure notée au pointage.";
  }
  // prévient les deux dans le salon clocking si le shift est en cours (ou commence bientôt)
  if (running(st.date, e.slot))
    await ctx.notify?.({
      content: `🔁 ${tag(r)} remplace ${tag(out)}${st.cut ? " (✂️ coupure)" : ""} · ${sl.emoji} ${sl.l} · ${what}${fate}`,
      allowedMentions: { users: [r.discordId, out.discordId].filter(Boolean) },
    }).catch((err) => console.error("Remplacement (salon clocking) :", err.message));
  Object.assign(st, { out: null, inn: null, cut: false, fate: "keep" });
  return `✅ ${whoMd(r)} reprend ${what} de ${whoMd(out)} sur ${sl.emoji} ${sl.l}${noPing(d, fate)}.${cut}`;
}

// Déplacer : il prend le compte choisi et ses box (retirées à ceux qui les avaient) ; ses autres modèles
// selon le choix (il les garde, il les quitte, ou il passe ses box à un autre)
async function move(st) {
  const d = await load(st.date);
  const e = d.plan.find((s) => s.sid === st.mvSid);
  if (!e || !st.mvAcc) return "Choisis le chatteur et la modèle.";
  const tk = st.mvAcc;
  const tm = tk.split("|")[0];
  const l = boxList(st.mvBoxes);
  const others = midsOf(e.accts).filter((m) => m !== tm);
  const leaving = st.fate && st.fate !== "keep" ? others : [];
  const patch = {};
  const fate = applyFate(d, st.fate, e, leaving, patch);
  const taken = takeBoxes(d, e.slot, tm, l, [e.sid], patch);
  const accts = [...new Set([...(e.accts || []).filter((k) => !leaving.includes(k.split("|")[0])), tk])];
  addPatch(patch, e.sid, { accts, boxes: { [tm]: l.length ? l : null } });
  await save(st, patch);
  const c = d.byId[e.chatterId];
  const sl = slotOf(e.slot);
  const dest = `**${d.mName(tm).toLocaleUpperCase("fr")}** ${d.cat.platName(tk.split("|")[1])}${l.length ? ` ${boxesE(l)}` : ""}`;
  if (running(st.date, e.slot))
    await ctx.notify?.({
      content: `🔀 ${tag(c)} passe sur ${dest} · ${sl.emoji} ${sl.l}${fate}`,
      allowedMentions: { users: [c.discordId].filter(Boolean) },
    }).catch((err) => console.error("Déplacement (salon clocking) :", err.message));
  Object.assign(st, { mvSid: null, mvAcc: null, mvBoxes: [], fate: "keep" });
  return `✅ ${whoMd(c)} passe sur ${d.mName(tm)}${l.length ? ` (${boxesS(l)})` : ""}${noPing(d, fate)}.${taken.length ? ` ↪️ ${cap(taken.join(", "))}.` : ""}`;
}

// Sous le planning du salon : les boutons, puis un menu par shift pour changer vite les box d'un chatteur
function planComponents(date, day) {
  const rows = [
    row(
      button(`pl_edit_${date}`, "Modifier", "✏️", ButtonStyle.Primary),
      button(`pl_rep_${date}`, "Remplacer", "🔁", ButtonStyle.Secondary),
      button(`pl_mv_${date}`, "Déplacer", "🔀", ButtonStyle.Secondary),
      button(`pl_add_${date}`, "Ajouter", "➕", ButtonStyle.Success),
      button(`pl_next_${date}`, "Préparer le lendemain", "📋", ButtonStyle.Secondary)
    ),
  ];
  if (!day) return rows;
  const byId = Object.fromEntries(day.chatters.map((c) => [c.id, c]));
  const mName = (mid) => withEmoji(day.models[mid]?.name || mid);
  for (const sl of SLOTS) {
    const list = day.plan.filter((s) => s.slot === sl.k && byId[s.chatterId]).sort((a, b) => byId[a.chatterId].name.localeCompare(byId[b.chatterId].name, "fr"));
    if (!list.length) continue;
    rows.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(`pl_qb_${date}_${sl.k}`)
          .setPlaceholder(`📦 Box ${sl.l} : choisis un chatteur (admins)`)
          .addOptions(
            list.slice(0, 25).map((s) =>
              opt(byId[s.chatterId].name, s.sid, midsOf(s.accts).map((m) => [mName(m), boxesS(boxList(s.boxes?.[m]))].filter(Boolean).join(" ")).join(" · ") || "Aucun compte", sl.emoji)
            )
          )
      )
    );
  }
  return rows.slice(0, 5);
}

module.exports = { ctx, handle, open, openReplaceFor, planComponents, states, takeBoxes, addPatch };
