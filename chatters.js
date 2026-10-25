// ================== CHATTEURS (panneau du salon gestion) ==================
// 👥 Chatteurs : la liste par shift habituel, ➕ Nouveau chatteur et ✏️ Modifier : son compte Discord,
// un ou deux shifts (double shift), ses modèles et ses jours. Tout est enregistré dans l'app (Équipe), et le
// planning déjà fait d'aujourd'hui à la fin de la semaine prochaine suit si on le laisse coché (comme dans l'app).
const { StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonStyle } = require("discord.js");
const appSync = require("./app-sync");
const planning = require("./planning");
const { reply, done, showView, row, button, opt, selectMenus, EPHEMERAL } = require("./ui");
const { SLOTS, withEmoji } = planning;

// Fourni par index.js : isAdmin(i), getData(), saveData(), publishMembers(), remember(user, member), refresh(date), SHIFT_OF_SLOT
const ctx = {};
const states = new Map(); // userId -> { view, cid, d: brouillon, orig, note }

const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const today = () => appSync.parisParts(Date.now()).date;
const slotOf = (k) => SLOTS.find((s) => s.k === k) || { k, l: k, emoji: "" };
const byName = (a, b) => a.name.localeCompare(b.name, "fr");
// « Amour 🍑 (Soir) » -> « Amour »
const cleanName = (s) => String(s || "").replace(/\(.*?\)|\[.*?\]/g, " ").replace(/[^\p{L}\p{N}' .-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
const midsOf = (accts) => [...new Set((accts || []).map((k) => k.split("|")[0]))];
const daysTxt = (days) => (!days?.length || days.length === 7 ? "tous les jours" : days.map((i) => DAYS[i]).join(" "));
const slotsTxt = (slots) => (slots.length ? slots.map((k) => `${slotOf(k).emoji} ${slotOf(k).l}`).join(" + ") + (slots.length > 1 ? " (double shift)" : "") : "aucun");

// ---------- La liste ----------
async function homeView(st) {
  const [list, cat] = await Promise.all([appSync.appChatters(true), appSync.appCatalog()]);
  const act = list.filter((c) => c.active).sort(byName);
  const mods = (c) => midsOf(c.shift?.accts).map((m) => withEmoji(cat.models[m]?.name || m)).join(" + ");
  const who = (c) => (c.discordId ? `<@${c.discordId}>` : `**${c.name}** ⚠️`);
  const lines = [];
  for (const sl of SLOTS) {
    const l = act.filter((c) => appSync.habSlots(c.shift).includes(sl.k));
    if (!l.length) continue;
    lines.push(`${lines.length ? "\n" : ""}**${sl.emoji} ${sl.l.toUpperCase()}** · ${l.length}`);
    for (const c of l) {
      const h = c.shift || {};
      lines.push([who(c), mods(c), appSync.habSlots(h).length > 1 ? "double" : "", h.days?.length && h.days.length < 7 ? daysTxt(h.days) : ""].filter(Boolean).join(" · "));
    }
  }
  const none = act.filter((c) => !appSync.habSlots(c.shift).length);
  if (none.length) lines.push(`${lines.length ? "\n" : ""}**Sans shift habituel** · ${none.length}`, none.map(who).join(" · "));
  return {
    content: st.note || "",
    embeds: [
      {
        title: `👥 Chatteurs · ${act.length}`,
        color: 0x5bae8c,
        description: lines.join("\n").slice(0, 4000) || "_Aucun chatteur dans l'app : ➕ pour en ajouter un._",
        footer: { text: "⚠️ = pas relié à un compte Discord · enregistré dans l'app (Équipe)" },
      },
    ],
    components: [
      ...selectMenus(
        "cm_pick",
        act.map((c) => opt(c.name, c.id, [appSync.habSlots(c.shift).map((k) => slotOf(k).l).join(" + "), mods(c)].filter(Boolean).join(" · ") || "Sans shift habituel", slotOf(appSync.habSlots(c.shift)[0]).emoji || "👤")),
        { placeholder: "✏️ Modifier un chatteur…", max: 2 }
      ),
      row(button("cm_new", "Nouveau chatteur", "➕", ButtonStyle.Success), button("cm_x", "Fermer", null, ButtonStyle.Secondary)),
    ],
  };
}

// ---------- Un chatteur (nouveau ou existant) ----------
async function editView(st) {
  const cat = await appSync.appCatalog();
  const d = st.d;
  const accts = cat.accounts.slice(0, 25);
  const acctName = (k) => {
    const a = cat.accounts.find((x) => x.key === k);
    return a ? `${withEmoji(a.model)} ${a.platform}` : k;
  };
  const isNew = !st.cid;
  const user = new UserSelectMenuBuilder().setCustomId("cm_u").setPlaceholder("Son compte Discord").setMinValues(0).setMaxValues(1);
  if (d.uid) user.setDefaultUsers(d.uid);
  return {
    content: [
      st.note,
      isNew ? "➕ **Nouveau chatteur**" : `✏️ **${st.orig.name}**`,
      `Nom : **${d.name || "—"}** · Discord : ${d.uid ? `<@${d.uid}>` : "pas relié"}`,
      `Shift : **${slotsTxt(d.slots)}** · ${daysTxt(d.days)}`,
      `Modèles : ${d.accts.length ? d.accts.map(acctName).map((x) => `**${x}**`).join(", ") : "aucune"}`,
      d.apply ? "-# 📅 Le planning déjà fait (d'aujourd'hui à la fin de la semaine prochaine) suit ces shifts et ces modèles ; ses box restent." : "-# 📅 Le planning déjà fait ne bouge pas.",
    ].filter(Boolean).join("\n"),
    components: [
      row(user),
      row(
        new StringSelectMenuBuilder()
          .setCustomId("cm_s")
          .setPlaceholder("Son shift (deux = double shift)")
          .setMinValues(0)
          .setMaxValues(2)
          .addOptions(SLOTS.map((s) => opt(`${s.l} (${s.h})`, s.k, null, s.emoji, d.slots.includes(s.k))))
      ),
      row(
        accts.length
          ? new StringSelectMenuBuilder()
              .setCustomId("cm_a")
              .setPlaceholder("Ses modèles (une, deux ou plus)")
              .setMinValues(0)
              .setMaxValues(accts.length)
              .addOptions(accts.map((a) => opt(`${withEmoji(a.model)} · ${a.platform}`, a.key, null, null, d.accts.includes(a.key))))
          : new StringSelectMenuBuilder().setCustomId("cm_a").setPlaceholder("Aucune modèle dans l'app").setDisabled(true).addOptions(opt("—", "none"))
      ),
      row(
        new StringSelectMenuBuilder()
          .setCustomId("cm_d")
          .setPlaceholder("Ses jours")
          .setMinValues(1)
          .setMaxValues(7)
          .addOptions(DAYS.map((n, k) => opt(n, String(k), null, null, d.days.includes(k))))
      ),
      row(
        button("cm_ok", isNew ? "Créer" : "Enregistrer", "✅", ButtonStyle.Success, !d.name),
        button("cm_nm", "Nom…", "✍️", ButtonStyle.Secondary),
        button("cm_ap", d.apply ? "Planning : suit" : "Planning : ne bouge pas", "📅", d.apply ? ButtonStyle.Primary : ButtonStyle.Secondary),
        button("cm_back", "Retour", "↩️", ButtonStyle.Secondary)
      ),
    ],
  };
}
const draftOf = (c) => ({
  name: c?.name || "",
  uid: c?.discordId || "",
  slots: appSync.habSlots(c?.shift),
  accts: [...(c?.shift?.accts || [])],
  days: c?.shift?.days?.length ? [...c.shift.days] : [...ALL_DAYS],
  apply: true,
});
const render = async (i, st) => showView(i, await (st.view === "home" ? homeView(st) : editView(st)));

// ---------- Enregistrer ----------
async function save(st) {
  const d = st.d;
  if (!d.name) return { note: "✍️ Donne-lui un nom." };
  if (d.slots.length && !d.accts.length) return { note: "⚠️ Choisis au moins une modèle pour son shift." };
  const shift = appSync.habitOf(d.slots, d.accts, d.days);
  const r = await appSync.saveChatter({ id: st.cid, name: d.name, uid: d.uid !== st.orig.uid ? d.uid : undefined, shift });
  if (r.error === "exists") return { note: `⚠️ **${r.chatter.name}** existe déjà dans l'app : choisis-le dans la liste pour le modifier.` };
  // côté bot : son shift (le premier) pour le clocking, et le nom de son compte
  const data = ctx.getData();
  if (st.orig.uid && st.orig.uid !== d.uid) delete data.chatteurs[st.orig.uid];
  if (d.uid && d.slots.length) data.chatteurs[d.uid] = ctx.SHIFT_OF_SLOT[d.slots[0]];
  ctx.saveData();
  ctx.publishMembers?.();
  let dates = [];
  if (d.apply) {
    dates = await appSync.applyHabit(r.id, shift, today());
    dates.forEach((x) => ctx.refresh?.(x));
  }
  const what = [slotsTxt(d.slots), d.uid ? `relié à <@${d.uid}>` : "pas relié à Discord"].join(" · ");
  const verb = r.created ? "créé" : r.reactivated ? "réactivé" : "enregistré";
  return {
    ok: true,
    note: `✅ **${d.name}** ${verb} : ${what}.${dates.length ? ` 📅 Planning mis à jour (${dates.length} jour${dates.length > 1 ? "s" : ""}).` : ""}`,
  };
}

// ---------- Interactions cm_… ----------
async function open(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  if (!appSync.enabled()) return reply(i, { content: "⚠️ Lien avec l'app désactivé : ajoute SUPABASE_URL et SUPABASE_SERVICE_KEY dans Railway." });
  const st = { view: "home" };
  states.set(i.user.id, st);
  await i.deferReply({ flags: EPHEMERAL });
  return render(i, st);
}
async function handle(i) {
  if (!ctx.isAdmin(i)) return reply(i, { content: "⛔ Réservé aux admins." });
  const st = states.get(i.user.id);
  if (!st) return done(i, "Ce menu a expiré : reclique sur 👥 Chatteurs.", 8000);
  const id = i.customId;
  st.note = "";
  if (id === "cm_x") {
    states.delete(i.user.id);
    return done(i, "✅ C'est noté.", 4000);
  }
  if (id === "cm_nm")
    return i.showModal(
      new ModalBuilder().setCustomId("cm_nmm").setTitle("Nom du chatteur").addComponents(
        row(new TextInputBuilder().setCustomId("name").setLabel("Nom ou pseudo (comme dans l'app)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60).setValue(st.d?.name || ""))
      )
    );
  if (id === "cm_nmm") {
    st.d.name = cleanName(i.fields.getTextInputValue("name")) || st.d.name;
    return render(i, st);
  }
  await i.deferUpdate();
  if (id === "cm_new") Object.assign(st, { view: "edit", cid: null, orig: draftOf(null), d: draftOf(null) });
  else if (id.startsWith("cm_pick")) {
    const c = (await appSync.appChatters(true)).find((x) => x.id === i.values[0]);
    if (c) Object.assign(st, { view: "edit", cid: c.id, orig: draftOf(c), d: draftOf(c) });
  } else if (id === "cm_back") st.view = "home";
  else if (id === "cm_u") {
    const uid = i.values[0] || "";
    const u = uid && i.users?.get(uid);
    if (u?.bot) st.note = "❌ Choisis un chatteur, pas un bot.";
    else {
      if (u) ctx.remember?.(u, i.members?.get(uid));
      const linked = uid && (await appSync.appChatters(true)).find((x) => x.discordId === uid && x.id !== st.cid);
      if (linked && !st.cid) {
        // ce compte est déjà un chatteur de l'app : on le modifie plutôt que d'en créer un deuxième
        Object.assign(st, { cid: linked.id, orig: draftOf(linked), d: draftOf(linked), note: `ℹ️ Ce compte est déjà **${linked.name}** dans l'app : tu le modifies.` });
      } else {
        st.d.uid = uid;
        if (!st.d.name && u) st.d.name = cleanName(i.members?.get(uid)?.displayName || u.globalName || u.username);
        if (linked) st.note = `ℹ️ Ce compte était relié à **${linked.name}** : il sera relié à ${st.d.name || "ce chatteur"} à la place.`;
      }
    }
  } else if (id === "cm_s") st.d.slots = appSync.habSlots({ slots: i.values });
  else if (id === "cm_a") st.d.accts = i.values.filter((x) => x !== "none");
  else if (id === "cm_d") st.d.days = i.values.map(Number).sort();
  else if (id === "cm_ap") st.d.apply = !st.d.apply;
  else if (id === "cm_ok") {
    const r = await save(st);
    st.note = r.note;
    if (r.ok) st.view = "home";
  }
  return render(i, st);
}

module.exports = { ctx, open, handle, states, cleanName };
