const fs = require("fs");
const path = require("path");
const { EmbedBuilder } = require("discord.js");
const { formatMoney } = require("./stats");

// =====================================================================
// WEEKLY ACTIVITY TRACKER
// Separate from stats.js (the all-time /staff-stats numbers) on purpose —
// this is a rolling, admin-configured weekly leaderboard that lives in one
// message per tracker and edits itself live. You can have more than one
// tracker running at once (different groups posting to different channels).
//
// Data shape (data/trackers.json):
// {
//   trackers: [
//     {
//       id, guildId, channelId, createdBy, createdAt, weekStart,
//       messageId,                     // the single tracker message (content + embed)
//       users: [userId, ...],
//       stats: { [userId]: { claims, closes, renames, sponsors } } // sponsors = $ total
//     }
//   ],
//   lastResetDateKey: "YYYY-MM-DD" // Sydney-local date the weekly reset last ran, so we don't double-fire
// }
//
// TWO embeds in one message:
// Everything lives in a single message — two embeds with one field per
// tracked user (split across the two), so each person still gets their own
// little section (claims/closes/renames/sponsored). The second embed also
// has a Team Totals field.
//
// Ping caveat: Discord only fires an @mention NOTIFICATION for a mention
// sitting in a message's plain CONTENT — never for one inside an embed
// (field name, field value, description, whatever). This tracker message
// has no mentions in its content at all, so creating/updating/stopping a
// tracker never pings or DMs anyone — it's a purely visual, self-updating
// embed.
//
// Embeds cap out at 25 fields each. With two embeds up to 48 users are shown;
// if a tracker has more than that, a note says the rest are tracked but not shown.
// =====================================================================
const DATA_FILE = path.join(__dirname, "data", "trackers.json");
const MAX_FIELDS = 25;

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return { trackers: [], lastResetDateKey: null };
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to save trackers.json:", err);
  }
}

const data = load();

