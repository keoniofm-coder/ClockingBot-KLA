// ================== LIEN AVEC L'APP KL ==================
// Le bot lit et écrit la table Supabase « docs » de l'app :
//  - Pointage (att/<date>) : présent ou retard au clock in, heure de départ au clock out,
//    absent si le chatteur n'a pas clock in ABSENT_AFTER_H heures après le début de son shift
//  - Équipe (chatters/<id>.discordId) : quel compte Discord correspond à quel chatteur
//  - config/discord : les membres du bot, pour pouvoir les relier depuis l'app
//  - Planning (plan/<date>) : pour l'envoyer dans le salon planning
//  - config/discordPost : demande d'envoi du planning faite depuis l'app
//  - Planning modifié depuis Discord (plan/<date>, même format que l'app) et day off (offs/<id>)
//  - Double shift : un seul clock in compte présent sur le shift suivant (coverShifts)
//  - Coupures : début (cutAt), retour (cutEnd) et minutes réelles cumulées (min), affichés dans le Pointage
//  - Virer un chatteur : retiré du planning à venir et des day off à venir, passé inactif (retireChatter)
// Désactivé tant que SUPABASE_URL et SUPABASE_SERVICE_KEY ne sont pas renseignés dans Railway.
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_KEY || "").trim();
const RETARD_TOLERANCE = Number(process.env.RETARD_TOLERANCE_MIN || 5); // minutes
const ABSENT_AFTER_H = Number(process.env.ABSENT_AFTER_H ?? 4); // 0 = jamais d'absent automatique
const TZ = "Europe/Paris";

// Shifts du bot -> créneaux de l'app (heure de début, heure de Paris)
const SLOT_OF = { MATIN: "matin", APREM: "aprem", SOIR: "soir", NUIT: "nuit" };
const START_OF = { matin: 8, aprem: 14, soir: 20, nuit: 2 };

const enabled = () => !!(SUPABASE_URL && SUPABASE_KEY);

async function http(method, path, body, prefer) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      // ancienne clé service_role (JWT) : aussi en Bearer ; nouvelle clé sb_secret_… : apikey suffit
      ...(SUPABASE_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${SUPABASE_KEY}` } : {}),
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${res.status}: ${text}`);
  return method === "GET" && text ? JSON.parse(text) : null;
}
const enc = encodeURIComponent;
const rest = (method, query, body, prefer) => http(method, `docs?${query}`, body, prefer);

async function getDoc(coll, id) {
  const rows = await rest("GET", `select=data&coll=eq.${enc(coll)}&id=eq.${enc(id)}`);
  return rows[0]?.data || null;
}
// Remplace tout le document
async function putDoc(coll, id, data) {
  await rest("POST", "", [{ coll, id, data, updated_at: new Date().toISOString() }], "resolution=merge-duplicates");
}
// Fusionne un morceau dans le document, sans toucher au reste (même fonction que l'app : merge_doc).
// base : document à créer s'il n'existe pas encore ; sans base, un document absent est une erreur.
async function mergeDoc(coll, id, patch, base) {
  const merge = () => http("POST", "rpc/merge_doc", { p_coll: coll, p_id: id, p_patch: patch });
  try {
    await merge();
  } catch (e) {
    if (!base || !/document absent/.test(e.message)) throw e;
    await rest("POST", "", [{ coll, id, data: base, updated_at: new Date().toISOString() }], "resolution=ignore-duplicates");
    await merge();
  }
}
async function delDoc(coll, id) {
  await rest("DELETE", `coll=eq.${enc(coll)}&id=eq.${enc(id)}`);
}
async function collMap(coll) {
  const rows = await rest("GET", `select=id,data&coll=eq.${enc(coll)}`);
  return Object.fromEntries(rows.map((r) => [r.id, r.data || {}]));
}

// ---------- Chatteurs de l'app (cache 1 min) ----------
let chattersCache = { at: 0, list: [] };
async function appChatters(force) {
  if (!force && Date.now() - chattersCache.at < 60e3) return chattersCache.list;
  const rows = await rest("GET", "select=id,data&coll=eq.chatters");
  const list = rows
    .map((r) => ({
      id: r.id,
      name: r.data?.name || "",
      active: r.data?.active !== false,
      discordId: r.data?.discordId ? String(r.data.discordId) : "",
      // shift habituel { slot, slots, accts, days } : slots = ses shifts (deux pour un double shift), slot = le premier
      shift: r.data?.shift && typeof r.data.shift === "object" ? r.data.shift : null,
    }))
    .filter((c) => c.name);
  chattersCache = { at: Date.now(), list };
  return list;
}

// Shifts habituels d'un chatteur, dans l'ordre de la journée : ["aprem", "soir"] pour un double shift
const SLOT_ORDER = ["matin", "aprem", "soir", "nuit"];
const habSlots = (h) =>
  !h ? [] : [...new Set((Array.isArray(h.slots) && h.slots.length ? h.slots : [h.slot]).filter((k) => SLOT_ORDER.includes(k)))]
    .sort((a, b) => SLOT_ORDER.indexOf(a) - SLOT_ORDER.indexOf(b));
// Shift habituel tel que l'app l'enregistre
const habitOf = (slots, accts, days) => {
  const l = habSlots({ slots });
  return l.length ? { slot: l[0], slots: l, accts: [...new Set(accts || [])], days: [...new Set(days?.length ? days : [0, 1, 2, 3, 4, 5, 6])].sort() } : null;
};

