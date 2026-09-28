const fs = require("fs");
const path = require("path");
const {
  Client, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require("discord.js");

// =====================================================================
// GIVEAWAYS — core module used by /gcreate, /gend and /greroll
//
// You don't need to edit index.js: the first time this file is loaded it
// hooks Client#login, so the moment the bot logs in it starts listening for
// the Enter button / create form / autocomplete and starts the end-timer.
// Giveaways live in data/giveaways.json, so they survive a restart.
// =====================================================================

const COLOR = "#808080"; // grey embed colour
const DATA_FILE = path.join(__dirname, "data", "giveaways.json");
const MODAL_ID = "gw_create_modal";
const ENTER_ID = "gw_enter";
const EPHEMERAL = 64;
const MAX_WINNERS = 25;
const MAX_DURATION_MS = 52 * 7 * 24 * 60 * 60 * 1000; // 52 weeks

// ---------------------------------------------------------------- storage
const BACKUP_FILE = DATA_FILE + ".bak";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

// If giveaways.json is missing we start fresh. If it exists but is unreadable
// (e.g. cut off by a crash), we keep a copy of it and fall back to the last
// good backup instead of silently wiping every running giveaway.
function load() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return readJson(DATA_FILE);
  } catch (err) {
    console.error("giveaways.json is unreadable:", err.message);
    try { fs.copyFileSync(DATA_FILE, DATA_FILE + ".corrupt-" + Date.now()); } catch {}
    try {
      const restored = readJson(BACKUP_FILE);
      console.warn("Restored giveaways from giveaways.json.bak");
      return restored;
    } catch {
      return {};
    }
  }
}

const data = load(); // messageId -> giveaway

function save() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BACKUP_FILE);
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error("Failed to save giveaways.json:", err);
  }
}

// ---------------------------------------------------------------- helpers
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

// "30s", "5m", "2h", "1d", "1w" — and combos like "1d 12h".
function parseDuration(text) {
  const cleaned = String(text || "").trim().toLowerCase();
  if (!cleaned) return null;
  const re = /(\d+)\s*([smhdw])/g;
  let total = 0;
  let consumed = "";
  let match;
  while ((match = re.exec(cleaned)) !== null) {
    total += parseInt(match[1], 10) * UNIT_MS[match[2]];
    consumed += match[0];
  }
  if (!total) return null;
  if (cleaned.replace(/\s+/g, "") !== consumed.replace(/\s+/g, "")) return null;
  return total;
}

const FOOTER_TEXT = "Sac's Giveaways";

// Server logo for the footer: live from the guild cache when we can, otherwise the one saved at creation.
function iconFor(client, g) {
  try {
    const guild = client && client.guilds && client.guilds.cache && client.guilds.cache.get(g.guildId);
    const url = guild && guild.iconURL({ size: 128 });
    if (url) { g.iconURL = url; return url; }
  } catch {}
  return g.iconURL || undefined;
}

function buildEmbed(g, iconURL) {
  const unix = Math.floor(g.endsAt / 1000);

  const info = [
    `**${g.ended ? "Ended" : "Ends"}:** <t:${unix}:R> (<t:${unix}:f>)`,
    `**Hosted by:** <@${g.hostId}>`,
    `**Entries:** ${g.entries.length}`,
    g.ended
      ? `**Winner(s):** ${g.winners.length ? g.winners.map(id => `<@${id}>`).join(", ") : "No valid entries"}`
      : `**Winners:** ${g.winnerCount}`
  ].join("\n");

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(g.prize)
    .setDescription(g.description ? `${g.description}\n\n${info}` : info)
    .setFooter(iconURL ? { text: FOOTER_TEXT, iconURL } : { text: FOOTER_TEXT });

  return embed;
}

function buildComponents(g) {
  if (g.ended) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(ENTER_ID).setLabel("Enter").setStyle(ButtonStyle.Secondary)
    )
  ];
}

async function fetchMessage(client, g) {
  const channel = await client.channels.fetch(g.channelId);
  return channel.messages.fetch(g.messageId);
}

// Returns true when the message was updated (or is gone for good, so there is
// nothing left to retry), false when it failed for a temporary reason.
async function refreshMessage(client, g) {
  try {
    const message = await fetchMessage(client, g);
    await message.edit({ embeds: [buildEmbed(g, iconFor(client, g))], components: buildComponents(g) });
    return true;
  } catch (err) {
    if (err && (err.code === 10008 || err.code === 10003 || err.code === 50001)) {
      console.warn(`⚠️  Giveaway "${g.prize}" — its message or channel is gone or not accessible.`);
      return true;
    }
    console.warn(`⚠️  Couldn't update giveaway "${g.prize}" right now, will retry:`, err && err.message);
    return false;
  }
}

