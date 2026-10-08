const fs = require("fs");
const path = require("path");
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require("discord.js");
const { formatMoney } = require("./stats");

// ---------------------------------------------------------------------
// WEEKLY STAFF LEADERBOARD (replaces the old tracker)
//  - Tracks EVERYONE who claims / closes / renames / sponsors. No setup,
//    no staff role needed to view it.
//  - /staff lb opens it on Closes. Buttons switch to Claims / Renames /
//    Sponsors. Footer shows when it was last updated. Yellow embed.
//  - Resets automatically every week (Monday 00:00 Sydney time = the end
//    of Sunday). Saved in data/lb.json so restarts never lose it.
// ---------------------------------------------------------------------
const DATA_FILE = path.join(__dirname, "data", "lb.json");
const TIMEZONE = "Australia/Sydney";
const MAX_ROWS = 20;
const COLOR = "#FEE75C"; // yellow

const FIELDS = {
  closes: { label: "Closes", emoji: "🔒" },
  claims: { label: "Claims", emoji: "🤝" },
  renames: { label: "Renames", emoji: "✏️" },
  sponsors: { label: "Sponsor", emoji: "💸" }
};

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")); }
  catch { return { weekStart: new Date().toISOString(), lastResetDateKey: null, users: {} }; }
}
function save() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE); // atomic, a crash can't corrupt it
  } catch (err) { console.error("Failed to save lb.json:", err); }
}
const data = load();
if (!data.users) data.users = {};
if (!data.weekStart) data.weekStart = new Date().toISOString();

const blank = () => ({ claims: 0, closes: 0, renames: 0, sponsors: 0 });

// ---------- Recording (called from index.js / commands) ----------
async function recordLbEvent(client, guildId, userId, field) {
  if (!FIELDS[field]) return;
  data.users[userId] ??= blank();
  data.users[userId][field] = (data.users[userId][field] || 0) + 1;
  save();
}

async function recordLbSponsor(client, guildId, userId, amount) {
  data.users[userId] ??= blank();
  data.users[userId].sponsors = (data.users[userId].sponsors || 0) + amount;
  save();
}

// ---------- The embed + buttons ----------
function buildLbEmbed(field) {
  const info = FIELDS[field] || FIELDS.closes;
  const key = FIELDS[field] ? field : "closes";

  const entries = Object.entries(data.users)
    .map(([id, s]) => [id, s[key] || 0])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ROWS);

  const medals = ["🥇", "🥈", "🥉"];
  const value = n => (key === "sponsors" ? `$${formatMoney(n)}` : `${n}`);
  const lines = entries.map(([id, n], i) =>
    `${medals[i] || `**${i + 1}.**`} <@${id}> — **${value(n)}**`
  );

  const weekStartUnix = Math.floor(new Date(data.weekStart).getTime() / 1000);
  const nowUnix = Math.floor(Date.now() / 1000);

  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${info.emoji} Staff ${info.label} Leaderboard`)
    .setDescription(
      (lines.length ? lines.join("\n") : "No data yet this week.") +
      `\n\nWeek started <t:${weekStartUnix}:D> • resets every **Sunday at midnight** (Sydney time)`
    )
    .setFooter({ text: `Last updated: ${new Date().toLocaleString("en-AU", { timeZone: TIMEZONE, dateStyle: "medium", timeStyle: "short" })}` });
}

function buildLbButtons(selected) {
  return new ActionRowBuilder().addComponents(
    ...Object.entries(FIELDS).map(([key, info]) =>
      new ButtonBuilder()
        .setCustomId(`lb_${key}`)
        .setLabel(info.label)
        .setEmoji(info.emoji)
        .setStyle(key === selected ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(key === selected)
    )
  );
}

function buildLbMessage(field) {
  return { embeds: [buildLbEmbed(field)], components: [buildLbButtons(FIELDS[field] ? field : "closes")] };
}

// ---------- Weekly reset: Monday 00:00 Sydney (end of Sunday) ----------
function getSydneyParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const map = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  return {
    weekday: map.weekday,
    dateKey: `${map.year}-${map.month}-${map.day}`,
    hour: parseInt(map.hour, 10) % 24,
    minute: parseInt(map.minute, 10)
  };
}

function startWeeklyResetScheduler() {
  setInterval(() => {
    const { weekday, dateKey, hour, minute } = getSydneyParts();
    if (weekday !== "Mon" || hour !== 0 || minute !== 0) return;
    if (data.lastResetDateKey === dateKey) return;
    data.lastResetDateKey = dateKey;
    data.users = {};
    data.weekStart = new Date().toISOString();
    save();
    console.log("[lb] weekly reset done");
  }, 20_000);
}

module.exports = {
  recordLbEvent, recordLbSponsor, buildLbMessage, startWeeklyResetScheduler, FIELDS
};