// ---------- Modèles et plateformes de l'app (cache 5 min) ----------
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
let catCache = { at: 0, v: null };
async function appCatalog() {
  if (catCache.v && Date.now() - catCache.at < 300e3) return catCache.v;
  const [models, platforms] = await Promise.all([collMap("models"), collMap("platforms")]);
  const platName = (pid) => platforms[pid]?.name || cap(String(pid).replace(/^p-/, ""));
  const accounts = [];
  for (const [mid, m] of Object.entries(models)) {
    if (m.active === false) continue;
    for (const pid of m.platforms || [])
      accounts.push({
        key: `${mid}|${pid}`, mid, pid, model: m.name || mid, platform: platName(pid),
        devise: platforms[pid]?.currency === "USD" ? "$" : "€",
      });
  }
  accounts.sort((a, b) => a.model.localeCompare(b.model, "fr") || a.platform.localeCompare(b.platform, "fr"));
  catCache = { at: Date.now(), v: { models, platforms, accounts, platName } };
  return catCache.v;
}

// « Kéoni 🌙 (Matin) » -> « keoni »
const norm = (s) =>
  String(s || "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Trouve dans la liste le chatteur qui porte le même nom que le pseudo Discord
function matchIn(list, names) {
  for (const n of names.map(norm).filter(Boolean)) {
    const same = list.filter((c) => norm(c.name) === n);
    if (same.length === 1) return same[0];
    const first = list.filter((c) => norm(c.name).split(" ")[0] === n.split(" ")[0]);
    if (first.length === 1) return first[0];
  }
  return null;
}

// ---------- Lien compte Discord <-> chatteur de l'app ----------
// Relie (ou délie si cid est vide) : un compte Discord ne va qu'à un seul chatteur.
async function linkDiscord(uid, cid) {
  const list = await appChatters(true);
  for (const c of list)
    if (c.discordId === uid && c.id !== cid) await mergeDoc("chatters", c.id, { discordId: null });
  if (cid) await mergeDoc("chatters", cid, { discordId: uid });
  chattersCache.at = 0;
}

// Le chatteur de l'app relié à ce compte Discord. S'il n'y en a pas encore, on cherche un chatteur
// libre qui porte le même nom que le pseudo et on les relie (link = false : on cherche sans relier).
async function chatterOf(uid, names = [], link = true) {
  const list = await appChatters();
  const linked = list.find((c) => c.discordId === uid);
  if (linked) return linked;
  const c = matchIn(list.filter((x) => x.active && !x.discordId), names);
  if (c && link) await linkDiscord(uid, c.id);
  return c;
}

// Anciens liens /lien_app gardés dans data.json : recopiés une fois dans la fiche du chatteur
async function migrateLinks(appLinks = {}) {
  const list = await appChatters(true);
  let n = 0;
  for (const [uid, cid] of Object.entries(appLinks)) {
    const c = list.find((x) => x.id === cid);
    if (!c || c.discordId || list.some((x) => x.discordId === uid)) continue;
    await mergeDoc("chatters", cid, { discordId: uid });
    n++;
  }
  if (n) chattersCache.at = 0;
  return n;
}

// Membres du bot visibles dans l'app (Équipe › Comptes Discord)
async function publishMembers(members) {
  await putDoc("config", "discord", { members, at: Date.now() });
}

// ---------- Dates à l'heure de Paris ----------
function parisParts(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
// Instant (ms) correspondant à « date à hh:00, heure de Paris »
function parisMs(date, hour) {
  const [y, m, d] = date.split("-").map(Number);
  let t = Date.UTC(y, m - 1, d, hour);
  for (let k = 0; k < 2; k++) {
    const p = parisParts(t);
    t -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Date.UTC(y, m - 1, d, hour);
  }
  return t;
}
const addDays = (date, n) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

// Jour du planning auquel appartient un clock in : celui dont le début de shift est le plus proche
// (un clock in SOIR à 00h30 compte pour la veille, comme dans l'app).
function shiftDay(slot, t) {
  const today = parisParts(t).date;
  return [-1, 0, 1]
    .map((n) => addDays(today, n))
    .map((date) => ({ date, start: parisMs(date, START_OF[slot]) }))
    .sort((a, b) => Math.abs(t - a.start) - Math.abs(t - b.start))[0];
}
// Minutes de retard par rapport au début du shift
function lateness(slot, t) {
  const { date, start } = shiftDay(slot, t);
  const late = Math.max(0, Math.round((t - start) / 60000));
  return { date, start, late, isLate: late > RETARD_TOLERANCE };
}

// ---------- Planning et day off ----------
const planEntries = (doc) =>
  Object.entries(doc?.shifts || {})
    .filter(([, s]) => s && typeof s === "object" && s.chatterId && s.slot)
    .map(([sid, s]) => ({ sid, ...s }));
async function planOf(date) {
  return planEntries(await getDoc("plan", date));
}
// Planning de plusieurs jours d'un coup : { date: [entrées] }
async function plansBetween(from, to) {
  const rows = await rest("GET", `select=id,data&coll=eq.plan&id=gte.${enc(from)}&id=lte.${enc(to)}`);
  return Object.fromEntries(rows.map((r) => [r.id, planEntries(r.data)]));
}
async function offsOn(date) {
  const rows = await rest("GET", `select=data&coll=eq.offs&data->>date=eq.${enc(date)}`);
  return new Set(rows.map((r) => r.data?.chatterId).filter(Boolean));
}
// Day off entre deux dates (incluses), avec leur identifiant
async function offsBetween(from, to) {
  const rows = await rest("GET", `select=id,data&coll=eq.offs&data->>date=gte.${enc(from)}&data->>date=lte.${enc(to)}`);
  return rows.map((r) => ({ ...(r.data || {}), id: r.id })).filter((o) => o.chatterId && o.date);
}
async function dayOffQuota() {
  return Number((await getDoc("config", "settings"))?.dayOffQuota) || 3;
}
// Lundi = 0, comme les jours du shift habituel dans l'app
const weekday = (date) => (new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7;
const midsOf = (accts) => [...new Set((accts || []).map((k) => String(k).split("|")[0]).filter(Boolean))];
// Shift(s) et modèles d'un day off : ceux enregistrés avec lui, sinon le planning du jour, sinon le shift habituel
function offScope(chatter, date, off, plan) {
  if (off && Array.isArray(off.slots) && off.slots.length) return { slots: off.slots, accts: off.accts || [], mids: midsOf(off.accts) };
  const mine = (plan || []).filter((s) => s.chatterId === chatter?.id);
  if (mine.length) {
    const accts = [...new Set(mine.flatMap((s) => s.accts || []))];
    return { slots: [...new Set(mine.map((s) => s.slot))], accts, mids: midsOf(accts) };
  }
  const h = chatter?.shift;
  if (habSlots(h).length && (!Array.isArray(h.days) || h.days.includes(weekday(date))))
    return { slots: habSlots(h), accts: h.accts || [], mids: midsOf(h.accts) };
  return { slots: [], accts: [], mids: [] };
}
// Pose un day off avec les règles de l'agence : pas deux fois le même jour, `quota` par mois,
// et un seul chatteur off par shift le même jour, toutes modèles confondues. removeShifts : le retire du planning ce jour-là.
async function addOff({ cid, date, note = "", removeShifts = true, by = "discord", t = Date.now() }) {
  const month = date.slice(0, 7);
  const [chatters, plan, monthOffs, quota] = await Promise.all([appChatters(true), planOf(date), offsBetween(`${month}-01`, `${month}-31`), dayOffQuota()]);
  const byId = Object.fromEntries(chatters.map((c) => [c.id, c]));
  const c = byId[cid];
  if (!c) return { error: "unknown" };
  const mine = monthOffs.filter((o) => o.chatterId === cid);
  if (mine.some((o) => o.date === date)) return { error: "already", chatter: c };
  if (mine.length >= quota) return { error: "quota", chatter: c, quota, taken: mine.map((o) => o.date).sort() };
  const scope = offScope(c, date, null, plan);
  const clash = monthOffs
    .filter((o) => o.date === date && o.chatterId !== cid && byId[o.chatterId])
    .map((o) => ({ off: o, chatter: byId[o.chatterId], scope: offScope(byId[o.chatterId], date, o, plan) }))
    .find((x) => x.scope.slots.some((k) => scope.slots.includes(k)));
  if (clash) return { error: "conflict", chatter: c, scope, other: clash.chatter, otherScope: clash.scope };
  const id = newId();
  await putDoc("offs", id, { chatterId: cid, date, note, at: t, slots: scope.slots, accts: scope.accts, by });
  const removed = removeShifts ? plan.filter((s) => s.chatterId === cid) : [];
  if (removed.length) await writePlan(date, Object.fromEntries(removed.map((s) => [s.sid, null])));
  return { id, chatter: c, scope, removed: removed.length, count: mine.length + 1, quota };
}
// Chatteur viré : retiré du planning à partir de `from` (box comprises), day off à venir supprimés,
// inactif dans l'app sans shift habituel. Ses ventes, paies et pointages passés restent. dry : compte sans rien changer.
async function retireChatter(cid, from, { dry = false } = {}) {
  const rows = await rest("GET", `select=id,data&coll=eq.plan&id=gte.${enc(from)}`);
  let shifts = 0;
  const dates = [];
  for (const r of rows) {
    const patch = Object.fromEntries(Object.entries(r.data?.shifts || {}).filter(([, s]) => s?.chatterId === cid).map(([sid]) => [sid, null]));
    const n = Object.keys(patch).length;
    if (!n) continue;
    shifts += n;
    dates.push(r.id);
    if (!dry) await writePlan(r.id, patch);
  }
  const offs = (await offsBetween(from, "9999-12-31")).filter((o) => o.chatterId === cid);
  if (!dry) {
    for (const o of offs) await delDoc("offs", o.id);
    const tpl = await planTemplate();
    const mine = Object.keys(tpl || {}).filter((sid) => tpl[sid].chatterId === cid);
    if (mine.length) await mergeDoc("config", "planning", { shifts: Object.fromEntries(mine.map((sid) => [sid, null])), at: Date.now(), by: "discord" });
    await mergeDoc("chatters", cid, { active: false, shift: null });
    chattersCache.at = 0;
  }
  return { shifts, dates: dates.sort(), offs: offs.length };
}
// Chatteurs en coupure en ce moment (pas encore revenus)
async function openCoupures(t = Date.now()) {
  const today = parisParts(t).date;
  const [chatters, ...days] = await Promise.all([appChatters(), readMarks(addDays(today, -1)), readMarks(today)]);
  const byId = Object.fromEntries(chatters.map((c) => [c.id, c]));
  const open = days
    .flatMap((m, k) => Object.values(m).map((x) => ({ ...x, date: addDays(today, k - 1) })))
    .filter((m) => m?.status === "coupure" && m.cutAt && !m.cutEnd && byId[m.chatterId])
    .map((m) => ({ ...byId[m.chatterId], since: m.cutAt, slot: m.slot, date: m.date }))
    .sort((a, b) => a.since - b.since);
  // une seule ligne par chatteur : sa coupure la plus récente, celle que 🔙 termine (une d'hier jamais terminée
  // le mettait deux fois dans la liste, et Discord refusait d'ouvrir la fenêtre)
  return [...new Map(open.map((c) => [c.id, c])).values()].sort((a, b) => a.since - b.since);
}
// Tout ce qu'il faut pour afficher le planning d'un jour
async function planningDay(date) {
  const [doc, offs, chatters, cat, marks] = await Promise.all([getDoc("plan", date), offsOn(date), appChatters(), appCatalog(), readMarks(date)]);
  return { date, plan: planEntries(doc), nbox: doc?.nbox || {}, offs: [...offs], chatters, models: cat.models, platName: cat.platName, marks };
}
// Nombre de box réglé pour un shift et une modèle (depuis Discord) : plan/<date>.nbox { "soir|m-anna": 4 }
async function boxCounts(date) {
  return (await getDoc("plan", date))?.nbox || {};
}
async function setBoxCount(date, slot, mid, n) {
  await mergeDoc("plan", date, { date, nbox: { [`${slot}|${mid}`]: n } }, { date, shifts: {} });
}
// Identifiant d'une entrée du planning ou d'un day off (même format que l'app)
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
// Écrit des entrées du planning d'un jour : { sid: entrée } (null = supprimée), comme l'app ;
// nbox : le nombre de box par shift et modèle, écrit en même temps ({ "soir|m-anna": 4 })
// loud : le bot veut que le salon box en soit prévenu (sinon l'action qui écrit le dit elle-même)
async function writePlan(date, patch, nbox, { loud = false } = {}) {
  if (loud) await hooks.beforeLoud?.(date).catch(() => {});
  await mergeDoc("plan", date, { date, shifts: patch, ...(nbox && Object.keys(nbox).length ? { nbox } : {}) }, { date, shifts: {} });
  hooks.planWritten?.(date, patch, loud);
}
// Fourni par index.js : planWritten(date, patch, loud) après chaque écriture du planning par le bot,
// beforeLoud(date) juste avant une écriture à annoncer (pour avoir l'état d'avant)
const hooks = {};
// Shift prévu au planning pour ce chatteur à l'instant t : de 1 h 30 avant le début jusqu'à la fin du shift
// (6 h). Si deux shifts conviennent (double shift), celui qui commence le plus près de t.
async function plannedSlotAt(uid, names, t) {
  const c = await chatterOf(uid, names, false);
  if (!c) return null;
  const today = parisParts(t).date;
  const dates = [addDays(today, -1), today, addDays(today, 1)];
  const plans = await Promise.all(dates.map(planOf));
  const hits = [];
  dates.forEach((date, k) => {
    for (const s of plans[k].filter((p) => p.chatterId === c.id && START_OF[p.slot] != null)) {
      const start = parisMs(date, START_OF[s.slot]);
      if (t >= start - 90 * 60e3 && t < start + 6 * 3600e3) hits.push({ slot: s.slot, date, gap: Math.abs(t - start) });
    }
  });
  return hits.sort((a, b) => a.gap - b.gap)[0] || null;
}
// Comptes (modèle|plateforme) prévus au planning pour ce chatteur sur ce shift
async function plannedAccts(uid, names, shift, t) {
  const slot = SLOT_OF[shift];
  const c = slot && (await chatterOf(uid, names, false));
  if (!c) return [];
  const { date } = shiftDay(slot, t);
  const plan = await planOf(date);
  return [...new Set(plan.filter((s) => s.chatterId === c.id && s.slot === slot).flatMap((s) => s.accts || []))];
}

// Ce qui est prévu pour ce chatteur sur un shift d'un jour : ses comptes et ses box (toutes ses lignes réunies)
const boxesIn = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String);
async function plannedFor(uid, names, slot, date) {
  const c = await chatterOf(uid, names, false);
  if (!c) return null;
  const mine = (await planOf(date)).filter((s) => s.chatterId === c.id && s.slot === slot);
  const boxes = {};
  for (const s of mine) for (const mid of midsOf(s.accts)) boxes[mid] = [...new Set([...(boxes[mid] || []), ...boxesIn(s.boxes?.[mid])])];
  return { chatter: c, slot, date, accts: [...new Set(mine.flatMap((s) => s.accts || []))], boxes, planned: mine.length > 0 };
}

// ---------- Chatteurs créés ou modifiés depuis Discord ----------
// Comme Équipe dans l'app : nouveau chatteur = 10 %, payé en USDC, actif. Un ancien chatteur inactif du même
// nom est réactivé plutôt que recréé. Renvoie { id, created, reactivated } ou { error: "exists", chatter }.
async function saveChatter({ id, name, uid, shift }) {
  const list = await appChatters(true);
  name = String(name || "").trim().slice(0, 60);
  if (!id) {
    const same = list.find((c) => norm(c.name) === norm(name));
    if (same?.active) return { error: "exists", chatter: same };
    if (same) id = same.id;
  }
  const created = !id;
  if (created) {
    id = "c-" + newId();
    await putDoc("chatters", id, { name, rate: 10, method: "USDC", notes: "", active: true, shift });
  } else await mergeDoc("chatters", id, { ...(name ? { name } : {}), active: true, shift });
  if (uid !== undefined) await linkDiscord(uid, uid ? id : "");
  chattersCache.at = 0;
  return { id, created, reactivated: !created && !list.find((c) => c.id === id)?.active };
}
// Met le planning déjà fait d'aujourd'hui à la fin de la semaine prochaine sur son shift habituel (comme l'app),
// en gardant ses box sur les shifts et les modèles qui ne changent pas. Renvoie les jours modifiés.
// Avec le planning habituel de l'app (config/planning), c'est lui qui change, et les jours déjà faits suivent.
async function applyHabit(cid, shift, from) {
  const tpl = await planTemplate();
  if (tpl) return applyTemplate(cid, shift, from, tpl);
  const to = addDays(from, 13 - weekday(from));
  const [rows, offs] = await Promise.all([
    rest("GET", `select=id,data&coll=eq.plan&id=gte.${enc(from)}&id=lte.${enc(to)}`),
    offsBetween(from, to),
  ]);
  const plans = Object.fromEntries(rows.map((r) => [r.id, r.data?.shifts || {}]));
  const want = (date) => (shift && (!Array.isArray(shift.days) || shift.days.includes(weekday(date))) && !offs.some((o) => o.chatterId === cid && o.date === date) ? habSlots(shift) : []);
  const mids = midsOf(shift?.accts);
  const dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const mine = Object.entries(plans[d] || {}).filter(([, s]) => s?.chatterId === cid);
    const slots = want(d);
    const patch = {};
    const kept = new Set();
    for (const [sid, s] of mine) {
      if (!slots.includes(s.slot) || kept.has(s.slot)) {
        patch[sid] = null;
        continue;
      }
      kept.add(s.slot);
      const same = [...(s.accts || [])].sort().join() === [...(shift.accts || [])].sort().join();
      if (same) continue;
      const gone = Object.keys(s.boxes || {}).filter((m) => !mids.includes(m));
      patch[sid] = { accts: shift.accts || [], ...(gone.length ? { boxes: Object.fromEntries(gone.map((m) => [m, null])) } : {}) };
    }
    for (const slot of slots.filter((k) => !kept.has(k))) patch[newId() + slot.slice(0, 1)] = { slot, chatterId: cid, accts: shift.accts || [] };
    if (!Object.keys(patch).length) continue;
    await writePlan(d, patch);
    dates.push(d);
  }
  return dates;
}
// ---------- Planning habituel (config/planning) : le même tous les jours, fait dans l'app ----------
// Même forme qu'un jour ({ shifts: { sid: { slot, chatterId, accts, boxes } } }). Les jours encore vides se
// remplissent depuis lui (sans les inactifs ni les day off), chaque ligne gardant son id ; ce qu'on change sur
// Discord ne touche que le jour concerné.
async function planTemplate() {
  const d = await getDoc("config", "planning");
  return d ? Object.fromEntries(Object.entries(d.shifts || {}).filter(([, s]) => s && s.chatterId && s.slot)) : null;
}
const boxesOf = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String);
// Ligne complète à écrire sur un jour : les box qu'il n'a plus sont effacées (l'écriture est fusionnée)
const fullEntry = (a, cur) => {
  const e = { slot: a.slot, chatterId: a.chatterId, accts: a.accts || [] };
  const b = { ...(a.boxes || {}) };
  for (const m of Object.keys(cur?.boxes || {})) if (!(m in b)) b[m] = null;
  if (Object.keys(b).length) e.boxes = b;
  return e;
};
// Remplit les jours encore vides depuis le planning habituel. Renvoie les jours remplis.
async function fillDays(dates) {
  const tpl = await planTemplate();
  if (!tpl || !Object.keys(tpl).length || !dates.length) return [];
  const [chatters, plans, offs] = await Promise.all([appChatters(true), plansBetween(dates[0], dates.at(-1)), offsBetween(dates[0], dates.at(-1))]);
  const active = new Set(chatters.filter((c) => c.active).map((c) => c.id));
  const done = [];
  for (const date of dates) {
    if ((plans[date] || []).length) continue;
    const patch = {};
    for (const [sid, s] of Object.entries(tpl))
      if (active.has(s.chatterId) && !offs.some((o) => o.chatterId === s.chatterId && o.date === date)) patch[sid] = fullEntry(s);
    if (!Object.keys(patch).length) continue;
    await writePlan(date, patch);
    done.push(date);
  }
  return done;
}
// Son shift habituel changé depuis Discord : ses lignes du planning habituel (box gardées sur les modèles qu'il
// garde), puis les jours déjà faits. Renvoie les jours modifiés.
async function applyTemplate(cid, shift, from, tpl) {
  const slots = habSlots(shift);
  const accts = shift?.accts || [];
  const mids = midsOf(accts);
  const cur = Object.entries(tpl).filter(([, s]) => s.chatterId === cid).map(([sid, s]) => ({ sid, ...s }));
  const before = {};
  const after = {};
  for (const s of cur.filter((x) => !slots.includes(x.slot))) [before[s.sid], after[s.sid]] = [s, null];
  for (const slot of slots) {
    const old = cur.find((s) => s.slot === slot);
    if (old && [...(old.accts || [])].sort().join() === [...accts].sort().join()) continue;
    const boxes = Object.fromEntries(Object.entries(old?.boxes || {}).filter(([m, v]) => mids.includes(m) && boxesOf(v).length));
    const sid = old ? old.sid : newId() + slot.slice(0, 1);
    if (old) before[sid] = old;
    after[sid] = { slot, chatterId: cid, accts, ...(Object.keys(boxes).length ? { boxes } : {}) };
  }
  if (!Object.keys(after).length) return [];
  const patch = Object.fromEntries(Object.entries(after).map(([sid, a]) => [sid, a && fullEntry(a, before[sid])]));
  await mergeDoc("config", "planning", { shifts: patch, at: Date.now(), by: "discord" }, { shifts: {} });
  return spreadTemplate(after, before, from);
}
// Lignes changées du planning habituel reportées sur les jours déjà faits : les shifts pas encore commencés
// d'aujourd'hui et les jours suivants (comme l'app). Une box donnée est retirée aux autres de ce shift.
async function spreadTemplate(after, before, from) {
  const now = Date.now();
  const [rows, offs] = await Promise.all([rest("GET", `select=id,data&coll=eq.plan&id=gte.${enc(from)}`), offsBetween(from, "9999-12-31")]);
  const dates = [];
  for (const r of rows.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const date = r.id;
    const day = planEntries(r.data);
    if (!day.length) continue;
    const patch = {};
    const used = new Set();
    const started = (slot) => now >= parisMs(date, START_OF[slot] ?? 0);
    for (const [sid, a] of Object.entries(after)) {
      const b = before[sid];
      const cid = (a || b).chatterId;
      if (offs.some((o) => o.chatterId === cid && o.date === date)) continue;
      if ((b && started(b.slot)) || (a && started(a.slot))) continue;
      const find = (sl) => day.find((s) => !used.has(s.sid) && s.chatterId === cid && s.slot === sl && !(s.sid !== sid && s.sid in after));
      const cur = day.find((s) => s.sid === sid) || (b && find(b.slot)) || (a && find(a.slot));
      if (cur) used.add(cur.sid);
      if (!a) {
        if (cur) patch[cur.sid] = null;
        continue;
      }
      patch[cur ? cur.sid : sid] = fullEntry(a, cur);
      for (const [m, v] of Object.entries(a.boxes || {})) {
        const nums = boxesOf(v).filter((k) => /^\d+$/.test(k));
        if (!nums.length) continue;
        for (const x of day.filter((s) => s.slot === a.slot && s.chatterId !== cid && patch[s.sid] !== null)) {
          const p = patch[x.sid];
          const had = boxesOf(p?.boxes && m in p.boxes ? p.boxes[m] : x.boxes?.[m]);
          const left = had.filter((k) => !nums.includes(k));
          if (left.length < had.length) patch[x.sid] = { ...(p || {}), boxes: { ...(p?.boxes || {}), [m]: left.length ? left : null } };
        }
      }
    }
    if (!Object.keys(patch).length) continue;
    await writePlan(date, patch);
    dates.push(date);
  }
  return dates;
}
// Nombre de chatteurs au planning de chaque jour d'une période : { date: n }
async function planCounts(from, to) {
  const rows = await rest("GET", `select=id,data&coll=eq.plan&id=gte.${enc(from)}&id=lte.${enc(to)}`);
  return Object.fromEntries(rows.map((r) => [r.id, new Set(Object.values(r.data?.shifts || {}).filter((x) => x?.chatterId).map((x) => x.chatterId)).size]));
}
// Chatteurs au planning par jour et par shift : { date: { matin: 2, soir: 3, all: 5 } }
async function slotCounts(from, to) {
  const rows = await rest("GET", `select=id,data&coll=eq.plan&id=gte.${enc(from)}&id=lte.${enc(to)}`);
  return Object.fromEntries(
    rows.map((r) => {
      const l = planEntries(r.data);
      const n = (f) => new Set(l.filter(f).map((x) => x.chatterId)).size;
      return [r.id, { all: n(() => true), ...Object.fromEntries(Object.keys(START_OF).map((k) => [k, n((x) => x.slot === k)])) }];
    })
  );
}
// Copie le planning d'un jour sur un autre (box comprises), sans ceux qui sont en day off ce jour-là ni les
// inactifs. replace : enlève d'abord le planning du jour ; sinon ajoute seulement les lignes qui manquent.
async function copyPlan(from, to, { replace = true } = {}) {
  const [src, dst, offs, chatters] = await Promise.all([planOf(from), planOf(to), offsOn(to), appChatters(true)]);
  const active = new Set(chatters.filter((c) => c.active).map((c) => c.id));
  const patch = {};
  if (replace) for (const s of dst) patch[s.sid] = null;
  const has = (s) => !replace && dst.some((x) => x.chatterId === s.chatterId && x.slot === s.slot);
  let added = 0, skipped = 0;
  for (const s of src) {
    if (!active.has(s.chatterId) || offs.has(s.chatterId)) {
      skipped++;
      continue;
    }
    if (has(s)) continue;
    // box vides (null) pas recopiées
    const boxes = Object.fromEntries(Object.entries(s.boxes || {}).filter(([, v]) => (Array.isArray(v) ? v.length : v)));
    patch[newId() + added] = { slot: s.slot, chatterId: s.chatterId, accts: s.accts || [], ...(Object.keys(boxes).length ? { boxes } : {}) };
    added++;
  }
  if (Object.keys(patch).length) await writePlan(to, patch);
  return { added, skipped, removed: replace ? dst.length : 0 };
}

