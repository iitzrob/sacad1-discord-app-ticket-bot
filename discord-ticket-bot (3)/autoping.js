// =====================================================================
// AUTO PING
// Pings every new member in one channel, then deletes it after 5 seconds.
// Set with /autoping set. Saved in data/autoping.json.
// =====================================================================
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data", "autoping.json");
const DELETE_AFTER_MS = 5000;

// guildId -> channelId
let data = {};
try {
  data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) || {};
} catch {}

function save() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error("Failed to save autoping.json:", err);
  }
}

const getChannelId = (guildId) => data[guildId] || null;

function setChannel(guildId, channelId) {
  data[guildId] = channelId;
  save();
}

function clearChannel(guildId) {
  const had = Boolean(data[guildId]);
  delete data[guildId];
  save();
  return had;
}

async function handleJoin(member) {
  const channelId = getChannelId(member.guild.id);
  if (!channelId) return;

  const channel = await member.guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const msg = await channel
    .send({ content: `${member}`, allowedMentions: { users: [member.id] } })
    .catch(() => null);
  if (msg) setTimeout(() => msg.delete().catch(() => {}), DELETE_AFTER_MS);
}

module.exports = { getChannelId, setChannel, clearChannel, handleJoin };
