// ================== LIEN AVEC L'APP KL ==================
// Le bot lit et écrit la table Supabase « docs » de l'app :
//  - Pointage (att/<date>) : présent ou retard au clock in, heure de départ au clock out,
//    absent si le chatteur n'a pas clock in ABSENT_AFTER_H heures après le début de son shift
//  - Équipe (chatters/<id>.discordId) : quel compte Discord correspond à quel chatteur
//  - config/discord : les membres du bot, pour pouvoir les relier depuis l'app
//  - Planning (plan/<date>) : pour l'envoyer dans le salon planning
//  - config/discordPost : demande d'envoi du planning faite depuis l'app
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
    }))
    .filter((c) => c.name);
  chattersCache = { at: Date.now(), list };
  return list;
}

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
async function planOf(date) {
  const doc = await getDoc("plan", date);
  return Object.entries(doc?.shifts || {})
    .filter(([, s]) => s && typeof s === "object" && s.chatterId && s.slot)
    .map(([sid, s]) => ({ sid, ...s }));
}
async function offsOn(date) {
  const rows = await rest("GET", `select=data&coll=eq.offs&data->>date=eq.${enc(date)}`);
  return new Set(rows.map((r) => r.data?.chatterId).filter(Boolean));
}
// Tout ce qu'il faut pour afficher le planning d'un jour
async function planningDay(date) {
  const [plan, offs, chatters, cat] = await Promise.all([planOf(date), offsOn(date), appChatters(), appCatalog()]);
  return { date, plan, offs: [...offs], chatters, models: cat.models, platName: cat.platName };
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
  const prev = (await readMarks(app.date))[app.key];
  if (prev) await writeMark(app.date, app.key, { out: t });
}

// Coupure notée par un admin (/coupure) : statut « Coupure » dans le pointage de l'app, en gardant
// les heures de clock in / out déjà enregistrées
async function markCoupure({ uid, names, slot, date, min, note, t = Date.now() }) {
  if (!enabled()) return { skipped: "off" };
  const c = await chatterOf(uid, names);
  if (!c) return { skipped: "unlinked" };
  const key = markKey(slot, c.id);
  const patch = { chatterId: c.id, slot, status: "coupure", min: min || "", at: t, src: "discord", auto: null };
  if (note) patch.note = note;
  await writeMark(date, key, patch);
  return { chatterId: c.id, name: c.name, date, slot, key };
}

// Effectif d'un shift : chatteurs prévus au planning de l'app, avec leur day off et leur pointage
async function slotStaff(date, slot) {
  const [plan, marks, offs, chatters] = await Promise.all([planOf(date), readMarks(date), offsOn(date), appChatters(true)]);
  const byId = Object.fromEntries(chatters.map((c) => [c.id, c]));
  const ids = [...new Set(plan.filter((p) => p.slot === slot && byId[p.chatterId] && byId[p.chatterId].active !== false).map((p) => p.chatterId))];
  return ids.map((id) => ({ ...byId[id], off: offs.has(id), mark: marks[markKey(slot, id)] || null }));
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
        const mark = ci
          ? presentMark(c.id, slot, ci.t, lateness(slot, ci.t).late, null)
          : { chatterId: c.id, slot, status: "absent", min: "", note: "", at: now, src: "discord", auto: true };
        await writeMark(date, key, mark);
        marks[key] = mark;
        done.push({ date, slot, chatterId: c.id, name: c.name, status: mark.status });
      }
  }
  return done;
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
  appChatters, appCatalog, chatterOf, linkDiscord, migrateLinks, publishMembers,
  onClockIn, onClockOut, sweepAbsents, markCoupure, slotStaff, lateness, shiftDay,
  planningDay, plannedAccts, pendingPost, finishPost,
  norm, parisParts, parisMs, addDays,
};