// ---------- Pénalités (saisies à la main depuis Discord, montants en euros) ----------
async function penaltiesIn(month) {
  const rows = await rest("GET", `select=id,data&coll=eq.penalties&data->>month=eq.${enc(month)}`);
  return rows.map((r) => ({ ...(r.data || {}), id: r.id })).filter((p) => p.uid && p.fault);
}
const addPenalty = ({ id, ...p }) => putDoc("penalties", id, p);
const delPenalty = (id) => delDoc("penalties", id);

// ---------- Pointage ----------
const markKey = (slot, cid) => `${slot}_${cid}`;
async function readMarks(date) {
  return (await getDoc("att", date))?.marks || {};
}
async function writeMark(date, key, mark) {
  await mergeDoc("att", date, { date, marks: { [key]: mark } }, { date, marks: {} });
}
const presentMark = (chatterId, slot, t, late, prev) => {
  const r = late > RETARD_TOLERANCE;
  return {
    chatterId, slot, status: r ? "retard" : "present", min: r ? late : "",
    note: prev?.note || "", in: t, out: null, at: Date.now(), src: "discord", auto: null,
  };
};

async function onClockIn({ uid, names, shift, t }) {
  if (!enabled()) return { skipped: "off" };
  const slot = SLOT_OF[shift];
  if (!slot) return { skipped: "shift" };
  const c = await chatterOf(uid, names);
  if (!c) return { skipped: "unlinked" };
  const { date, late } = lateness(slot, t);
  const key = markKey(slot, c.id);
  const prev = (await readMarks(date))[key];
  // un pointage déjà fait à la main dans l'app n'est jamais écrasé (un absent posé par le bot, si),
  // ni une coupure notée avec /coupure (le chatteur qui revient après une coupure reste en coupure)
  if (prev?.status && (prev.src !== "discord" || prev.status === "coupure")) return { chatterId: c.id, name: c.name, date, slot, key, late, written: false };
  await writeMark(date, key, presentMark(c.id, slot, t, late, prev));
  return { chatterId: c.id, name: c.name, date, slot, key, late, written: true };
}

