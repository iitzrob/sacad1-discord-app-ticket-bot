const { PermissionsBitField, MessageFlags } = require("discord.js");
const { hasFullAccess } = require("./utils");

// =====================================================================
// PROMO / DEMO shared logic — used by commands/promo.js and commands/demo.js
// =====================================================================

// Channel the promo / demo messages get posted in
const PROMO_CHANNEL_ID = "1523679194662572032";

// The base "staff" role every staff member has (lowest of all).
// Given on any promo to a staff role, removed when someone is demoted to member.
const STAFF_BASE_ROLE_ID = "1482008632747884736";

const UPVOTE_EMOJI = "<:97872upvote:1556255804032819271>";
const DOWNVOTE_EMOJI = "<:123113downvote:1556255894705274960>";

// Staff ladder, lowest -> highest.
//   id:      paste the real role ID here (recommended)
//   aliases: if id is left "", the bot looks for a role in the server whose
//            name matches one of these (case/spaces/dots ignored)
const LADDER = [
  { key: "trial_staff", label: "Trial Staff", id: "1535572623797387274", aliases: ["trialstaff", "trial"] },
  { key: "helper",     label: "Helper",     id: "1514937867598823565", aliases: ["helper"] },
  { key: "sr_helper",  label: "Sr Helper",  id: "1536240048033374298", aliases: ["srhelper", "seniorhelper"] },
  { key: "mod",        label: "Mod",        id: "1514938319195340910", aliases: ["mod", "moderator"] },
  { key: "sr_mod",     label: "Sr Mod",     id: "1514938633633923123", aliases: ["srmod", "seniormod", "srmoderator", "seniormoderator"] },
  { key: "admin",      label: "Admin",      id: "1514939460788420748", aliases: ["admin", "administrator"] },
  { key: "head_admin", label: "Head Admin", id: "1538335173882544249", aliases: ["headadmin", "headadministrator"] }
];

const normalize = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

// Slash-command choices for /promo (staff roles only)
const PROMO_CHOICES = LADDER.map(r => ({ name: r.label, value: r.key }));
// /demo can also drop someone all the way back to a normal member
const DEMO_CHOICES = [...PROMO_CHOICES, { name: "Member (remove all staff roles)", value: "member" }];

function resolveRole(guild, entry) {
  if (entry.id) return guild.roles.cache.get(entry.id) || null;
  return guild.roles.cache.find(r => entry.aliases.includes(normalize(r.name))) || null;
}

// Max perms only: server owner, config.fullAccessRole, or Administrator
function hasMaxPerms(member) {
  return hasFullAccess(member) || member.permissions.has(PermissionsBitField.Flags.Administrator);
}