function genId() {
  return `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function blankStats() {
  return { claims: 0, closes: 0, renames: 0, sponsors: 0 };
}

// Field NAMES in an embed are plain text — Discord does not turn <@id>
// into a resolved, clickable mention there the way it does in a message's
// content. So to actually show someone's name (not their raw numeric ID)
// we have to look their name up ourselves: nickname/display name if we can
// get the guild member, otherwise their global username, otherwise fall
// back to the ID as a last resort (e.g. they left the server).
async function resolveDisplayName(client, guildId, userId) {
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId);
    return member.displayName;
  } catch {
    // Not in the guild anymore (or a fetch hiccup) — fall back to their
    // global username instead of a member-specific nickname.
  }
  try {
    const user = await client.users.fetch(userId);
    return user.username;
  } catch {
    return `Unknown user (${userId})`;
  }
}

// =====================================================================
// EMBEDS — the tracker message now carries TWO embeds (still one message,
// so nothing changes for messageId / editing / pings):
//   Embed 1: title + info + the first half of the tracked users
//   Embed 2: the second half of the tracked users + a Team Totals field
// Each embed can hold 25 fields, so up to 48 users are shown (25 in the
// first, 23 in the second + totals + an overflow note if needed).
// =====================================================================
const EMBED1_MAX = 25;
const EMBED2_MAX = 23;

async function buildTrackerEmbeds(client, tracker, { stopped = false } = {}) {
  const weekStartUnix = Math.floor(new Date(tracker.weekStart).getTime() / 1000);
  const total = tracker.users.length;
  const color = stopped ? "#F04747" : "#8B5CF6";

  // Split as evenly as possible, first embed gets the extra one.
  const firstCount = Math.min(EMBED1_MAX, Math.ceil(total / 2));
  const secondCount = Math.min(EMBED2_MAX, total - firstCount);
  const first = tracker.users.slice(0, firstCount);
  const second = tracker.users.slice(firstCount, firstCount + secondCount);
  const overflow = total - first.length - second.length;

  const names = await Promise.all(
    [...first, ...second].map(userId => resolveDisplayName(client, tracker.guildId, userId))
  );

  const card = userId => {
    const s = tracker.stats[userId] || blankStats();
    return (
      `🤝 Claims: **${s.claims}**\n` +
      `🔒 Closes: **${s.closes}**\n` +
      `✏️ Renames: **${s.renames}**\n` +
      `💸 Sponsored: **$${formatMoney(s.sponsors)}**`
    );
  };

  const embed1 = new EmbedBuilder()
    .setColor(color)
    .setTitle(stopped ? "📊 Weekly Activity Tracker — Stopped" : "📊 Weekly Activity Tracker")
    .setDescription(
      `Tracking **${total}** user(s) • updates live below\n` +
      `Week started <t:${weekStartUnix}:D> • resets every **Sunday at midnight (Sydney time)**`
    );

  first.forEach((userId, i) => {
    embed1.addFields({ name: names[i], value: card(userId), inline: true });
  });

  // Team totals across everyone tracked (not just the ones shown).
  const totals = tracker.users.reduce((acc, userId) => {
    const s = tracker.stats[userId] || blankStats();
    acc.claims += s.claims;
    acc.closes += s.closes;
    acc.renames += s.renames;
    acc.sponsors += s.sponsors;
    return acc;
  }, blankStats());

  const embed2 = new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: `Tracker ID: ${tracker.id}` })
    .setTimestamp();

  second.forEach((userId, i) => {
    embed2.addFields({ name: names[first.length + i], value: card(userId), inline: true });
  });

  if (overflow > 0) {
    embed2.addFields({
      name: "⚠️ Not shown",
      value: `${overflow} more tracked user(s) — two embeds can only display ${EMBED1_MAX + EMBED2_MAX} users. Split this into more than one tracker to see everyone.`,
      inline: false
    });
  }

  embed2.addFields({
    name: "📈 Team Totals",
    value:
      `🤝 Claims: **${totals.claims}**\n` +
      `🔒 Closes: **${totals.closes}**\n` +
      `✏️ Renames: **${totals.renames}**\n` +
      `💸 Sponsored: **$${formatMoney(totals.sponsors)}**`,
    inline: false
  });

  return [embed1, embed2];
}

async function refreshTrackerMessage(client, tracker, opts = {}) {
  try {
    const channel = await client.channels.fetch(tracker.channelId);
    const message = await channel.messages.fetch(tracker.messageId);
    // Only the embed is touched — the content (the original pings) is left
    // exactly as it was, so a stats update or a stop never re-pings anyone.
    await message.edit({ embeds: await buildTrackerEmbeds(client, tracker, opts) });
  } catch {
    console.warn(`⚠️  Couldn't refresh tracker ${tracker.id} — its message or channel may have been deleted.`);
  }
}

// =====================================================================
// CRUD
// =====================================================================
async function createTracker(client, guild, channelId, userIds, createdBy) {
  const channel = await guild.channels.fetch(channelId);

  const tracker = {
    id: genId(),
    guildId: guild.id,
    channelId,
    messageId: null,
    createdBy,
    createdAt: new Date().toISOString(),
    weekStart: new Date().toISOString(),
    users: [...userIds],
    stats: Object.fromEntries(userIds.map(id => [id, blankStats()]))
  };

  // Single message, no pings — just the one combined embed with everyone's
  // own field inside it. Nobody gets DM'd/notified when the tracker starts.
  const message = await channel.send({
    embeds: await buildTrackerEmbeds(client, tracker)
  });
  tracker.messageId = message.id;

  data.trackers.push(tracker);
  save();
  return tracker;
}

function getGuildTrackers(guildId) {
  return data.trackers.filter(t => t.guildId === guildId);
}

function getTracker(id) {
  return data.trackers.find(t => t.id === id);
}