async function onClockOut({ app, t }) {
  if (!enabled() || !app?.key) return;
  // le shift du clock in, puis ceux couverts par le même clock in (double shift)
  for (const x of [{ date: app.date, key: app.key }, ...(app.extra || [])]) {
    const prev = (await readMarks(x.date))[x.key];
    if (prev) await writeMark(x.date, x.key, { out: t });
  }
}

// Double shift : un chatteur encore clock in au début d'un autre shift prévu pour lui ce jour-là est
// présent sur ce shift aussi (arrivée = son clock in), sans avoir à refaire clock in.
// sessions : [{ uid, cid, t }] = clock in en cours. Renvoie les pointages écrits.
const coversSlot = (t, out, start) => t < start && start - t < 12 * 3600e3 && (out == null || out >= start + 30 * 60e3);
async function coverShifts({ sessions, now = Date.now() }) {
  if (!enabled() || !sessions.length) return [];
  const today = parisParts(now).date;
  const dates = [addDays(today, -1), today];
  const [plans, offs] = await Promise.all([Promise.all(dates.map(planOf)), Promise.all(dates.map(offsOn))]);
  const done = [];
  for (const [k, date] of dates.entries()) {
    let marks = null;
    for (const p of plans[k]) {
      const start = parisMs(date, START_OF[p.slot]);
      if (start > now || offs[k].has(p.chatterId)) continue;
      const s = sessions.find((x) => x.cid === p.chatterId && coversSlot(x.t, null, start));
      if (!s) continue;
      marks ||= await readMarks(date);
      const key = markKey(p.slot, p.chatterId);
      const prev = marks[key];
      // déjà pointé (sauf l'absent mis tout seul par le bot)
      if (prev?.status && !(prev.src === "discord" && prev.auto)) continue;
      const mark = presentMark(p.chatterId, p.slot, s.t, 0, prev);
      await writeMark(date, key, mark);
      marks[key] = mark;
      done.push({ uid: s.uid, cid: p.chatterId, date, slot: p.slot, key });
    }
  }
  return done;
}

