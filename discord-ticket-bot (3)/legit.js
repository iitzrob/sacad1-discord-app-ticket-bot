const fs = require("fs");
const path = require("path");
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags
} = require("discord.js");

// ---------------------------------------------------------------------
// "Are we legit" vote.
//  - /are-we-legit posts a black panel and the bot reacts with yes + no.
//  - Anyone who reacts with NO gets a plain-text warning in the same
//    channel (one message — it's EDITED to add more people).
//  - They have 24h to open a General Help ticket, otherwise they're banned.
//  - Removing the NO reaction (or opening the ticket) clears them.
// Stored in data/legit.json so it survives restarts.
// ---------------------------------------------------------------------
const YES = "<:yes:1543519013567602708>";
const NO = "<:no:1543519039567953920>";
const YES_ID = "1543519013567602708";
const NO_ID = "1543519039567953920";
const HOURS_24 = 24 * 60 * 60 * 1000;

const DATA_FILE = path.join(__dirname, "data", "legit.json");

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")); }
  catch { return { polls: {} }; }
}
function save() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) { console.error("Failed to save legit.json:", err); }
}
const data = load();
if (!data.polls) data.polls = {};
// polls: messageId -> { channelId, guildId, warnId, voters: { userId: votedAtMs } }

// One-at-a-time queue per poll so quick back-to-back reactions can't race.
const chains = new Map();
function enqueue(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn).catch(err => console.error("[legit]", err));
  chains.set(key, next);
  return next;
}

// ---------- The panel ----------
function buildPanel() {
  const text = c => new TextDisplayBuilder().setContent(c);
  const sep = () => new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small);
  return new ContainerBuilder()
    .setAccentColor(0x010101) // black
    .addTextDisplayComponents(text("# Are we legit?"))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(text(`React to this message with ${YES} to show we are legit`))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(text(`React to this message with ${NO} if we aren't legit`));
}

async function sendLegitPoll(channel) {
  const msg = await channel.send({
    components: [buildPanel()],
    flags: MessageFlags.IsComponentsV2
  });
  data.polls[msg.id] = { channelId: channel.id, guildId: channel.guild.id, warnId: null, voters: {} };
  save();
  await msg.react(YES).catch(err => console.error("[legit] react yes failed:", err.message));
  await msg.react(NO).catch(err => console.error("[legit] react no failed:", err.message));
  return msg;
}

// ---------- The warning (plain text, edited as more people vote) ----------
function buildWarning(ids) {
  const mentions = ids.map(id => `<@${id}>`).join(" ");
  return `${mentions} You voted ${NO} on **Are we legit** -- you have **24 hours** to make a **General Help** ticket and explain why, or you will be banned. Voted by mistake? Just remove your ${NO} reaction`;
}

async function refreshWarning(client, pollId) {
  const poll = data.polls[pollId];
  if (!poll) return;
  const ids = Object.keys(poll.voters);
  const channel = await client.channels.fetch(poll.channelId).catch(() => null);
  if (!channel) return;

  let msg = poll.warnId ? await channel.messages.fetch(poll.warnId).catch(() => null) : null;

  if (!ids.length) {
    if (msg) await msg.delete().catch(() => {});
    poll.warnId = null;
    save();
    return;
  }

  const payload = { content: buildWarning(ids), allowedMentions: { users: ids } };
  if (msg) {
    const edited = await msg.edit(payload).catch(() => null);
    if (edited) return;
  }
  const sent = await channel.send(payload).catch(err => { console.error("[legit] warn send failed:", err.message); return null; });
  poll.warnId = sent ? sent.id : null;
  save();
}

// ---------- Everyone who currently has the NO reaction ----------
async function fetchNoVoterIds(message) {
  const reaction = message.reactions.cache.get(NO_ID);
  if (!reaction) return new Set();
  const ids = new Set();
  let after;
  for (;;) {
    const batch = await reaction.users.fetch({ limit: 100, after });
    if (!batch.size) break;
    batch.forEach(u => ids.add(u.id));
    after = batch.last().id;
    if (batch.size < 100) break;
  }
  return ids;
}

// ---------- 24h check ----------
async function checkExpired(client) {
  const now = Date.now();
  for (const [pollId, poll] of Object.entries(data.polls)) {
    const expired = Object.entries(poll.voters).filter(([, at]) => now - at >= HOURS_24).map(([id]) => id);
    if (!expired.length) continue;

    await enqueue(pollId, async () => {
      const channel = await client.channels.fetch(poll.channelId).catch(err => (err.code === 10003 ? "gone" : null));
      if (channel === null) return;           // temporary failure — try next cycle
      let message = null;
      if (channel !== "gone") {
        message = await channel.messages.fetch(pollId).catch(err => (err.code === 10008 ? "gone" : null));
        if (message === null) return;         // temporary failure — try next cycle
      }

      // Poll panel was deleted -> nobody gets banned, just clean up.
      if (channel === "gone" || message === "gone") {
        poll.voters = {};
        await refreshWarning(client, pollId);
        delete data.polls[pollId];
        save();
        return;
      }

      const stillVoting = await fetchNoVoterIds(message).catch(() => null);
      if (!stillVoting) return;

      const guild = await client.guilds.fetch(poll.guildId).catch(() => null);
      if (!guild) return;

      for (const userId of expired) {
        if (poll.voters[userId] === undefined) continue;
        if (stillVoting.has(userId)) {
          try {
            await guild.members.ban(userId, { reason: "Voted no on 'Are we legit' and didn't open a General Help ticket within 24h" });
          } catch (err) {
            console.error(`[legit] couldn't ban ${userId}:`, err.message);
          }
        }
        delete poll.voters[userId];
      }
      save();
      await refreshWarning(client, pollId);
    });
  }
}

// ---------- Called when someone opens a General Help ticket ----------
function noteHelpTicket(client, userId) {
  for (const [pollId, poll] of Object.entries(data.polls)) {
    if (poll.voters[userId] === undefined) continue;
    enqueue(pollId, async () => {
      delete poll.voters[userId];
      save();
      await refreshWarning(client, pollId);
    });
  }
}

// ---------- Wire up ----------
function init(client) {
  client.on("messageReactionAdd", (reaction, user) => {
    if (user.bot) return;
    const pollId = reaction.message.id;
    const poll = data.polls[pollId];
    if (!poll || reaction.emoji.id !== NO_ID) return;
    enqueue(pollId, async () => {
      poll.voters[user.id] = Date.now();
      save();
      await refreshWarning(client, pollId);
    });
  });

  client.on("messageReactionRemove", (reaction, user) => {
    if (user.bot) return;
    const pollId = reaction.message.id;
    const poll = data.polls[pollId];
    if (!poll || reaction.emoji.id !== NO_ID) return;
    enqueue(pollId, async () => {
      if (poll.voters[user.id] === undefined) return;
      delete poll.voters[user.id];
      save();
      await refreshWarning(client, pollId);
    });
  });

  client.once("ready", () => {
    checkExpired(client).catch(err => console.error("[legit] initial check failed:", err));
    setInterval(() => checkExpired(client).catch(err => console.error("[legit] check failed:", err)), 60 * 1000);
  });
}

module.exports = { init, sendLegitPoll, noteHelpTicket };