// Entry count edits are batched so a rush of clicks doesn't spam Discord.
const pendingRefresh = new Map();
function scheduleRefresh(client, g) {
  if (pendingRefresh.has(g.messageId)) return;
  pendingRefresh.set(g.messageId, setTimeout(() => {
    pendingRefresh.delete(g.messageId);
    refreshMessage(client, g);
  }, 2000));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Picks up to `count` winners from `pool`, skipping anyone who has left the server.
async function pickWinners(client, g, pool, count) {
  const winners = [];
  const guild = await client.guilds.fetch(g.guildId).catch(() => null);
  for (const userId of shuffle(pool)) {
    if (winners.length >= count) break;
    if (guild) {
      try {
        await guild.members.fetch(userId);
      } catch (err) {
        // 10007 = Unknown Member (they left). Any other error is a hiccup, so keep them.
        if (err && err.code === 10007) continue;
      }
    }
    winners.push(userId);
  }
  return winners;
}

// ---------------------------------------------------------------- end / reroll
const busy = new Set();

async function endGiveaway(client, id) {
  const g = data[id];
  if (!g || g.ended || busy.has(id)) return null;
  busy.add(id);
  try {
    g.winners = await pickWinners(client, g, g.entries, g.winnerCount);
    g.ended = true;
    g.endedAt = Date.now();
    if (g.endsAt > g.endedAt) g.endsAt = g.endedAt; // ended early — show the real end time
    save();

    g.needsRefresh = !(await refreshMessage(client, g));
    save();

    try {
      const message = await fetchMessage(client, g);
      const text = g.winners.length
        ? `Congratulations ${g.winners.map(w => `<@${w}>`).join(", ")}! You won **${g.prize}**.`
        : `No valid entries, so nobody won **${g.prize}**.`;
      await message.reply({ content: text, allowedMentions: { users: g.winners } });
    } catch {
      // message gone — nothing to announce under
    }
    return g;
  } finally {
    busy.delete(id);
  }
}

async function rerollGiveaway(client, id) {
  const g = data[id];
  if (!g || !g.ended || busy.has(id)) return { error: "not_ended" };
  busy.add(id);
  try {
    const fresh = g.entries.filter(u => !g.winners.includes(u));
    if (!fresh.length) return { error: "no_entries" };

    const winners = await pickWinners(client, g, fresh, g.winnerCount);
    if (!winners.length) return { error: "no_entries" };

    g.winners = winners;
    save();
    g.needsRefresh = !(await refreshMessage(client, g));
    save();

    try {
      const message = await fetchMessage(client, g);
      await message.reply({
        content: `Rerolled! New winner${winners.length > 1 ? "s" : ""} of **${g.prize}**: ${winners.map(w => `<@${w}>`).join(", ")}`,
        allowedMentions: { users: winners }
      });
    } catch {
      // message gone
    }
    return { giveaway: g };
  } finally {
    busy.delete(id);
  }
}

// Finds a giveaway from what the staff member typed/picked: a message ID or a prize name.
function findGiveaway(guildId, input, { ended }) {
  const text = String(input || "").trim();
  if (!text) return null;
  const pool = Object.values(data).filter(g => g.guildId === guildId && Boolean(g.ended) === ended);
  if (data[text] && pool.includes(data[text])) return data[text];
  const lower = text.toLowerCase();
  const matches = pool
    .filter(g => g.prize.toLowerCase() === lower)
    .sort((a, b) => b.createdAt - a.createdAt);
  return matches[0] || null;
}

// ---------------------------------------------------------------- create
function buildCreateModal() {
  return new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle("Create Giveaway")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("prize").setLabel("Prize")
          .setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("duration").setLabel("Time (1s, 1m, 1h, 1d, 1w)")
          .setPlaceholder("e.g. 30m, 2h, 1d, 1w").setStyle(TextInputStyle.Short)
          .setMaxLength(30).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("winners").setLabel("Number of winners")
          .setPlaceholder("1").setStyle(TextInputStyle.Short).setMaxLength(2).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("description").setLabel("Description (optional)")
          .setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(false)
      )
    );
}