// Coupure notée par un admin (/coupure) : statut « Coupure » dans le pointage de l'app, en gardant
// les heures de clock in / out déjà enregistrées
async function markCoupure({ uid, cid, names, slot, date, min, note, t = Date.now() }) {
  if (!enabled()) return { skipped: "off" };
  const c = cid ? (await appChatters()).find((x) => x.id === cid) : await chatterOf(uid, names);
  if (!c) return { skipped: "unlinked" };
  const key = markKey(slot, c.id);
  const prev = (await readMarks(date))[key];
  // cutAt : début de la coupure en cours ; le temps réel est calculé au retour (endCoupure).
  // Déjà en coupure (ex. noté puis remplacé) : on garde l'heure de départ.
  const going = prev?.status === "coupure" && prev.cutAt && !prev.cutEnd;
  const patch = { chatterId: c.id, slot, status: "coupure", min: min || (going ? prev.min : prev?.cutDone) || "", at: t, src: "discord", auto: null, cutAt: going ? prev.cutAt : t, cutEnd: null };
  if (note) patch.note = note;
  await writeMark(date, key, patch);
  return { chatterId: c.id, name: c.name, date, slot, key };
}
// Retour de coupure : temps de coupure réel (ajouté aux coupures précédentes du même shift), comme un retard
async function endCoupure({ uid, cid, names, t = Date.now() }) {
  if (!enabled()) return { skipped: "off" };
  const c = cid ? (await appChatters()).find((x) => x.id === cid) : await chatterOf(uid, names);
  if (!c) return { skipped: "unlinked" };
  const today = parisParts(t).date;
  const found = [];
  for (const date of [addDays(today, -1), today])
    for (const [key, m] of Object.entries(await readMarks(date)))
      if (m?.chatterId === c.id && m.status === "coupure" && m.cutAt && !m.cutEnd && m.cutAt <= t) found.push({ date, key, m });
  const cur = found.sort((a, b) => b.m.cutAt - a.m.cutAt)[0];
  if (!cur) return { chatterId: c.id, name: c.name, discordId: c.discordId, notCut: true };
  const took = Math.max(1, Math.round((t - cur.m.cutAt) / 60000));
  const total = (Number(cur.m.cutDone) || 0) + took;
  await writeMark(cur.date, cur.key, { min: total, cutDone: total, cutEnd: t, at: t });
  return { chatterId: c.id, name: c.name, discordId: c.discordId, date: cur.date, slot: cur.m.slot, key: cur.key, took, total, since: cur.m.cutAt };
}