async function stopTracker(client, id) {
  const idx = data.trackers.findIndex(t => t.id === id);
  if (idx === -1) return null;
  const [tracker] = data.trackers.splice(idx, 1);
  save();

  // Just re-colors/re-titles the existing message's embed to show the
  // tracker is stopped — doesn't touch the message's content, so nobody
  // gets re-pinged just because the tracker ended.
  await refreshTrackerMessage(client, tracker, { stopped: true });

  return tracker;
}

// =====================================================================
// EVENT HOOKS — called from index.js / ticket-rename.js / sponsor-add.js
// =====================================================================
async function recordTrackerEvent(client, guildId, userId, field) {
  const relevant = data.trackers.filter(t => t.guildId === guildId && t.users.includes(userId));
  if (!relevant.length) return;

  for (const t of relevant) {
    t.stats[userId] ??= blankStats();
    t.stats[userId][field]++;
  }
  save();

  // Re-render the one embed each relevant tracker lives in — no reason to
  // touch the message content (and no re-ping) over one person's event.
  await Promise.all(relevant.map(t => refreshTrackerMessage(client, t)));
}

async function recordTrackerSponsor(client, guildId, userId, amount) {
  const relevant = data.trackers.filter(t => t.guildId === guildId && t.users.includes(userId));
  if (!relevant.length) return;

  for (const t of relevant) {
    t.stats[userId] ??= blankStats();
    t.stats[userId].sponsors += amount;
  }
  save();

  await Promise.all(relevant.map(t => refreshTrackerMessage(client, t)));
}

// =====================================================================
// WEEKLY RESET — every Sunday at midnight, Australia/Sydney (NSW) time.
// "Sunday 12 at night" is the instant Sunday rolls into Monday, i.e.
// Monday 00:00 local time — that's what RESET_WEEKDAY/HOUR/MINUTE below
// point at. Uses Intl with an explicit timezone so daylight saving
// (AEST/AEDT) is handled automatically — no manual offset math needed.
// =====================================================================
const RESET_TIMEZONE = "Australia/Sydney";
const RESET_WEEKDAY = "Mon";
const RESET_HOUR = 0;
const RESET_MINUTE = 0;

function getSydneyParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: RESET_TIMEZONE,
    weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const map = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  return {
    weekday: map.weekday,
    dateKey: `${map.year}-${map.month}-${map.day}`,
    hour: parseInt(map.hour, 10),
    minute: parseInt(map.minute, 10)
  };
}

async function performWeeklyReset(client) {
  for (const tracker of data.trackers) {
    for (const userId of tracker.users) tracker.stats[userId] = blankStats();
    tracker.weekStart = new Date().toISOString();
  }
  save();

  for (const tracker of data.trackers) {
    try {
      const channel = await client.channels.fetch(tracker.channelId);
      // Plain notice, no mentions — the embed below just updates in place,
      // so nobody needs (or gets) pinged again for the reset.
      await channel.send("📅 **Weekly reset** — everyone's stats below are back to 0 for the new week.").catch(() => {});
    } catch {
      // channel gone — refreshTrackerMessage below will just warn and move on
    }
    await refreshTrackerMessage(client, tracker);
  }
}

// Checked every 20s (not every minute) so the reset still fires promptly
// even if the event loop is a little busy right at the boundary.
function startWeeklyResetScheduler(client) {
  setInterval(() => {
    const { weekday, dateKey, hour, minute } = getSydneyParts();
    if (weekday !== RESET_WEEKDAY || hour !== RESET_HOUR || minute !== RESET_MINUTE) return;
    if (data.lastResetDateKey === dateKey) return; // already reset in this same check-window
    data.lastResetDateKey = dateKey;
    save();
    performWeeklyReset(client).catch(err => console.error("Weekly tracker reset failed:", err));
  }, 20_000);
}

module.exports = {
  createTracker,
  getGuildTrackers,
  getTracker,
  stopTracker,
  recordTrackerEvent,
  recordTrackerSponsor,
  startWeeklyResetScheduler
};