async function handleCreateSubmit(client, i) {
  const prize = i.fields.getTextInputValue("prize").trim();
  const durationText = i.fields.getTextInputValue("duration");
  const winnersText = i.fields.getTextInputValue("winners").trim();
  const description = i.fields.getTextInputValue("description").trim();

  const duration = parseDuration(durationText);
  if (!duration) {
    return i.reply({ content: "Couldn't read that time. Use something like `30s`, `5m`, `2h`, `1d` or `1w`.", flags: EPHEMERAL });
  }
  if (duration > MAX_DURATION_MS) {
    return i.reply({ content: "That's too long — the maximum is 52 weeks.", flags: EPHEMERAL });
  }

  const winnerCount = parseInt(winnersText, 10);
  if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > MAX_WINNERS) {
    return i.reply({ content: `Number of winners must be between 1 and ${MAX_WINNERS}.`, flags: EPHEMERAL });
  }

  const g = {
    id: null,
    guildId: i.guild.id,
    channelId: i.channel.id,
    messageId: null,
    prize,
    description: description || null,
    hostId: i.user.id,
    winnerCount,
    createdAt: Date.now(),
    endsAt: Date.now() + duration,
    ended: false,
    entries: [],
    winners: []
  };

  let message;
  try {
    g.iconURL = i.guild.iconURL({ size: 128 }) || undefined;
    message = await i.channel.send({ embeds: [buildEmbed(g, g.iconURL)], components: buildComponents(g) });
  } catch (err) {
    console.error("Giveaway send failed:", err);
    return i.reply({ content: "I couldn't post in this channel — check my permissions.", flags: EPHEMERAL });
  }

  g.id = g.messageId = message.id;
  data[message.id] = g;
  save();

  return i.reply({ content: `Giveaway for **${prize}** started.`, flags: EPHEMERAL });
}

// ---------------------------------------------------------------- entering
async function handleEnter(client, i) {
  const g = data[i.message.id];
  if (!g) {
    return i.reply({ content: "This giveaway isn't active anymore.", flags: EPHEMERAL });
  }
  if (g.ended || Date.now() >= g.endsAt) {
    return i.reply({ content: "This giveaway has ended.", flags: EPHEMERAL });
  }

  const idx = g.entries.indexOf(i.user.id);
  if (idx === -1) {
    g.entries.push(i.user.id);
    save();
    scheduleRefresh(client, g);
    return i.reply({ content: "You're in! Click Enter again to leave.", flags: EPHEMERAL });
  }

  g.entries.splice(idx, 1);
  save();
  scheduleRefresh(client, g);
  return i.reply({ content: "You've left the giveaway. Click Enter again to rejoin.", flags: EPHEMERAL });
}

// ---------------------------------------------------------------- autocomplete
async function handleAutocomplete(i) {
  if (i.commandName !== "gend" && i.commandName !== "greroll") return;
  const wantEnded = i.commandName === "greroll";
  const typed = String(i.options.getFocused() || "").toLowerCase();

  const choices = Object.values(data)
    .filter(g => g.guildId === i.guild?.id && Boolean(g.ended) === wantEnded)
    .filter(g => g.prize.toLowerCase().includes(typed))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 25)
    .map(g => ({ name: g.prize.slice(0, 100), value: g.id }));

  await i.respond(choices).catch(() => {});
}

// ---------------------------------------------------------------- init
function init(client) {
  client.on("interactionCreate", async i => {
    try {
      if (i.isAutocomplete()) return await handleAutocomplete(i);
      if (i.isButton() && i.customId === ENTER_ID) return await handleEnter(client, i);
      if (i.isModalSubmit() && i.customId === MODAL_ID) return await handleCreateSubmit(client, i);
    } catch (err) {
      console.error("Giveaway interaction error:", err);
      if (!i.isAutocomplete() && !i.replied && !i.deferred) {
        i.reply({ content: "Something went wrong with that giveaway action.", flags: EPHEMERAL }).catch(() => {});
      }
    }
  });

  const startTimer = () => {
    setInterval(() => {
      const now = Date.now();
      for (const g of Object.values(data)) {
        if (!g.ended && now >= g.endsAt) {
          endGiveaway(client, g.id).catch(err => console.error("Giveaway end failed:", err));
        } else if (g.ended && g.needsRefresh && !busy.has(g.id)) {
          // The "ended" edit failed earlier (Discord hiccup) — try again.
          g.needsRefresh = false;
          refreshMessage(client, g).then(ok => {
            if (!ok) g.needsRefresh = true;
            save();
          });
        }
      }
    }, 1000);
  };

  if (client.isReady()) startTimer();
  else client.once("ready", startTimer);
}

// Hook Client#login once so no change to index.js is needed.
if (!Client.prototype.__giveawaysHooked) {
  Client.prototype.__giveawaysHooked = true;
  const originalLogin = Client.prototype.login;
  Client.prototype.login = function (...args) {
    if (!this.__giveawaysInit) {
      this.__giveawaysInit = true;
      init(this);
    }
    return originalLogin.apply(this, args);
  };
}

module.exports = {
  buildCreateModal, endGiveaway, rerollGiveaway, findGiveaway
};