// Pointage posé à la main par un admin depuis Discord (comme dans l'app : jamais écrasé par le bot)
async function setMark(date, slot, cid, patch, t = Date.now()) {
  await writeMark(date, markKey(slot, cid), { chatterId: cid, slot, ...patch, at: t, src: "discord-admin", auto: null });
}
// Effectif d'un shift : chatteurs prévus au planning de l'app, avec leur day off et leur pointage
async function slotStaff(date, slot) {
  const [plan, marks, offs, chatters] = await Promise.all([planOf(date), readMarks(date), offsOn(date), appChatters(true)]);
  const byId = Object.fromEntries(chatters.map((c) => [c.id, c]));
  const mine = plan.filter((p) => p.slot === slot && byId[p.chatterId] && byId[p.chatterId].active !== false);
  const ids = [...new Set(mine.map((p) => p.chatterId))];
  // ses comptes et ses box sur ce shift : { modèle: [box] }
  const boxesOf = (id) => {
    const out = {};
    for (const p of mine.filter((x) => x.chatterId === id))
      for (const mid of new Set((p.accts || []).map((k) => k.split("|")[0]))) {
        const v = p.boxes?.[mid];
        out[mid] = [...new Set([...(out[mid] || []), ...(Array.isArray(v) ? v : v ? [v] : []).map(String)])];
      }
    return out;
  };
  return ids.map((id) => ({ ...byId[id], off: offs.has(id), mark: marks[markKey(slot, id)] || null, boxes: boxesOf(id) }));
}

