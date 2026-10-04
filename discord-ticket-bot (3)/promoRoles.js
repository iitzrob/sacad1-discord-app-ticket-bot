const { PermissionsBitField, MessageFlags } = require("discord.js");
const { hasFullAccess } = require("./utils");

// =====================================================================
// PROMO / DEMO shared logic — used by commands/promo.js and commands/demo.js
// =====================================================================

// Channel the promo / demo messages get posted in
const PROMO_CHANNEL_ID = "1523679194662572032";

const UPVOTE_EMOJI = "<:97872upvote:1556255804032819271>";
const DOWNVOTE_EMOJI = "<:123113downvote:1556255894705274960>";

// Staff ladder, lowest -> highest.
//   id:      paste the real role ID here (recommended)
//   aliases: if id is left "", the bot looks for a role in the server whose
//            name matches one of these (case/spaces/dots ignored)
const LADDER = [
  { key: "helper",     label: "Helper",     id: "", aliases: ["helper"] },
  { key: "sr_helper",  label: "Sr Helper",  id: "", aliases: ["srhelper", "seniorhelper"] },
  { key: "mod",        label: "Mod",        id: "", aliases: ["mod", "moderator"] },
  { key: "sr_mod",     label: "Sr Mod",     id: "", aliases: ["srmod", "seniormod", "srmoderator", "seniormoderator"] },
  { key: "admin",      label: "Admin",      id: "", aliases: ["admin", "administrator"] },
  { key: "head_admin", label: "Head Admin", id: "", aliases: ["headadmin", "headadministrator"] }
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

  const member = await guild.members.fetch(targetUser.id).catch(() => null);
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

  // Roles to remove: every other staff role they hold
  const toRemove = owned.filter(e => !newEntry || e.key !== newEntry.key).map(e => e.role);

  // Can the bot actually manage these roles?
  const blocked = [newEntry?.role, ...toRemove].filter(r => r && !r.editable);
  if (blocked.length) {
    return interaction.editReply(
      `❌ I can't manage ${blocked.map(r => `**${r.name}**`).join(", ")}. ` +
      "Move my bot role above the staff roles and make sure I have **Manage Roles**."
    );
  }

  const reason = `${isPromo ? "Promo" : "Demo"} by ${interaction.user.tag}`;

  try {
    if (newEntry && !member.roles.cache.has(newEntry.role.id)) {
      await member.roles.add(newEntry.role, reason);
    }
    if (toRemove.length) await member.roles.remove(toRemove, reason);
  } catch (err) {
    console.error(`[${mode}] Failed to change roles:`, err);
    return interaction.editReply(`❌ Couldn't change their roles: ${err.message}`);
  }

  // ---- announcement ----
  const fromText = current ? `<@&${current.role.id}>` : "member";
  const toText = newEntry ? `<@&${newEntry.role.id}>` : "member";
  const emoji = isPromo ? UPVOTE_EMOJI : DOWNVOTE_EMOJI;

  const message = `${targetUser}\n${emoji} ${fromText} 🠲 ${toText}`;

  const channel = await guild.channels.fetch(PROMO_CHANNEL_ID).catch(() => null);
  let posted = false;
  if (channel && channel.isTextBased()) {
    // no pings — the mentions just render
    posted = await channel.send({ content: message, allowedMentions: { parse: [] } }).then(() => true).catch(() => false);
  }

  const summary =
    `${isPromo ? "✅ Promoted" : "✅ Demoted"} ${targetUser}: ${fromText} 🠲 ${toText}` +
    (posted ? ` — posted in <#${PROMO_CHANNEL_ID}>.` : `\n⚠️ Roles were changed, but I couldn't post in <#${PROMO_CHANNEL_ID}> (check my permissions there).`);

  return interaction.editReply({ content: summary, allowedMentions: { parse: [] } });
}

module.exports = { runRoleChange, PROMO_CHOICES, DEMO_CHOICES };
