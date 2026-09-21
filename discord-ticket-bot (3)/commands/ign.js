const fs = require("fs");
const path = require("path");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const config = require("./config");

// Simple JSON-file-backed store, same pattern as stats.js.
// { userId: { ign: "IGN", originalName: "NameBeforeLinking" } }
// (Older entries may just be a plain string "IGN" — handled for backwards compat.)
const DATA_FILE = path.join(__dirname, "data", "ign.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to save ign.json:", err);
  }
}

const data = load();

// Normalizes an entry so callers always get { ign, originalName } or null.
function getEntry(userId) {
  const entry = data[userId];
  if (!entry) return null;
  if (typeof entry === "string") return { ign: entry, originalName: null };
  return entry;
}

function getIGN(userId) {
  const entry = getEntry(userId);
  return entry ? entry.ign : null;
}

// The display name the user had right before they first linked an IGN.
function getOriginalName(userId) {
  const entry = getEntry(userId);
  return entry ? entry.originalName : null;
}

// Returns the userId already using this IGN (case-insensitive), excluding
// the given user (so re-linking your own IGN doesn't flag itself), or null.
function findByIGN(ign, excludeUserId = null) {
  const lower = ign.toLowerCase();
  for (const [uid, entry] of Object.entries(data)) {
    if (uid === excludeUserId) continue;
    const storedIgn = typeof entry === "string" ? entry : entry.ign;
    if (storedIgn.toLowerCase() === lower) return uid;
  }
  return null;
}

// originalName is only used the FIRST time a user links (when no entry exists
// yet); on later re-links/updates the originally-captured name is preserved
// so unlinking always restores the name from before any IGN was ever linked.
function setIGN(userId, ign, originalName = null) {
  const existing = getEntry(userId);
  data[userId] = {
    ign,
    originalName: existing ? existing.originalName : originalName
  };
  save();
}

// Removes the stored entry and returns it ({ ign, originalName }) so the
// caller can restore the user's nickname, or null if nothing was stored.
function removeIGN(userId) {
  const entry = getEntry(userId);
  if (entry) {
    delete data[userId];
    save();
  }
  return entry;
}

// Every linked user as [{ userId, ign }] — used by /linked-users.
function getAll() {
  return Object.entries(data).map(([userId, entry]) => ({
    userId,
    ign: typeof entry === "string" ? entry : entry.ign
  }));
}

async function sendIGNPanel(channel) {
  const embed = new EmbedBuilder()
    .setColor(0x000000)
    .setTitle("Link Your Minecraft IGN")
    .setDescription(
      "Press the button below and enter your exact Minecraft IGN. It will be saved and added to your server nickname.\n" +
      "You can press the button again to update it."
    )
    .setFooter({ text: "IGN must be 3-16 letters, numbers, underscores, or periods / ." });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("link_ign").setLabel("Link IGN").setStyle(ButtonStyle.Primary)
  );

  await channel.send({ embeds: [embed], components: [row] });
}

// action: "Linked" | "Updated" | "Unlinked"
async function logIGNEvent(guild, { action, user, ign, previousIgn, actionBy }) {
  if (!config.ignLogChannel) return;
  const channel = await guild.channels.fetch(config.ignLogChannel).catch(() => null);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(action === "Unlinked" ? 0xF04747 : 0x8B5CF6)
    .setTitle(`IGN ${action}`)
    .addFields(
      { name: "User", value: `${user}`, inline: true },
      { name: "IGN", value: `\`${ign}\``, inline: true }
    )
    .setTimestamp();

  if (previousIgn) {
    embed.addFields({ name: "Previous IGN", value: `\`${previousIgn}\``, inline: true });
  }
  if (actionBy) {
    embed.addFields({ name: actionBy.id === user.id ? "Linked by" : "Removed by", value: `${actionBy}`, inline: true });
  }

  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

module.exports = { getIGN, getOriginalName, getAll, findByIGN, setIGN, removeIGN, sendIGNPanel, logIGNEvent };