// Absents automatiques : chatteur prévu au planning, relié à Discord, pas en day off, sans pointage
// ABSENT_AFTER_H heures après le début de son shift. clockIns : les clock in vus par le bot, pour
// rattraper un pointage qui n'aurait pas pu s'écrire au moment du clock in.
async function sweepAbsents({ now = Date.now(), clockIns = [] } = {}) {
  if (!enabled() || !(ABSENT_AFTER_H > 0)) return [];
  const today = parisParts(now).date;
  const due = [];
  for (const date of [addDays(today, -1), today])
    for (const slot of Object.keys(START_OF)) {
      const start = parisMs(date, START_OF[slot]);
      if (now >= start + ABSENT_AFTER_H * 3600e3 && now < start + 20 * 3600e3) due.push({ date, slot });
    }
  if (!due.length) return [];
  const byId = Object.fromEntries((await appChatters()).map((c) => [c.id, c]));
  const done = [];
  for (const date of [...new Set(due.map((x) => x.date))]) {
    const [plan, marks, offs] = await Promise.all([planOf(date), readMarks(date), offsOn(date)]);
    for (const { slot } of due.filter((x) => x.date === date))
      for (const s of plan.filter((p) => p.slot === slot)) {
        const c = byId[s.chatterId];
        const key = c && markKey(slot, c.id);
        if (!c || !c.active || !c.discordId || marks[key]?.status || offs.has(c.id)) continue;
        const ci = clockIns.find((x) => x.uid === c.discordId && SLOT_OF[x.shift] === slot && shiftDay(slot, x.t).date === date);
        // double shift : clock in fait avant ce shift et encore là au début
        const cover = !ci && clockIns.find((x) => x.uid === c.discordId && coversSlot(x.t, x.out, parisMs(date, START_OF[slot])));
        const mark = ci
          ? presentMark(c.id, slot, ci.t, lateness(slot, ci.t).late, null)
          : cover
            ? presentMark(c.id, slot, cover.t, 0, null)
            : { chatterId: c.id, slot, status: "absent", min: "", note: "", at: now, src: "discord", auto: true };
        await writeMark(date, key, mark);
        marks[key] = mark;
        done.push({ date, slot, chatterId: c.id, name: c.name, status: mark.status });
      }
  }
  return done;
}

