const fs = require("fs");
const path = require("path");
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags
} = require("discord.js");
const { isStaff } = require("./utils");

// JSON-file-backed, same pattern as locks.js/ticketActivity.js — needs to
// survive a restart, otherwise every registered honeypot channel would be
// forgotten (stops catching people) and any pending 7-day unbans would
// never fire.
const DATA_FILE = path.join(__dirname, "data", "honeypot.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return { channels: {}, bans: {} };
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to save honeypot.json:", err);
  }
}

// channels: channelId -> { guildId, messageId, kicks }
// bans:     "guildId:userId" -> { unbanAt } (ms epoch — when the 7-day temp ban expires)
const data = load();
if (!data.channels) data.channels = {};
if (!data.bans) data.bans = {};

const BAN_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DELETE_MESSAGE_SECONDS = 7 * 24 * 60 * 60; // Discord's max — purges their last 7 days of messages guild-wide

function isHoneypotChannel(channelId) {
  return Boolean(data.channels[channelId]);
}

function getKicks(channelId) {
  return data.channels[channelId]?.kicks ?? 0;
}

// ---------------------------------------------------------------------
// Panel — built with Components V2 (real Container/Separator components,
// not text embeds), plus the disabled "Kicks: N" button.
// ---------------------------------------------------------------------
function buildHoneypotContainer(kicks) {
  const kicksButton = new ButtonBuilder()
    .setCustomId("honeypot_kicks")
    .setLabel(`Kicks: ${kicks}`)
    .setStyle(ButtonStyle.Danger)
    .setDisabled(true);

  return new ContainerBuilder()
    .setAccentColor(0xED4245)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# 🪤 Bot Trap")
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("**Do not post here**")
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "This channel is a trap for self-bots and spam scripts.\n\n" +
        "Anyone who sends a message here is **soft-banned** — this bans " +
        "you from the server for **7 days** and deletes your messages from " +
        "the past 7 days.\n\n" +
        "No reason to type here."
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# Type here if you dare")
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(kicksButton)
    );
}

async function sendHoneypotPanel(channel) {
  const existing = data.channels[channel.id];
  const kicks = existing?.kicks ?? 0;

  const message = await channel.send({
    flags: MessageFlags.IsComponentsV2,
    components: [buildHoneypotContainer(kicks)]
  });

  data.channels[channel.id] = { guildId: channel.guild.id, messageId: message.id, kicks };
  save();
  return message;
}

async function refreshHoneypotPanel(channel, entry) {
  try {
    const message = await channel.messages.fetch(entry.messageId);
    await message.edit({
      flags: MessageFlags.IsComponentsV2,
      components: [buildHoneypotContainer(entry.kicks)]
    });
  } catch (err) {
    console.error(`Failed to refresh honeypot panel in #${channel.name ?? channel.id}:`, err);
  }
}

// ---------------------------------------------------------------------
// Message handling — called from messageCreate for every guild message.
// No-ops instantly unless the channel is a registered honeypot.
// ---------------------------------------------------------------------
async function handleHoneypotMessage(message) {
  if (message.author.bot) return; // real bots (welcome messages, other apps) are exempt — self-bots aren't flagged `bot`
  if (!message.guild) return;

  const entry = data.channels[message.channel.id];
  if (!entry) return;

  // Staff/admins can type in the trap freely — used for testing/managing it.
  if (message.member && isStaff(message.member)) return;

  // Delete the trigger message first so it doesn't linger if the ban fails.
  await message.delete().catch(() => {});

  const guild = message.guild;
  const userId = message.author.id;

  try {
    await guild.members.ban(userId, {
      deleteMessageSeconds: DELETE_MESSAGE_SECONDS,
      reason: "Honeypot trap — posted in a bot-trap channel (self-bot/spam script)"
    });
  } catch (err) {
    console.error(`Honeypot ban failed for ${userId} in ${guild.id}:`, err);
    return; // don't count it / schedule an unban if the ban never went through
  }

  // Schedule the automatic unban 7 days from now (Discord has no native
  // temp ban, so this is tracked the same way autoClose/ticketActivity
  // track their own timers — a JSON entry checked on an interval).
  data.bans[`${guild.id}:${userId}`] = { unbanAt: Date.now() + BAN_DURATION_MS };

  entry.kicks = (entry.kicks ?? 0) + 1;
  save();

  await refreshHoneypotPanel(message.channel, entry);
}

// ---------------------------------------------------------------------
// Scheduled unban — run on an interval (see index.js ready handler),
// same shape as checkAutoCloseTickets.
// ---------------------------------------------------------------------
async function checkExpiredHoneypotBans(client) {
  const now = Date.now();
  const entries = Object.entries(data.bans);
  if (!entries.length) return;

  let changed = false;
  for (const [key, { unbanAt }] of entries) {
    if (now < unbanAt) continue;

    const [guildId, userId] = key.split(":");
    const guild = client.guilds.cache.get(guildId);
    if (guild) {
      try {
        await guild.members.unban(userId, "Honeypot temp ban expired (7 days)");
      } catch (err) {
        // Already unbanned manually, guild gone, etc. — either way, stop tracking it.
        console.error(`Honeypot auto-unban failed for ${userId} in ${guildId}:`, err);
      }
    }
    delete data.bans[key];
    changed = true;
  }

  if (changed) save();
}

module.exports = {
  isHoneypotChannel,
  getKicks,
  sendHoneypotPanel,
  handleHoneypotMessage,
  checkExpiredHoneypotBans
};