async function runRoleChange(interaction, mode) {
  const isPromo = mode === "promo";

  if (!hasMaxPerms(interaction.member)) {
    return interaction.reply({ content: "No permission.", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  const targetUser = interaction.options.getUser("user");
  const choice = interaction.options.getString("role");

  const member = await guild.members.fetch({ user: targetUser.id, force: true }).catch(() => null);
  if (!member) return interaction.editReply("❌ That user isn't in this server.");

  await guild.roles.fetch().catch(() => {});

  // Work out which ladder roles actually exist in the server
  const ladder = LADDER.map(entry => ({ ...entry, role: resolveRole(guild, entry) }));
  const missing = ladder.filter(e => !e.role).map(e => e.label);

  // The role being given (null when demoting to plain member)
  let newEntry = null;
  if (choice !== "member") {
    newEntry = ladder.find(e => e.key === choice);
    if (!newEntry?.role) {
      return interaction.editReply(
        `❌ I can't find the **${newEntry?.label || choice}** role. Put its role ID in \`promoRoles.js\` (LADDER list).`
      );
    }
  }

  // Their current highest staff role
  const owned = ladder.filter(e => e.role && member.roles.cache.has(e.role.id));
  const current = owned.length ? owned[owned.length - 1] : null;

  const newIndex = newEntry ? ladder.findIndex(e => e.key === newEntry.key) : -1;
  const currentIndex = current ? ladder.findIndex(e => e.key === current.key) : -1;

  if (isPromo && newIndex <= currentIndex) {
    return interaction.editReply(
      `❌ ${targetUser} already has **${current.label}**${newIndex === currentIndex ? "" : " (higher than that)"}. Use /demo to move someone down.`
    );
  }
  if (!isPromo) {
    if (!current) return interaction.editReply(`❌ ${targetUser} doesn't have a staff role to demote from.`);
    if (newIndex >= currentIndex) {
      return interaction.editReply(`❌ Pick a role **below** ${current.label} for a demotion. Use /promo to move someone up.`);
    }
  }

  // The base staff role (every staff member has it)
  const staffBase = guild.roles.cache.get(STAFF_BASE_ROLE_ID) || null;
  if (!staffBase) {
    return interaction.editReply(
      "❌ I can't find the base staff role. Check STAFF_BASE_ROLE_ID in `promoRoles.js`."
    );
  }

  // Roles to add / remove
  //  - going to a staff role: add it + the base staff role, remove their other ladder roles
  //  - going to member: remove every ladder role + the base staff role
  const toAdd = [];
  if (newEntry && !member.roles.cache.has(newEntry.role.id)) toAdd.push(newEntry.role);
  if (newEntry && !member.roles.cache.has(staffBase.id)) toAdd.push(staffBase);

  const toRemove = owned.filter(e => !newEntry || e.key !== newEntry.key).map(e => e.role);
  if (!newEntry && member.roles.cache.has(staffBase.id)) toRemove.push(staffBase);

  // Can the bot actually manage these roles?
  const blocked = [...toAdd, ...toRemove].filter(r => !r.editable);
  if (blocked.length) {
    return interaction.editReply(
      `❌ I can't manage ${blocked.map(r => `**${r.name}**`).join(", ")}. ` +
      "Move my bot role above the staff roles and make sure I have **Manage Roles**."
    );
  }

  const reason = `${isPromo ? "Promo" : "Demo"} by ${interaction.user.tag}`;

  const names = list => list.map(r => r.name).join(", ") || "-";
  console.log(
    `[${mode}] ${targetUser.tag} | before: ${names(member.roles.cache.filter(r => r.id !== guild.id).map(r => r))}` +
    ` | add: ${names(toAdd)} | remove: ${names(toRemove)}`
  );

  // One role at a time (a single add/remove call per role is the most reliable way)
  try {
    for (const r of toAdd) await member.roles.add(r.id, reason);
    for (const r of toRemove) await member.roles.remove(r.id, reason);
  } catch (err) {
    console.error(`[${mode}] Failed to change roles:`, err);
    return interaction.editReply(`❌ Couldn't change their roles: ${err.message}`);
  }

  // Double-check against Discord. Anything that should be gone but isn't gets one more try.
  let stuckRoles = [];
  const fresh = await guild.members.fetch({ user: targetUser.id, force: true }).catch(() => null);
  if (fresh) {
    for (const r of toRemove.filter(r => fresh.roles.cache.has(r.id))) {
      await fresh.roles.remove(r.id, reason).catch(err => console.error(`[${mode}] Retry removing ${r.name} failed:`, err));
    }
    const again = await guild.members.fetch({ user: targetUser.id, force: true }).catch(() => null);
    if (again) stuckRoles = toRemove.filter(r => again.roles.cache.has(r.id));
    console.log(`[${mode}] ${targetUser.tag} | after: ${names(again ? again.roles.cache.filter(r => r.id !== guild.id).map(r => r) : [])}`);
  }

  // ---- announcement ----
  const fromText = current ? current.role.name : "member";
  const toText = newEntry ? newEntry.role.name : "member";
  const emoji = isPromo ? UPVOTE_EMOJI : DOWNVOTE_EMOJI;

  const message = `${targetUser}\n${emoji} ${fromText} ➜ ${toText}`;

  const channel = await guild.channels.fetch(PROMO_CHANNEL_ID).catch(() => null);
  let posted = false;
  if (channel && channel.isTextBased()) {
    // no pings — the mentions just render
    posted = await channel.send({ content: message, allowedMentions: { parse: [] } }).then(() => true).catch(() => false);
  }

  const summary =
    `${isPromo ? "✅ Promoted" : "✅ Demoted"} ${targetUser}: ${fromText} ➜ ${toText}` +
    (posted ? "" : `\n⚠️ Roles were changed, but I couldn't post in <#${PROMO_CHANNEL_ID}> (check my permissions there).`)
    + (stuckRoles.length ? `\n⚠️ Still on them after removing: ${stuckRoles.map(r => `**${r.name}**`).join(", ")}. Something else (another bot or role sync) may be adding it back.` : "");

  return interaction.editReply({ content: summary, allowedMentions: { parse: [] } });
}

module.exports = { runRoleChange, PROMO_CHOICES, DEMO_CHOICES };