// ---------- Mémoire du bot (data.json) gardée aussi dans l'app ----------
// Sans volume Railway, data.json repart à zéro à chaque redéploiement (clock in en cours, admins, messages suivis…) :
// une copie est gardée dans docs (bot/state) et relue au démarrage.
async function loadBotState() {
  return getDoc("bot", "state");
}
async function saveBotState(state) {
  await putDoc("bot", "state", state);
}
// Clock in Discord encore en cours d'après le pointage de l'app (arrivée notée, pas de départ), pour retrouver
// ceux qui étaient clock in si le bot a redémarré sans sa mémoire. within : clock in de moins de 14 h.
async function openClockIns(t = Date.now(), within = 14 * 3600e3) {
  const today = parisParts(t).date;
  const dates = [addDays(today, -1), today];
  const [chatters, ...days] = await Promise.all([appChatters(true), ...dates.map(readMarks)]);
  const byId = Object.fromEntries(chatters.map((c) => [c.id, c]));
  const out = [];
  days.forEach((marks, k) => {
    for (const [key, m] of Object.entries(marks)) {
      const c = byId[m?.chatterId];
      if (!c?.discordId || m.src !== "discord" || !["present", "retard", "coupure"].includes(m.status)) continue;
      if (!m.in || m.out || t - m.in > within || m.in > t) continue;
      out.push({ uid: c.discordId, cid: c.id, date: dates[k], key, slot: m.slot, in: m.in });
    }
  });
  return out.sort((a, b) => a.in - b.in);
}

// ---------- Envoi du planning demandé depuis l'app ----------
async function pendingPost() {
  const d = await getDoc("config", "discordPost");
  return d && d.status === "pending" && d.date ? d : null;
}
// Ne remplace la demande que si l'app n'en a pas fait une nouvelle entre-temps
async function finishPost(req, patch) {
  await rest("PATCH", `coll=eq.config&id=eq.discordPost&data->>at=eq.${enc(String(req.at))}`, {
    data: { ...req, ...patch }, updated_at: new Date().toISOString(),
  });
}

module.exports = {
  enabled, RETARD_TOLERANCE, ABSENT_AFTER_H, SLOT_OF, START_OF,
  appChatters, appCatalog, chatterOf, boxCounts, setBoxCount, linkDiscord, migrateLinks, publishMembers, habSlots, habitOf, saveChatter, applyHabit, copyPlan, planCounts, slotCounts, plannedFor,
  onClockIn, onClockOut, sweepAbsents, coverShifts, coversSlot, markCoupure, endCoupure, setMark, slotStaff, lateness, shiftDay,
  planningDay, planOf, plansBetween, writePlan, planTemplate, fillDays, hooks, plannedSlotAt, plannedAccts, pendingPost, finishPost,
  offsBetween, offScope, addOff, delDoc, dayOffQuota, readMarks, newId, retireChatter, openCoupures, penaltiesIn, addPenalty, delPenalty,
  loadBotState, saveBotState, openClockIns,
  norm, parisParts, parisMs, addDays,
};
