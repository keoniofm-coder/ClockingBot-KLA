// ================== PLANNING MODIFIABLE DEPUIS DISCORD ==================
// Sous le planning du salon planning : ✏️ Modifier, 🔁 Remplacer, 🔀 Déplacer, ➕ Ajouter, 📋 Préparer le lendemain,
// et un menu par shift pour changer vite les box d'un chatteur (admins, en message éphémère).
// ✏️ Modifier ouvre un shift sur un seul écran : le shift se choisit dans un menu déroulant, on choisit un chatteur
// et ses box changent dès qu'on les coche ; remplacer, déplacer, ajouter partent de là et y reviennent.
// Chaque changement est écrit tout de suite dans le planning de l'app (plan/<date>, comme l'app le fait),
// puis le message du salon se met à jour. L'app reste la vue complète ; Discord sert à saisir vite.
// Une box donnée à quelqu'un est retirée à celui du même shift et de la même modèle qui l'avait.
const { StringSelectMenuBuilder, TextDisplayBuilder, MessageFlags, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const planning = require("./planning");
const { reply, done, showView, row, button, opt, selectMenus, EPHEMERAL } = require("./ui");
const { SLOTS, withEmoji, boxList, boxesS, boxesE, boxLabel, dayLabel } = planning;
const { pickRow, altButton, picked } = require("./pick");

// Fourni par index.js : isAdmin(i), refresh(date), notify(payload), coupure({ cid, slot, date }), postPlanning(date),
// presence(date, slot) : { chatterId: present | retard | coupure | absent | todo | off } d'après le pointage
const ctx = {};
const states = new Map(); // userId -> état du menu en cours (voir open)

const slotOf = (k) => SLOTS.find((s) => s.k === k) || { k, l: k, emoji: "", h: "" };
const BOX_OPTS = [["all", "All Inbox"], ...Array.from({ length: 15 }, (_, k) => [String(k + 1), `Box ${k + 1}`])];

// Tout ce qu'il faut pour un jour : planning, chatteurs, comptes de l'app, day off
async function loadNow(date) {
  const [day, cat] = await Promise.all([appSync.planningDay(date), appSync.appCatalog()]);
  const byId = Object.fromEntries(day.chatters.map((c) => [c.id, c]));
  const plan = day.plan
    .filter((s) => byId[s.chatterId])
    .sort((a, b) => SLOTS.findIndex((x) => x.k === a.slot) - SLOTS.findIndex((x) => x.k === b.slot) || byId[a.chatterId].name.localeCompare(byId[b.chatterId].name, "fr"));
  const mName = (mid) => withEmoji(cat.models[mid]?.name || mid);
  return { ...day, plan, byId, cat, off: new Set(day.offs), mName };
}
// Un jour n'est lu qu'une fois par clic (l'action puis l'affichage) ; oublié dès qu'on écrit
let memo = new Map();
function load(date) {
  if (!memo.has(date)) memo.set(date, loadNow(date).catch((e) => (memo.delete(date), Promise.reject(e))));
  return memo.get(date);
}
const midsOf = (accts) => [...new Set((accts || []).map((k) => k.split("|")[0]).filter(Boolean))];
const platsOf = (d, accts, mid) => (accts || []).filter((k) => k.startsWith(mid + "|")).map((k) => d.cat.platName(k.split("|")[1]));
// md : « **ANNA 🍑** Telegram · Box : 1️⃣ & 2️⃣ · **AXELLE 🍒** Telegram · Box : 4️⃣ » ; sinon (menus) « Anna 🍑 Telegram B1·2 · … »
function acctsText(d, accts, boxes, md = true, only) {
  const parts = midsOf(accts)
    .filter((mid) => !only || only.includes(mid))
    .map((mid) => {
      const bx = boxList(boxes?.[mid]);
      return md
        ? [`**${d.mName(mid).toLocaleUpperCase("fr")}**`, platsOf(d, accts, mid).join(" + ")].filter(Boolean).join(" ") + (bx.length ? ` · ${boxLabel(bx)}` : "")
        : [d.mName(mid), platsOf(d, accts, mid).join(" + "), boxesS(bx)].filter(Boolean).join(" ");
    });
  return parts.join(" · ") || "aucun compte";
}
const whoMd = (c) => `**${c.name}**`;
const tag = (c) => (c.discordId ? `<@${c.discordId}>` : `**${c.name}**`);
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
const backBtn = () => button("pe_back", "Retour", "↩️", ButtonStyle.Secondary);
const closeBtn = () => button("pe_x", "Fermer", null, ButtonStyle.Secondary);
const head = (st, lines) => [st.note, ...lines].filter(Boolean).join("\n");
// Box en toutes lettres dans les menus (les emojis de box n'y passent pas) : « Box 2 & 3 », « All Inbox »
const boxesT = (l) => (!l.length ? "" : l.includes("all") ? "All Inbox" : `Box ${l.join(" & ")}`);
const plS = (n) => (n > 1 ? "s" : "");
// 2000 caractères au plus par message : sur un gros shift, les emojis de box (longs) passent en chiffres
const fitMsg = (txt) => {
  if (txt.length <= 2000) return txt;
  const short = txt.replace(/<a?:klbox\d+_(\w+):\d+>/g, (m, k) => (k === "all" ? "All" : k));
  return short.length <= 2000 ? short : short.slice(0, 1990) + "\n…";
};
// All Inbox seul, ou des box numérotées (celle choisie en dernier gagne)
const cleanBoxes = (values, before) => {
  const l = boxList(values);
  return l.includes("all") && l.length > 1 ? (before.includes("all") ? l.filter((x) => x !== "all") : ["all"]) : l;
};

// Shift affiché : celui choisi, sinon celui en cours si c'est ce jour-là, sinon le premier rempli
function workSlot(st, d) {
  if (st.slot) return st.slot;
  const filled = SLOTS.filter((s) => d.plan.some((e) => e.slot === s.k)).map((s) => s.k);
  const cur = SLOTS.find((s) => running(st.date, s.k));
  return (cur && filled.includes(cur.k) ? cur.k : filled[0]) || "soir";
}
const startOf = (date, slot) => appSync.parisMs(date, appSync.START_OF[slot]);
// shift en cours, ou qui commence dans les 2 h (on prévient alors le salon clocking)
const running = (date, slot) => Date.now() >= startOf(date, slot) - 2 * 3600e3 && Date.now() < startOf(date, slot) + 6 * 3600e3;
const isNow = (date, slot) => Date.now() >= startOf(date, slot) && Date.now() < startOf(date, slot) + 6 * 3600e3;
// « sam. 24 oct. »
const shortDay = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
// Nombre de chatteurs par shift autour du jour affiché (une seule lecture), pour le menu des shifts
const nearCounts = (date) => appSync.slotCounts(appSync.addDays(date, -2), appSync.addDays(date, 6)).catch(() => ({}));
// Menu déroulant des shifts, dans l'ordre des heures : la veille, le jour même et le lendemain (depuis le salon
// gestion, seulement ceux pas encore finis) ; jumps : d'autres jours pour y aller directement, même shift
function shiftRow(st, counts, { jumps = false, id = "pe_ss" } = {}) {
  const now = Date.now();
  const shifts = [-1, 0, 1]
    .flatMap((k) => SLOTS.map((s) => ({ date: appSync.addDays(st.date, k), slot: s.k })))
    .map((x) => ({ ...x, t: startOf(x.date, x.slot) }))
    .filter((x) => !st.live || x.t + 6 * 3600e3 > now || (x.date === st.date && x.slot === st.slot));
  const nOf = (n) => (n ? `${n} chatteur${plS(n)}` : "personne");
  const items = [
    ...shifts.map((x) => {
      const sl = slotOf(x.slot);
      return { t: x.t, o: opt(`${sl.l} · ${shortDay(x.date)}`, `${x.date}|${x.slot}`, [sl.h, nOf(counts[x.date]?.[x.slot] || 0), isNow(x.date, x.slot) ? "en cours" : ""].filter(Boolean).join(" · "), sl.emoji, x.date === st.date && x.slot === st.slot) };
    }),
    ...(jumps ? [-2, 2, 3, 4, 5, 6] : []).map((k) => {
      const x = appSync.addDays(st.date, k);
      return { t: appSync.parisMs(x, 0), o: opt(cap(dayLabel(x)), `d|${x}`, `${nOf(counts[x]?.all || 0)} · ouvre ce jour`, "📅") };
    }),
  ].sort((a, b) => a.t - b.t);
  return row(new StringSelectMenuBuilder().setCustomId(id).setPlaceholder("Choisir le shift").addOptions(items.slice(0, 25).map((x) => x.o)));
}
// Statut au pointage de chacun, une fois le shift commencé
const presenceOf = (date, slot) =>
  Date.now() >= startOf(date, slot) ? Promise.resolve(ctx.presence?.(date, slot)).then((p) => p || {}, () => ({})) : Promise.resolve({});

// Statut au pointage, pour choisir qui prend des box
const PRES = {
  present: { e: "🟢", l: "là" }, retard: { e: "🟠", l: "en retard" }, coupure: { e: "🔵", l: "en coupure" },
  absent: { e: "🔴", l: "absent" }, todo: { e: "⚪", l: "pas encore là" }, off: { e: "🏖️", l: "day off" },
};
// Box 1 à n réparties sur les chatteurs choisis, dans l'ordre de leurs box actuelles : une chacun, celles en plus
// aux premiers ; s'il y a moins de box que de chatteurs, les derniers n'en ont pas
function splitBoxes(list, n, mid) {
  const rank = (s) => {
    const l = boxList(s.boxes?.[mid]).filter((b) => b !== "all").map(Number);
    return l.length ? Math.min(...l) : 99;
  };
  const order = [...list].sort((a, b) => rank(a) - rank(b));
  let next = 1;
  return order.map((s, i) => ({ s, l: Array.from({ length: Math.floor(n / order.length) + (i < n % order.length ? 1 : 0) }, () => String(next++)) }));
}
// Applique la répartition : les autres chatteurs de cette modèle sur ce shift n'ont plus de box
async function boxSplit(st) {
  const d = await load(st.date);
  const slot = st.slot, mid = st.nbm, sl = slotOf(slot);
  const on = d.plan.filter((s) => s.slot === slot && midsOf(s.accts).includes(mid));
  const chosen = on.filter((s) => (st.nbw || []).includes(s.sid));
  if (!mid || !chosen.length) return "Choisis la modèle et qui prend des box.";
  const got = splitBoxes(chosen, st.nbn, mid).filter((p) => p.l.length);
  const patch = {};
  for (const s of on) {
    const p = got.find((x) => x.s.sid === s.sid);
    // box gardées pour un retour de coupure sur cette modèle : la nouvelle répartition les remplace
    const held = Array.isArray(s.held) ? s.held.filter((h) => h && h.m !== mid) : null;
    addPatch(patch, s.sid, { boxes: { [mid]: p ? p.l : null }, ...(held && held.length !== s.held.length ? { held: held.length ? held : null } : {}) });
  }
  await save(st, patch);
  await appSync.setBoxCount(st.date, slot, mid, st.nbn).catch((e) => console.error("Nombre de box :", e.message));
  const live = running(st.date, slot);
  if (live)
    await ctx.notify?.({
      content: [`📦 **${d.mName(mid).toLocaleUpperCase("fr")}** passe à ${st.nbn} box · ${sl.emoji} ${sl.l}`, ...got.map((p) => `${tag(d.byId[p.s.chatterId])} · ${boxLabel(p.l)}`)].join("\n"),
      allowedMentions: { users: got.map((p) => d.byId[p.s.chatterId].discordId).filter(Boolean) },
    }).catch((e) => console.error("Box du shift (salon clocking) :", e.message));
  return `✅ **${d.mName(mid)}** : ${st.nbn} box sur ${got.length} chatteur${got.length > 1 ? "s" : ""}.${live ? " Prévenus dans le salon clocking." : ""}`;
}

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
    taken.push(`${boxLabel(lost)} retirée${lost.length > 1 ? "s" : ""} à ${d.byId[s.chatterId].name}`);
  }
  return taken;
}
async function setBoxes(st, d, e, mid, values) {
  const l = cleanBoxes(values, boxList(e.boxes?.[mid]));
  const patch = {};
  const taken = takeBoxes(d, e.slot, mid, l, [e.sid], patch);
  // ses box réglées à la main : plus rien à lui rendre au retour de coupure
  addPatch(patch, e.sid, { boxes: { [mid]: l.length ? l : null }, ...(e.held ? { held: null } : {}) });
  await save(st, patch);
  return `✅ Box de ${whoMd(d.byId[e.chatterId])} sur ${d.mName(mid)} : ${l.length ? boxesE(l) : "**aucune**"}.${taken.length ? ` ↪️ ${cap(taken.join(", "))}.` : ""}`;
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
      lines.push(`ses ${boxLabel(l)} sur **${d.mName(mid)}** → ${tag(d.byId[given.chatterId])}`);
    } else lines.push(`quitte **${d.mName(mid)}**${l.length ? ` (${boxLabel(l)} libre${l.length > 1 ? "s" : ""})` : ""}`);
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
  // Un shift sur un seul écran : chaque modèle avec ses chatteurs et leurs box ; on choisit un chatteur
  // dans le menu et ses box changent dès qu'on les coche (retirées à celui du shift qui les avait)
  async sh(st) {
    if (st.live && !st.slot) Object.assign(st, shiftChoices(st)[0] || {});
    const early = st.slot ? presenceOf(st.date, st.slot) : null;
    const [d, counts] = await Promise.all([load(st.date), nearCounts(st.date)]);
    st.slot = workSlot(st, d);
    const pres = await (early || presenceOf(st.date, st.slot));
    const slot = st.slot, sl = slotOf(slot);
    const here = d.plan.filter((s) => s.slot === slot);
    const started = Date.now() >= startOf(st.date, slot);
    const stOf = (s) => (d.off.has(s.chatterId) ? "off" : started ? pres[s.chatterId] || "todo" : "");
    const name = (s) => d.byId[s.chatterId].name;
    // chatteur choisi et la modèle dont on règle les box
    const [selSid, selMid] = String(st.sel || "").split("|");
    const sel = here.find((s) => s.sid === selSid);
    const bm = sel ? (midsOf(sel.accts).includes(selMid) ? selMid : midsOf(sel.accts)[0] || "") : "";
    st.sel = sel ? `${sel.sid}|${bm}` : null;
    const mids = [...new Set(here.flatMap((s) => midsOf(s.accts)))].sort((a, b) => d.mName(a).localeCompare(d.mName(b), "fr"));
    const rank = (s, mid) => {
      const l = boxList(s.boxes?.[mid]);
      return l.length ? (l[0] === "all" ? 0 : Number(l[0])) : 99;
    };
    const line = (s, mid, multi) => {
      const k = stOf(s), l = mid ? boxList(s.boxes?.[mid]) : [];
      const who = sel?.sid === s.sid && bm === mid ? `👉 **${name(s)}**` : name(s);
      const plats = multi ? ` ${platsOf(d, s.accts, mid).join(" + ")}` : "";
      return [`${k ? `${PRES[k]?.e || "⚪"} ` : ""}${who}${plats}`, mid ? (l.length ? boxLabel(l) : "sans box") : "aucun compte", ["retard", "coupure", "absent", "off"].includes(k) ? PRES[k].l : ""].filter(Boolean).join(" · ");
    };
    const blocks = mids.map((mid) => {
      const on = here.filter((s) => midsOf(s.accts).includes(mid)).sort((a, b) => rank(a, mid) - rank(b, mid) || name(a).localeCompare(name(b), "fr"));
      const plats = [...new Set(on.flatMap((s) => platsOf(d, s.accts, mid)))];
      const n = Number(d.nbox?.[`${slot}|${mid}`]) || 0;
      const used = new Set(on.flatMap((s) => boxList(s.boxes?.[mid])));
      const free = n && !used.has("all") ? Array.from({ length: n }, (_, k) => String(k + 1)).filter((b) => !used.has(b)) : [];
      return [
        [`**${d.mName(mid).toLocaleUpperCase("fr")}**`, plats.join(" + "), n ? `${n} box` : ""].filter(Boolean).join(" · "),
        ...on.map((s) => line(s, mid, plats.length > 1)),
        free.length ? `-# Libre${plS(free.length)} : ${boxLabel(free)}` : "",
      ].filter(Boolean).join("\n");
    });
    const bare = here.filter((s) => !midsOf(s.accts).length);
    if (bare.length) blocks.push(["**SANS COMPTE**", ...bare.map((s) => line(s, ""))].join("\n"));
    const n = new Set(here.filter((s) => !d.off.has(s.chatterId)).map((s) => s.chatterId)).size;
    // menu des chatteurs : une ligne par chatteur et par modèle (choisir la ligne = choisir les box de cette modèle)
    const who = here
      .flatMap((s) => (midsOf(s.accts).length ? midsOf(s.accts) : [""]).map((mid) => ({ s, mid })))
      .slice(0, 25)
      .map(({ s, mid }) => {
        const k = stOf(s), l = mid ? boxList(s.boxes?.[mid]) : [];
        return opt(`${name(s)}${mid ? ` · ${d.mName(mid)}` : ""}`, `${s.sid}|${mid}`, [k ? PRES[k]?.l : "", mid ? boxesT(l) || "sans box" : "aucun compte"].filter(Boolean).join(" · "), (k && PRES[k]?.e) || sl.emoji || null, st.sel === `${s.sid}|${mid}`);
      });
    const holder = (b) => here.filter((s) => s.sid !== sel?.sid && boxList(s.boxes?.[bm]).includes(b)).map(name).join(", ");
    const cur = sel && bm ? boxList(sel.boxes?.[bm]) : [];
    const boxRow = !sel
      ? emptyMenu("pe_sb", here.length ? "Box : choisis d'abord un chatteur ☝️" : "Box")
      : !bm
        ? emptyMenu("pe_sb", "Aucun compte : ✏️ Comptes pour en mettre")
        : new StringSelectMenuBuilder()
            .setCustomId("pe_sb")
            .setPlaceholder(`Box de ${name(sel)} sur ${d.mName(bm)} : aucune`.slice(0, 150))
            .setMinValues(0)
            .setMaxValues(BOX_OPTS.length)
            .addOptions(BOX_OPTS.map(([v, l]) => opt(l, v, holder(v) ? `Prise par ${holder(v)}` : v === "all" ? "Toutes les box" : "Libre", null, cur.includes(v))));
    return {
      content: fitMsg(head(st, [
        `📅 **${sl.emoji} ${sl.l} · ${dayLabel(st.date)}** (${sl.h}) · ${n ? `${n} chatteur${plS(n)}` : "personne"}${isNow(st.date, slot) ? " · 🔴 en cours" : ""}`,
        ...blocks,
        !here.length
          ? "_Personne sur ce shift : ➕ pour ajouter quelqu'un, ou 📋 pour copier un autre jour._"
          : sel
            ? ""
            : "-# Choisis un chatteur dans le menu : ses box changent dès que tu les coches.",
      ])),
      components: [
        shiftRow(st, counts, { jumps: true }),
        row(who.length ? new StringSelectMenuBuilder().setCustomId("pe_sc").setPlaceholder("Chatteur").addOptions(who) : emptyMenu("pe_sc", "Personne sur ce shift")),
        row(boxRow),
        row(
          button("pe_srp", sel ? `Remplacer ${name(sel)}`.slice(0, 80) : "Remplacer", "🔁", ButtonStyle.Secondary, !here.length),
          button("pe_smv", sel ? `Déplacer ${name(sel)}`.slice(0, 80) : "Déplacer", "🔀", ButtonStyle.Secondary, !here.length),
          button("pe_sed", "Comptes / shift", "✏️", ButtonStyle.Secondary, !sel),
          button("pe_sdl", sel && st.delArm === sel.sid ? "Sûr ? Retirer" : "Retirer", "🗑️", ButtonStyle.Danger, !sel)
        ),
        row(
          button("pe_add", "Ajouter", "➕", ButtonStyle.Success),
          button("pe_bx", "Box du shift", "📦", ButtonStyle.Secondary, !mids.length),
          button("pe_copy", "Copier un jour", "📋", ButtonStyle.Secondary),
          button("pe_send", "Envoyer", "📣", ButtonStyle.Primary, !d.plan.length),
          closeBtn()
        ),
      ],
    };
  },
  // Un chatteur : son shift et ses comptes (ses box se changent sur l'écran du shift)
  async edit(st) {
    const d = await load(st.date);
    const e = d.plan.find((s) => s.sid === st.sid);
    if (!e) return VIEWS.sh(Object.assign(st, { view: "sh", sel: null, note: "⚠️ Cette ligne n'est plus au planning (changée dans l'app ?)." }));
    const c = d.byId[e.chatterId];
    const accts = d.cat.accounts.slice(0, 25);
    const sl = slotOf(e.slot);
    return {
      content: head(st, [`✏️ ${whoMd(c)} · ${sl.emoji} ${sl.l} · ${dayLabel(st.date)}${d.off.has(c.id) ? " · 🏖️ day off" : ""}`, acctsText(d, e.accts, e.boxes)]),
      components: [
        slotMenu("pe_slot", e.slot, "Changer de shift"),
        row(
          new StringSelectMenuBuilder()
            .setCustomId("pe_acc")
            .setPlaceholder("Comptes (modèle et plateforme)")
            .setMinValues(0)
            .setMaxValues(Math.max(1, accts.length))
            .addOptions(accts.length ? accts.map((a) => opt(`${withEmoji(a.model)} · ${a.platform}`, a.key, null, null, (e.accts || []).includes(a.key))) : [opt("Aucun compte dans l'app", "none")])
        ),
        row(backBtn(), closeBtn()),
      ],
    };
  },
  // Remplacer : qui part, qui le remplace (il reprend ses comptes et ses box), et ce que deviennent les box
  // du remplaçant s'il était déjà sur une autre modèle de ce shift
  async rep(st) {
    const [d, counts] = await Promise.all([load(st.date), nearCounts(st.date)]);
    const slot = (st.slot = workSlot(st, d));
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
        shiftRow(st, counts),
        row(here.length ? new StringSelectMenuBuilder().setCustomId("pe_ro").setPlaceholder("Qui part ?").addOptions(entryOpts(d, here.slice(0, 25)).map((o) => ({ ...o, default: o.value === st.out }))) : emptyMenu("pe_ro", "Personne sur ce shift")),
        pickRow("pe_ri", { alt: st.alt, opts: cands, chatters: Object.values(d.byId), cid: st.inn, placeholder: "Qui le remplace ?" }),
        ...(leaving.length
          ? [row(new StringSelectMenuBuilder().setCustomId("pe_rf").setPlaceholder("Ses autres box").addOptions(fateOpts(d, slot, target, leaving, [r.id, e.chatterId]).map((o) => ({ ...o, default: o.value === (st.fate || "keep") }))))]
          : []),
        row(
          button("pe_repok", "Remplacer", "🔁", ButtonStyle.Success, !(e && r)),
          button("pe_cut", st.cut ? "Coupure : oui" : "Coupure : non", "✂️", st.cut ? ButtonStyle.Primary : ButtonStyle.Secondary),
          ...altButton("pe_alt", { alt: st.alt, opts: cands, chatters: Object.values(d.byId) }),
          backBtn(),
          closeBtn()
        ),
      ],
    };
  },
  // Déplacer : un chatteur va sur une autre modèle (renfort, ou à la place de quelqu'un) avec ses box
  async mv(st) {
    const [d, counts] = await Promise.all([load(st.date), nearCounts(st.date)]);
    const slot = (st.slot = workSlot(st, d));
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
        tk ? `Vers : **${d.mName(tm).toLocaleUpperCase("fr")}** ${d.cat.platName(tk.split("|")[1])}${st.mvBoxes?.length ? ` · ${boxLabel(boxList(st.mvBoxes))}` : ""}${holders.length ? `\n-# Déjà dessus : ${holders.map((s) => `${d.byId[s.chatterId].name} ${boxesE(boxList(s.boxes?.[tm]))}`.trim()).join(", ")}` : ""}` : "",
      ]),
      components: [
        // 5 lignes au plus : le menu des shifts laisse sa place au choix de ses box actuelles
        ...(others.length ? [] : [shiftRow(st, counts)]),
        row(here.length ? new StringSelectMenuBuilder().setCustomId("pe_mw").setPlaceholder("Qui ?").addOptions(entryOpts(d, here.slice(0, 25)).map((o) => ({ ...o, default: o.value === st.mvSid }))) : emptyMenu("pe_mw", "Personne sur ce shift")),
        row(new StringSelectMenuBuilder().setCustomId("pe_mt").setPlaceholder("Vers quelle modèle ?").addOptions(accts.map((a) => opt(`${withEmoji(a.model)} · ${a.platform}`, a.key, null, null, a.key === tk)))),
        row(tm ? boxMenu("pe_mb", d, tm, boxList(st.mvBoxes), `Ses box sur ${d.mName(tm)}`) : emptyMenu("pe_mb", "Ses box (choisis d'abord la modèle)")),
        ...(others.length
          ? [row(new StringSelectMenuBuilder().setCustomId("pe_mf").setPlaceholder("Ses box actuelles").addOptions(fateOpts(d, slot, e, others, [e.chatterId]).map((o) => ({ ...o, default: o.value === (st.fate || "keep") }))))]
          : []),
        row(button("pe_mvok", "Déplacer", "🔀", ButtonStyle.Success, !(e && tk)), backBtn(), closeBtn()),
      ],
    };
  },
  // Renfort : un chatteur sur un shift où il n'est pas prévu
  async ren(st) {
    if (st.live && !st.slot) Object.assign(st, shiftChoices(st)[0] || {});
    // la nuit commence à 2 h : ceux du soir d'avant (la veille) peuvent rester en renfort
    const evening = (k) => (k === "nuit" ? appSync.planOf(appSync.addDays(st.date, -1)).catch(() => []) : Promise.resolve([]));
    const asked = st.slot, early = evening(st.slot);
    const [d, counts] = await Promise.all([load(st.date), nearCounts(st.date)]);
    const date = st.date, slot = (st.slot = workSlot(st, d));
    const sl = slotOf(slot);
    const c = st.cid && d.byId[st.cid];
    const mid = st.acc && st.acc.split("|")[0];
    const holders = mid ? d.plan.filter((s) => s.slot === slot && s.chatterId !== st.cid && midsOf(s.accts).includes(mid)) : [];
    const here = c && d.plan.find((s) => s.chatterId === c.id && s.slot === slot);
    const eve = (await (asked === slot ? early : evening(slot))).filter((s) => s.slot === "soir").map((s) => ({ ...s, slot: "soir", eve: true }));
    const elsewhere = (id) => [...eve, ...d.plan].filter((s) => s.chatterId === id && (s.eve || s.slot !== slot));
    // d'abord ceux prévus sur un autre shift ce jour-là (ils restent ou arrivent plus tôt), puis les libres, puis ceux déjà dessus
    const rank = (x) => (d.plan.some((s) => s.chatterId === x.id && s.slot === slot) ? 2 : elsewhere(x.id).length ? 0 : 1);
    const people = Object.values(d.byId)
      .filter((x) => x.active && !d.off.has(x.id))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "fr"))
      .map((x) => {
        const on = d.plan.find((s) => s.chatterId === x.id && s.slot === slot);
        const other = elsewhere(x.id);
        const where = (l) => l.map((s) => `${slotOf(s.slot).l}${s.eve ? " d'avant" : ""}`).join(" + ");
        return opt(x.name, x.id, on ? `Déjà sur ce shift · ${acctsText(d, on.accts, on.boxes, false)}` : other.length ? `Prévu en ${where(other)} · ${acctsText(d, other[0].accts, other[0].boxes, false)}` : "Libre ce jour-là", on ? sl.emoji : other.length ? slotOf(other[0].slot).emoji : "🟢");
      });
    const where = (l) => l.map((s) => `${slotOf(s.slot).l}${s.eve ? " d'avant" : ""}`).join(" + ");
    const around = Object.values(d.byId).filter((x) => x.active && !d.off.has(x.id) && rank(x) === 0).sort((a, b) => a.name.localeCompare(b.name, "fr"));
    const now = Date.now() >= appSync.parisMs(date, appSync.START_OF[slot]);
    return {
      content: head(st, [
        `➕ **${st.live ? "Renfort" : "Ajouter"}** · ${sl.emoji} ${sl.l} (${sl.h}) · ${dayLabel(date)}${now ? " · en cours" : ""}`,
        st.live
          ? "Mets un chatteur sur un shift où il n'est pas prévu (ex. un gars du soir qui reste la nuit), avec sa modèle et ses box : elles sont retirées à celui qui les avait."
          : "Choisis le chatteur, sa modèle (son compte habituel est proposé) et ses box : elles sont retirées à celui qui les avait.",
        // qui peut rester ou venir plus tôt : ceux prévus sur un autre shift (le menu des membres ne le montre pas)
        !c && around.length ? `-# Prévus sur un autre shift : ${around.slice(0, 15).map((x) => `${x.name} (${where(elsewhere(x.id))})`).join(", ")}${around.length > 15 ? "…" : ""}` : "",
        c ? `Chatteur : ${whoMd(c)}${elsewhere(c.id).length ? ` · prévu en ${elsewhere(c.id).map((s) => `${slotOf(s.slot).l}${s.eve ? " d'avant" : ""}`).join(" + ")}` : ""}${here ? `\n-# Déjà sur ce shift (${acctsText(d, here.accts, here.boxes, false)}) : la modèle s'ajoute à ses comptes.` : ""}` : "",
        st.acc ? `Sur : **${d.mName(mid).toLocaleUpperCase("fr")}** ${d.cat.platName(st.acc.split("|")[1])}${st.rBoxes?.length ? ` · ${boxLabel(boxList(st.rBoxes))}` : ""}${holders.length ? `\n-# Déjà dessus : ${holders.map((s) => `${d.byId[s.chatterId].name} ${boxesE(boxList(s.boxes?.[mid]))}`.trim()).join(", ")}` : ""}` : "",
      ]),
      components: [
        shiftRow(st, counts),
        pickRow("pe_nc", { alt: st.alt, opts: people, chatters: Object.values(d.byId), cid: st.cid, placeholder: st.live ? "Chatteur en renfort" : "Chatteur" }),
        row(new StringSelectMenuBuilder().setCustomId("pe_na").setPlaceholder("Sur quelle modèle ?").addOptions(d.cat.accounts.slice(0, 25).map((a) => opt(`${withEmoji(a.model)} · ${a.platform}`, a.key, null, null, a.key === st.acc)))),
        row(mid ? boxMenu("pe_nb", d, mid, boxList(st.rBoxes), `Ses box sur ${d.mName(mid)}`) : emptyMenu("pe_nb", "Ses box (choisis d'abord la modèle)")),
        row(
          button("pe_nok", st.live ? "Mettre en renfort" : "Ajouter", "➕", ButtonStyle.Success, !(c && st.acc)),
          ...altButton("pe_alt", { alt: st.alt, opts: people, chatters: Object.values(d.byId) }),
          backBtn(),
          closeBtn()
        ),
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
  if (view === "bx") return openBox(i, { date, ...extra });
  const st = { date, view, cut: false, fate: "keep", ...extra };
  states.set(i.user.id, st);
  memo = new Map();
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
  memo = new Map();
  ctx.refresh?.(st.date);
}
async function handle(i) {
  const id = i.customId;
  memo = new Map();
  // sous le planning du salon : pl_<vue>_<date>, ou sous le message de début de shift : pl_edit_<date>_<créneau>
  const pub = id.match(/^pl_(edit|rep|add|mv|next)_(\d{4}-\d{2}-\d{2})(?:_([a-z]+))?$/);
  if (pub) {
    const [, act, date, slot] = pub;
    if (act === "next") return open(i, appSync.addDays(date, 1), "copy", { src: date });
    return open(i, date, { edit: "sh", rep: "rep", add: "ren", mv: "mv" }[act], slot ? { slot } : {});
  }
  // menu « box » d'un shift sous le planning : pl_qb_<date>_<créneau> -> l'écran du shift, ce chatteur choisi
  const qb = id.match(/^pl_qb_(\d{4}-\d{2}-\d{2})_([a-z]+)$/);
  if (qb) return i.values?.[0] === "_nb" ? open(i, qb[1], "bx", { slot: qb[2] }) : open(i, qb[1], "sh", { slot: qb[2], sel: `${i.values?.[0]}|` });
  if (id.startsWith("pb_")) return handleBox(i);
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const st = states.get(i.user.id);
  if (!st) return done(i, "Ce menu a expiré : reclique sur un bouton du planning.", 8000);
  st.note = "";
  const [, act] = id.split("_");
  const v = i.values?.[0];
  if (act === "x") {
    states.delete(i.user.id);
    return done(i, "✅ C'est noté.", 4000);
  }
  await i.deferUpdate();
  // 🗑️ Retirer demande un 2e clic ; n'importe quel autre clic annule
  const armed = st.delArm;
  st.delArm = null;
  const selSid = () => String(st.sel || "").split("|")[0] || null;
  // une action réussie (✅) ramène à l'écran du shift
  const home = (note) => {
    st.note = note;
    if (String(note).startsWith("✅")) st.view = "sh";
  };

  if (act === "back") st.view = "sh";
  else if (act === "ss") {
    const [a, b] = String(v).split("|");
    if (a === "d") st.date = b;
    else Object.assign(st, { date: a, slot: b });
    Object.assign(st, { sel: null, out: null, inn: null, mvSid: null, mvAcc: null, mvBoxes: [], fate: "keep", nbm: null, nbn: null, nbw: null });
  } else if (act === "sc") st.sel = v;
  else if (act === "sb" || act === "sdl") {
    const d = await load(st.date);
    const [sid, mid] = String(st.sel || "").split("|");
    const e = d.plan.find((s) => s.sid === sid);
    if (!e) Object.assign(st, { sel: null, note: "⚠️ Cette ligne n'est plus au planning (changée dans l'app ?)." });
    else if (act === "sb") st.note = mid ? await setBoxes(st, d, e, mid, i.values) : "";
    else if (armed !== sid) st.delArm = sid;
    else {
      await save(st, { [sid]: null });
      Object.assign(st, { sel: null, note: `🗑️ ${whoMd(d.byId[e.chatterId])} retiré du ${slotOf(e.slot).l}.` });
    }
  } else if (act === "srp") Object.assign(st, { view: "rep", out: selSid(), inn: null, cut: false, fate: "keep", alt: false });
  else if (act === "smv") Object.assign(st, { view: "mv", mvSid: selSid(), mvAcc: null, mvBoxes: [], fate: "keep" });
  else if (act === "sed") Object.assign(st, { view: "edit", sid: selSid() });
  else if (act === "add") Object.assign(st, { view: "ren", cid: null, acc: null, rBoxes: [], alt: false });
  else if (act === "bx") return openBox(i, { date: st.date, slot: st.slot, live: st.live }, true);
  else if (act === "copy") Object.assign(st, { view: "copy", src: null, add: false });
  else if (act === "send") {
    const r = await ctx.postPlanning(st.date).catch((e) => ({ error: e.message }));
    st.note = r?.error ? `⚠️ Pas envoyé : ${String(r.error).slice(0, 150)}` : `📣 Planning du ${dayLabel(st.date)} envoyé dans le salon planning (${r.count} chatteur${r.count > 1 ? "s" : ""}).`;
  } else if (act === "slot" || act === "acc") {
    const d = await load(st.date);
    const e = d.plan.find((s) => s.sid === st.sid);
    if (!e) st.view = "sh";
    else if (act === "slot") {
      if (v !== e.slot && d.plan.some((s) => s.chatterId === e.chatterId && s.slot === v))
        st.note = `⚠️ ${whoMd(d.byId[e.chatterId])} est déjà au planning sur ce shift.`;
      else if (v !== e.slot) {
        await save(st, { [e.sid]: { slot: v } });
        // Retour : l'écran de son nouveau shift, lui choisi
        Object.assign(st, { slot: v, sel: `${e.sid}|`, note: `✅ Passé en ${slotOf(v).emoji} ${slotOf(v).l}.` });
      }
    } else {
      const accts = i.values.filter((x) => x !== "none");
      const gone = midsOf(e.accts).filter((m) => !midsOf(accts).includes(m));
      const boxes = Object.fromEntries(Object.keys(e.boxes || {}).filter((m) => gone.includes(m)).map((m) => [m, null]));
      await save(st, { [e.sid]: { accts, ...(Object.keys(boxes).length ? { boxes } : {}) } });
      st.note = "✅ Comptes enregistrés.";
    }
  } else if (act === "ro") Object.assign(st, { out: v, inn: null, fate: "keep" });
  else if (act === "ri" || act === "nc") {
    // remplaçant ou renfort : tapé dans le menu des membres, ou pris dans la liste de ceux pas sur Discord
    const d = await load(st.date);
    const out = act === "ri" && d.plan.find((s) => s.sid === st.out)?.chatterId;
    const r = await picked(i, Object.values(d.byId).filter((c) => c.active && !d.off.has(c.id) && c.id !== out), { why: `inactif ou en day off ce jour-là${out ? ", ou c'est lui qui part" : ""}` });
    if (!r.c) st.note = r.error;
    else if (act === "ri") Object.assign(st, { inn: r.c.id, fate: "keep" });
    else {
      st.cid = r.c.id;
      // son compte habituel par défaut
      if (!st.acc) st.acc = r.c.shift?.accts?.[0] || null;
    }
  } else if (act === "alt") st.alt = !st.alt;
  else if (act === "rf" || act === "mf") st.fate = v;
  else if (act === "cut") st.cut = !st.cut;
  else if (act === "repok") home(await replace(st));
  else if (act === "mw") Object.assign(st, { mvSid: v, fate: "keep" });
  else if (act === "mt") {
    const d = await load(st.date);
    const e = d.plan.find((s) => s.sid === st.mvSid);
    st.mvAcc = v;
    st.mvBoxes = e ? boxList(e.boxes?.[v.split("|")[0]]) : [];
  } else if (act === "mb") st.mvBoxes = cleanBoxes(i.values, boxList(st.mvBoxes));
  else if (act === "mvok") home(await move(st));
  else if (act === "na") Object.assign(st, { acc: v, rBoxes: [] });
  else if (act === "nb") st.rBoxes = cleanBoxes(i.values, boxList(st.rBoxes));
  else if (act === "nok") home(await renfort(st));
  else if (act === "cs") st.src = v;
  else if (act === "cm") st.add = !st.add;
  else if (act === "cok") {
    const r = await appSync.copyPlan(st.src, st.date, { replace: !st.add });
    memo = new Map();
    ctx.refresh?.(st.date);
    Object.assign(st, {
      view: "sh",
      slot: null,
      sel: null,
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
  let fate = "", rsid = target?.sid;
  if (target) {
    const leaving = st.fate && st.fate !== "keep" ? midsOf(target.accts).filter((m) => !mids.includes(m)) : [];
    fate = applyFate(d, st.fate, target, leaving, patch);
    const merged = {};
    for (const [m, v] of Object.entries(boxes)) merged[m] = boxList([...boxList(target.boxes?.[m]), ...v]);
    const accts = [...new Set([...(target.accts || []).filter((k) => !leaving.includes(k.split("|")[0])), ...(e.accts || [])])];
    addPatch(patch, target.sid, { accts, ...(Object.keys(merged).length ? { boxes: merged } : {}) });
  } else addPatch(patch, (rsid = appSync.newId()), { slot: e.slot, chatterId: r.id, accts: [...(e.accts || [])], ...(Object.keys(boxes).length ? { boxes } : {}) });
  if (Object.keys(e.boxes || {}).length)
    addPatch(patch, e.sid, {
      boxes: Object.fromEntries(Object.keys(e.boxes).map((m) => [m, null])),
      // gardées pour les lui rendre à son retour de coupure (giveBack)
      ...(Object.keys(boxes).length ? { held: Object.entries(boxes).map(([m, b]) => ({ m, b, to: r.id })) } : {}),
    });
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
  Object.assign(st, { out: null, inn: null, cut: false, fate: "keep", sel: `${rsid}|` });
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
  addPatch(patch, e.sid, { accts, boxes: { [tm]: l.length ? l : null }, ...(e.held ? { held: null } : {}) });
  await save(st, patch);
  const c = d.byId[e.chatterId];
  const sl = slotOf(e.slot);
  const dest = `**${d.mName(tm).toLocaleUpperCase("fr")}** ${d.cat.platName(tk.split("|")[1])}${l.length ? ` · ${boxLabel(l)}` : ""}`;
  if (running(st.date, e.slot))
    await ctx.notify?.({
      content: `🔀 ${tag(c)} passe sur ${dest} · ${sl.emoji} ${sl.l}${fate}`,
      allowedMentions: { users: [c.discordId].filter(Boolean) },
    }).catch((err) => console.error("Déplacement (salon clocking) :", err.message));
  Object.assign(st, { mvSid: null, mvAcc: null, mvBoxes: [], fate: "keep", sel: `${e.sid}|${tm}` });
  return `✅ ${whoMd(c)} passe sur ${d.mName(tm)}${l.length ? ` · ${boxLabel(l)}` : ""}${noPing(d, fate)}.${taken.length ? ` ↪️ ${cap(taken.join(", "))}.` : ""}`;
}

// Renfort : un chatteur en plus sur un shift (ex. un gars du soir qui reste la nuit), sur la modèle et les box choisies
async function renfort(st) {
  const { date, slot } = st;
  const d = await load(date);
  const c = d.byId[st.cid];
  if (!c || !st.acc) return "Choisis le chatteur et la modèle.";
  if (d.off.has(c.id)) return `⛔ ${whoMd(c)} est en day off ce jour-là.`;
  const mid = st.acc.split("|")[0];
  const l = boxList(st.rBoxes);
  const e = d.plan.find((s) => s.chatterId === c.id && s.slot === slot);
  const sid = e?.sid || appSync.newId();
  const patch = {};
  const taken = takeBoxes(d, slot, mid, l, [sid], patch);
  if (e) addPatch(patch, sid, { accts: [...new Set([...(e.accts || []), st.acc])], ...(l.length ? { boxes: { [mid]: l } } : {}) });
  else addPatch(patch, sid, { slot, chatterId: c.id, accts: [st.acc], ...(l.length ? { boxes: { [mid]: l } } : {}) });
  await save(st, patch);
  const sl = slotOf(slot);
  const dest = `**${d.mName(mid).toLocaleUpperCase("fr")}** ${d.cat.platName(st.acc.split("|")[1])}${l.length ? ` · ${boxLabel(l)}` : ""}`;
  if (running(date, slot))
    await ctx.notify?.({ content: `➕ ${tag(c)} en renfort · ${sl.emoji} ${sl.l} · ${dest}`, allowedMentions: { users: [c.discordId].filter(Boolean) } })
      .catch((err) => console.error("Renfort (salon clocking) :", err.message));
  Object.assign(st, { cid: null, acc: null, rBoxes: [], sel: `${sid}|${mid}` });
  return `✅ ${whoMd(c)} ${st.live ? "en renfort" : "ajouté"} sur ${sl.emoji} ${sl.l} (${dayLabel(date)}) · ${d.mName(mid)}${l.length ? ` · ${boxLabel(l)}` : ""}.${taken.length ? ` ↪️ ${cap(taken.join(", "))}.` : ""}`;
}
// Depuis le salon gestion : le shift en cours d'abord, puis les suivants ; sinon ceux du jour
function shiftChoices(st) {
  if (!st.live) return SLOTS.map((s) => ({ date: st.date, slot: s.k }));
  const now = Date.now();
  const td = appSync.parisParts(now).date;
  return [-1, 0, 1]
    .flatMap((k) => SLOTS.map((s) => ({ date: appSync.addDays(td, k), slot: s.k })))
    .map((x) => ({ ...x, start: appSync.parisMs(x.date, appSync.START_OF[x.slot]) }))
    .filter((x) => x.start + 6 * 3600e3 > now)
    .sort((a, b) => a.start - b.start)
    .slice(0, 4);
}

// Retour de coupure : les box qu'il avait avant d'être remplacé, et qui les a maintenant
async function heldOf(date, slot, cid) {
  const d = await load(date);
  const e = d.plan.find((s) => s.chatterId === cid && s.slot === slot);
  const held = (Array.isArray(e?.held) ? e.held : []).filter((h) => h && h.m && boxList(h.b).length);
  const parts = held.map((h) => {
    const b = boxList(h.b);
    const from = d.plan.filter((s) => s.slot === slot && s.sid !== e.sid && boxList(s.boxes?.[h.m]).some((x) => b.includes(x)));
    return { h, b, from, txt: `${boxLabel(b)} sur ${d.mName(h.m)}${from.length ? ` (chez ${from.map((s) => d.byId[s.chatterId].name).join(", ")})` : ""}` };
  });
  return { d, e, parts };
}
const heldText = async (date, slot, cid) => (await heldOf(date, slot, cid)).parts.map((p) => p.txt).join(" · ");
// Il les reprend : retirées à celui qui les a ; renvoie « reprend ses Box : 2️⃣ & 3️⃣ sur Axelle 🍒 (rendues par Moise) »
async function giveBack(date, slot, cid) {
  const { d, e, parts } = await heldOf(date, slot, cid);
  if (!e || !parts.length) return "";
  const patch = {};
  for (const { h, b } of parts) {
    takeBoxes(d, slot, h.m, b, [e.sid], patch);
    const cur = boxList(e.boxes?.[h.m]).filter((x) => x !== "all");
    addPatch(patch, e.sid, { boxes: { [h.m]: b.includes("all") ? ["all"] : boxList([...cur, ...b]) } });
  }
  addPatch(patch, e.sid, { held: null });
  await save({ date }, patch);
  return `reprend ses ${parts.map(({ h, b, from }) => `${boxLabel(b)} sur **${d.mName(h.m)}**${from.length ? ` (rendue${b.length > 1 ? "s" : ""} par ${from.map((s) => d.byId[s.chatterId].name).join(", ")})` : ""}`).join(" · ")}`;
}

// ---------- Box du shift : une ligne par box, le chatteur en face ----------
// Message à part, avec la nouvelle mise en page de Discord (plus de 5 lignes de menus) : pour une modèle sur
// un shift, le nombre de box, puis une ligne par box où l'on choisit son chatteur. Chaque choix est enregistré
// tout de suite (la box est retirée à celui qui l'avait) ; 🔎 donne une box libre à qui l'on tape (s'il n'est pas sur
// cette modèle, il y est mis en renfort ; s'il n'y a plus de box libre, on en ajoute une).
const boxStates = new Map(); // userId -> { date, slot, live, mid, alt }
const keycap = (n) => (n <= 9 ? `${n}\uFE0F\u20E3` : n === 10 ? "🔟" : "📦");
async function boxView(st) {
  if (st.live && !st.slot) Object.assign(st, shiftChoices(st)[0] || {});
  const early = st.slot ? presenceOf(st.date, st.slot) : null;
  const [d, counts] = await Promise.all([load(st.date), nearCounts(st.date)]);
  st.slot = workSlot(st, d);
  const pres = await (early || presenceOf(st.date, st.slot));
  const slot = st.slot, sl = slotOf(slot);
  const here = d.plan.filter((s) => s.slot === slot);
  const mids = [...new Set(here.flatMap((s) => midsOf(s.accts)))].sort((a, b) => d.mName(a).localeCompare(d.mName(b), "fr"));
  if (!mids.includes(st.mid)) st.mid = mids[0] || null;
  const mid = st.mid;
  const name = (s) => d.byId[s.chatterId].name;
  const on = here.filter((s) => midsOf(s.accts).includes(mid)).sort((a, b) => name(a).localeCompare(name(b), "fr"));
  const started = Date.now() >= startOf(st.date, slot);
  const stOf = (s) => (d.off.has(s.chatterId) ? "off" : started ? pres[s.chatterId] || "todo" : "");
  const bx = (s) => boxList(s.boxes?.[mid]);
  const top = Math.max(0, ...on.flatMap((s) => bx(s).filter((b) => b !== "all").map(Number)));
  const n = (st.n = Number(d.nbox?.[`${slot}|${mid}`]) || top || on.filter((s) => stOf(s) !== "off").length || 1);
  const holder = (b) => on.find((s) => bx(s).includes(String(b)));
  const allIn = on.filter((s) => bx(s).includes("all"));
  const over = on.flatMap((s) => bx(s).filter((b) => b !== "all" && Number(b) > n).map((b) => `${name(s)} (${b})`));
  // 🔎 : ceux du shift sur cette modèle d'abord (pour la liste « Pas sur Discord »)
  const eligible = Object.values(d.byId).filter((c) => c.active && !d.off.has(c.id))
    .sort((a, b) => on.some((s) => s.chatterId === b.id) - on.some((s) => s.chatterId === a.id) || a.name.localeCompare(b.name, "fr"));
  const addOpts = eligible.map((c) => opt(c.name, c.id, on.some((s) => s.chatterId === c.id) ? `Déjà sur ${d.mName(mid)}` : null));
  // un nouvel id à chaque affichage : sinon Discord laisse le nom choisi dans le menu 🔎
  st.k = ((st.k || 0) % 999) + 1;
  const live = running(st.date, slot);
  const buttons = [
    button("pb_auto", `Répartir sur ceux qui sont là`, "🔄", ButtonStyle.Secondary, !on.length),
    ...(live ? [button("pb_tell", "Prévenir le clocking", "📣", ButtonStyle.Primary, !on.some((s) => bx(s).length))] : []),
    ...altButton("pb_alt", { alt: st.alt, opts: addOpts, chatters: eligible }),
    button("pb_x", "Fermer", null, ButtonStyle.Secondary),
  ];
  // 40 éléments au plus dans un message : chaque ligne de menu en compte 2
  const fixed = 1 + 2 + (mids.length > 1 ? 2 : 0) + (mid ? 4 : 0) + 1 + buttons.length;
  const shownN = Math.min(n, Math.floor((40 - fixed) / 2), 15);
  const boxRow = (b) => {
    const h = holder(b);
    return row(
      new StringSelectMenuBuilder()
        .setCustomId(`pb_b_${b}`)
        .setPlaceholder(`Box ${b}`)
        .addOptions(
          opt(`Box ${b} · libre`, "_free", "Personne sur cette box", keycap(b), !h),
          ...on.slice(0, 24).map((s) => {
            const k = stOf(s), l = bx(s);
            return opt(`Box ${b} · ${name(s)}`, s.sid, [k ? PRES[k].l : "", l.length ? `a ${boxesT(l)}` : "sans box"].filter(Boolean).join(" · "), h?.sid === s.sid ? keycap(b) : (k && PRES[k].e) || "👤", h?.sid === s.sid);
          })
        )
    );
  };
  const text = [
    st.note,
    `📦 **Box du shift** · ${sl.emoji} ${sl.l} · ${dayLabel(st.date)}${isNow(st.date, slot) ? " · 🔴 en cours" : ""}`,
    mid
      ? [
          `**${d.mName(mid).toLocaleUpperCase("fr")}** · ${on.length} chatteur${plS(on.length)} · **${n} box**`,
          ...on.map((s) => {
            const k = stOf(s), l = bx(s);
            return [`${k ? `${PRES[k].e} ` : ""}${name(s)}`, l.length ? boxLabel(l) : "sans box", ["retard", "coupure", "absent", "off"].includes(k) ? PRES[k].l : ""].filter(Boolean).join(" · ");
          }),
          allIn.length ? `-# 📥 All Inbox : ${allIn.map(name).join(", ")}` : "",
          over.length ? `-# En plus des ${n} box : ${over.join(", ")}` : "",
          shownN < n ? `-# Box ${shownN + 1} à ${n} : sur l'écran du shift (✏️ Modifier).` : "",
          "-# Une ligne par box : choisis son chatteur, c'est enregistré tout de suite. Ou tape un nom dans 🔎 : il reçoit une box libre.",
        ].filter(Boolean).join("\n")
      : "_Personne au planning sur ce shift._",
  ].filter(Boolean).join("\n");
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      new TextDisplayBuilder().setContent(fitMsg(text).slice(0, 3900)),
      shiftRow(st, counts, { id: "pb_ss" }),
      ...(mids.length > 1 ? [row(new StringSelectMenuBuilder().setCustomId("pb_m").setPlaceholder("Modèle").addOptions(mids.slice(0, 25).map((m) => opt(d.mName(m), m, `${here.filter((s) => midsOf(s.accts).includes(m)).length} chatteur(s)`, null, m === mid))))] : []),
      ...(mid
        ? [
            row(new StringSelectMenuBuilder().setCustomId("pb_n").setPlaceholder("Nombre de box").addOptions(Array.from({ length: 15 }, (_, k) => opt(`${k + 1} box`, String(k + 1), null, "📦", k + 1 === n)))),
            ...Array.from({ length: shownN }, (_, k) => boxRow(k + 1)),
            pickRow(`pb_add_${st.k}`, { alt: st.alt, opts: addOpts, chatters: eligible, placeholder: "Donner une box" }),
          ]
        : []),
      row(...buttons),
    ],
  };
}
// Le message des box : nouveau (fresh) ou celui où l'on a cliqué
async function showBox(i, st, fresh) {
  const p = { allowedMentions: { parse: [] }, ...(await boxView(st)) };
  if (!fresh) return i.editReply(p);
  if (fresh === "follow") return i.followUp({ ...p, flags: p.flags | EPHEMERAL });
  return i.editReply(p);
}
// fresh = true depuis l'écran du shift (nouveau message à côté), sinon depuis un bouton du serveur
async function openBox(i, extra, fromHub = false) {
  if (!fromHub) {
    if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
    if (!appSync.enabled()) return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
    await i.deferReply({ flags: EPHEMERAL });
  }
  const st = { date: extra.date, slot: extra.slot || null, live: !!extra.live };
  boxStates.set(i.user.id, st);
  memo = new Map();
  return showBox(i, st, fromHub ? "follow" : true);
}
async function handleBox(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const st = boxStates.get(i.user.id);
  if (!st) return reply(i, { content: "Ce menu a expiré : rouvre 📦 Box du shift." });
  const [, act, arg] = i.customId.split("_");
  const v = i.values?.[0];
  await i.deferUpdate();
  if (act === "x") {
    boxStates.delete(i.user.id);
    return i.deleteReply().catch(() => {});
  }
  st.note = "";
  const d = await load(st.date);
  const mid = st.mid, slot = st.slot;
  const on = d.plan.filter((s) => s.slot === slot && midsOf(s.accts).includes(mid));
  if (act === "ss") {
    const [a, b] = String(v).split("|");
    if (a === "d") st.date = b;
    else Object.assign(st, { date: a, slot: b });
  } else if (act === "m") st.mid = v;
  else if (act === "alt") st.alt = !st.alt;
  else if (act === "n") {
    // nouveau nombre de box : celles au-delà sont libérées
    const n = Number(v) || 1;
    const patch = {}, freed = [];
    for (const s of on) {
      const l = boxList(s.boxes?.[mid]);
      const keep = l.filter((b) => b === "all" || Number(b) <= n);
      if (keep.length < l.length) {
        addPatch(patch, s.sid, { boxes: { [mid]: keep.length ? keep : null } });
        freed.push(`${d.byId[s.chatterId].name} (${l.filter((b) => !keep.includes(b)).join(", ")})`);
      }
    }
    await save(st, patch);
    await appSync.setBoxCount(st.date, slot, mid, n);
    memo = new Map();
    st.note = `✅ **${d.mName(mid)}** : ${n} box.${freed.length ? ` Libérées : ${freed.join(", ")}.` : ""}`;
  } else if (act === "b") {
    const b = String(Number(arg) || 0);
    const was = on.find((s) => boxList(s.boxes?.[mid]).includes(b));
    if (v === "_free") {
      if (was) {
        const left = boxList(was.boxes[mid]).filter((x) => x !== b);
        await save(st, { [was.sid]: { boxes: { [mid]: left.length ? left : null } } });
        st.note = `✅ Box ${b} libre (retirée à ${d.byId[was.chatterId].name}).`;
      }
    } else {
      const e = on.find((s) => s.sid === v);
      if (!e) st.note = "⚠️ Cette ligne n'est plus au planning (changée dans l'app ?).";
      else if (was?.sid !== e.sid) st.note = await setBoxes(st, d, e, mid, [...boxList(e.boxes?.[mid]).filter((x) => x !== "all"), b]);
    }
  } else if (act === "add") {
    // 🔎 : il reçoit la première box libre (une de plus s'il n'y en a plus) ; pas encore sur cette modèle : renfort
    const r = await picked(i, Object.values(d.byId).filter((c) => c.active && !d.off.has(c.id)), { why: "inactif ou en day off ce jour-là" });
    if (!r.c) st.note = r.error;
    else {
      const e = on.find((s) => s.chatterId === r.c.id);
      const acc = e ? null : (r.c.shift?.accts || []).find((k) => k.startsWith(mid + "|")) || on.flatMap((s) => s.accts || []).find((k) => k.startsWith(mid + "|")) || d.cat.accounts.find((a) => a.key.startsWith(mid + "|"))?.key;
      const n = st.n || 1;
      const used = new Set(on.flatMap((s) => boxList(s.boxes?.[mid])));
      const free = Array.from({ length: n }, (_, k) => String(k + 1)).find((b) => !used.has(b));
      const b = free || (n < 15 ? String(n + 1) : null);
      if (!e && !acc) st.note = "⚠️ Aucun compte pour cette modèle dans l'app.";
      else if (!b) st.note = "⚠️ Les 15 box sont prises : libère-en une sur sa ligne.";
      else {
        if (!free) await appSync.setBoxCount(st.date, slot, mid, n + 1);
        st.note = e
          ? await setBoxes(st, d, e, mid, [...boxList(e.boxes?.[mid]).filter((x) => x !== "all"), b])
          : await renfort({ date: st.date, slot, cid: r.c.id, acc, rBoxes: [b], live: true });
        if (!free) st.note += ` 📦 ${d.mName(mid)} passe à ${n + 1} box.`;
        memo = new Map();
      }
      st.alt = false;
    }
  } else if (act === "auto") {
    const pres = await presenceOf(st.date, slot);
    const started = Date.now() >= startOf(st.date, slot);
    const ok = on.filter((s) => !d.off.has(s.chatterId) && (!started || ["present", "retard"].includes(pres[s.chatterId])));
    st.note = ok.length ? await boxSplit({ date: st.date, slot, nbm: mid, nbn: st.n || ok.length, nbw: ok.map((s) => s.sid) }) : "⚠️ Personne n'est là sur ce shift pour l'instant.";
  } else if (act === "tell") {
    const got = on.filter((s) => boxList(s.boxes?.[mid]).length);
    const sl = slotOf(slot);
    await ctx.notify?.({
      content: [`📦 **${d.mName(mid).toLocaleUpperCase("fr")}** · ${sl.emoji} ${sl.l} · ${st.n} box`, ...got.map((s) => `${tag(d.byId[s.chatterId])} · ${boxLabel(boxList(s.boxes[mid]))}`)].join("\n"),
      allowedMentions: { users: got.map((s) => d.byId[s.chatterId].discordId).filter(Boolean) },
    }).then(() => (st.note = "📣 Box envoyées dans le salon clocking."), (e) => (st.note = `⚠️ Pas envoyé : ${String(e.message).slice(0, 120)}`));
  }
  return showBox(i, st, false);
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
            opt(`Nombre de box du ${sl.l.toLowerCase()} et répartition`, "_nb", "Ex. 2 absents : passer de 6 à 4 box", "🔢"),
            ...list.slice(0, 24).map((s) =>
              opt(byId[s.chatterId].name, s.sid, midsOf(s.accts).map((m) => [mName(m), boxesS(boxList(s.boxes?.[m]))].filter(Boolean).join(" ")).join(" · ") || "Aucun compte", sl.emoji)
            )
          )
      )
    );
  }
  return rows.slice(0, 5);
}

module.exports = { ctx, handle, open, openReplaceFor, planComponents, states, takeBoxes, addPatch, giveBack, heldText };
