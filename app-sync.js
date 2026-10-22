// ================== LIEN AVEC L'APP KL (onglet Pointage) ==================
// Chaque clock in écrit le pointage du chatteur dans l'app (table Supabase « docs »),
// chaque clock out y ajoute l'heure de départ. Désactivé tant que SUPABASE_URL et
// SUPABASE_SERVICE_KEY ne sont pas renseignés dans Railway.
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_KEY || "").trim();
const RETARD_TOLERANCE = Number(process.env.RETARD_TOLERANCE_MIN || 5); // minutes
const TZ = "Europe/Paris";

// Shifts du bot -> créneaux de l'app (heure de début, heure de Paris)
const SLOT_OF = { MATIN: "matin", APREM: "aprem", SOIR: "soir", NUIT: "nuit" };
const START_OF = { matin: 8, aprem: 14, soir: 20, nuit: 2 };

const enabled = () => !!(SUPABASE_URL && SUPABASE_KEY);

async function rest(method, query, body, prefer) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/docs?${query}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      // ancienne clé service_role (JWT) : aussi en Bearer ; nouvelle clé sb_secret_… : apikey suffit
      ...(SUPABASE_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${SUPABASE_KEY}` } : {}),
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${res.status}: ${await res.text()}`);
  return res.status === 204 || method !== "GET" ? null : res.json();
}
const enc = encodeURIComponent;
async function getDoc(coll, id) {
  const rows = await rest("GET", `select=data&coll=eq.${enc(coll)}&id=eq.${enc(id)}`);
  return rows[0]?.data || null;
}
async function putDoc(coll, id, data) {
  await rest("POST", "", [{ coll, id, data, updated_at: new Date().toISOString() }], "resolution=merge-duplicates");
}

// ---------- Chatteurs de l'app (cache 5 min) ----------
let chattersCache = { at: 0, list: [] };
async function appChatters() {
  if (Date.now() - chattersCache.at < 300e3) return chattersCache.list;
  const rows = await rest("GET", "select=id,data&coll=eq.chatters");
  const list = rows
    .map((r) => ({ id: r.id, name: r.data?.name || "", active: r.data?.active !== false }))
    .filter((c) => c.name);
  chattersCache = { at: Date.now(), list };
  return list;
}

// « Kéoni 🌙 (Matin) » -> « keoni »
const norm = (s) =>
  String(s || "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Trouve le chatteur de l'app qui porte le même nom que le pseudo Discord
async function matchChatter(names) {
  const list = (await appChatters()).filter((c) => c.active);
  for (const n of names.map(norm).filter(Boolean)) {
    const same = list.filter((c) => norm(c.name) === n);
    if (same.length === 1) return same[0];
    const first = list.filter((c) => norm(c.name).split(" ")[0] === n.split(" ")[0]);
    if (first.length === 1) return first[0];
  }
  return null;
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

// Écrit une marque dans att/<date> en relisant le document juste avant (les autres marques restent).
async function patchMark(date, key, fn) {
  const doc = (await getDoc("att", date)) || { date, marks: {} };
  const marks = doc.marks || {};
  const next = fn(marks[key]);
  if (!next) return null;
  await putDoc("att", date, { ...doc, date, marks: { ...marks, [key]: next } });
  return next;
}

// ---------- API pour index.js ----------
// links : data.appLinks (userId Discord -> id du chatteur dans l'app)
async function onClockIn({ links, uid, names, shift, t }) {
  if (!enabled()) return { skipped: "off" };
  const slot = SLOT_OF[shift];
  if (!slot) return { skipped: "shift" };
  let chatterId = links[uid];
  if (!chatterId) {
    const c = await matchChatter(names);
    if (!c) return { skipped: "unlinked" };
    chatterId = links[uid] = c.id;
  }
  const { date, start } = shiftDay(slot, t);
  const late = Math.max(0, Math.round((t - start) / 60000));
  const key = `${slot}_${chatterId}`;
  const mark = await patchMark(date, key, (prev) => {
    // un pointage déjà fait à la main dans l'app n'est jamais écrasé
    if (prev?.status && prev.src !== "discord") return null;
    return {
      chatterId, slot,
      status: late > RETARD_TOLERANCE ? "retard" : "present",
      min: late > RETARD_TOLERANCE ? late : "",
      note: prev?.note || "",
      in: t, at: Date.now(), src: "discord",
    };
  });
  return { chatterId, date, slot, key, written: !!mark, late };
}

async function onClockOut({ app, t }) {
  if (!enabled() || !app?.key) return;
  await patchMark(app.date, app.key, (prev) => (prev ? { ...prev, out: t } : null));
}

module.exports = { enabled, appChatters, onClockIn, onClockOut, shiftDay, norm, parisParts };
