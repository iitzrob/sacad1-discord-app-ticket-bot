// =====================================================================
// STICKY MESSAGES
// /sticky posts a message that stays at the bottom of the channel. After
// people stop talking for a moment, the old copy is deleted and a fresh one
// is posted underneath. /unstick removes it.
//
// Saved in data/stickies.json, so stickies survive restarts.
// =====================================================================
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data", "stickies.json");
const DELAY_MS = 2500; // wait for chat to settle before reposting

// channelId -> { content, messageId }
const stickies = new Map();
const timers = new Map();
const busy = new Set();
let client = null;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    for (const [id, s] of Object.entries(raw)) stickies.set(id, s);
  } catch {}
}

function save() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(stickies), null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error("Failed to save stickies.json:", err);
  }
}

load();

function init(c) {
  client = c;
}

async function getChannel(id) {
  return client?.channels.cache.get(id) ?? client?.channels.fetch(id).catch(() => null);
}

async function deleteOld(channel, messageId) {
  if (!messageId) return;
  const old = await channel.messages.fetch(messageId).catch(() => null);
  if (old) await old.delete().catch(() => {});
}

async function setSticky(channel, content) {
  await removeSticky(channel);
  const message = await channel.send({ content });
  stickies.set(channel.id, { content, messageId: message.id });
  save();
  return message;
}

async function removeSticky(channel) {
  const sticky = stickies.get(channel.id);
  if (!sticky) return false;

  clearTimeout(timers.get(channel.id));
  timers.delete(channel.id);
  stickies.delete(channel.id);
  save();

  await deleteOld(channel, sticky.messageId);
  return true;
}

function hasSticky(channelId) {
  return stickies.has(channelId);
}

async function repost(channelId) {
  const sticky = stickies.get(channelId);
  if (!sticky || busy.has(channelId)) return;

  busy.add(channelId);
  try {
    const channel = await getChannel(channelId);
    if (!channel) return;
    await deleteOld(channel, sticky.messageId);
    const fresh = await channel.send({ content: sticky.content });
    sticky.messageId = fresh.id;
    save();
  } catch (err) {
    console.error(`Sticky repost failed in ${channelId}:`, err.message);
  } finally {
    busy.delete(channelId);
  }
}

// Called for every guild message, including the bot's own (welcome messages,
// etc). Only the sticky's own message is ignored, so it can't loop.
function handleMessageForSticky(message) {
  const sticky = stickies.get(message.channelId);
  if (!sticky) return;
  // Ignore the sticky's own post. Compare by content too, because Discord can
  // deliver the event before we've saved the new message id (that caused a loop).
  if (message.id === sticky.messageId) return;
  if (message.author?.id === client?.user?.id && message.content === sticky.content && !message.embeds.length) return;

  clearTimeout(timers.get(message.channelId));
  timers.set(message.channelId, setTimeout(async () => {
    timers.delete(message.channelId);
    // If a repost is mid-flight, wait for it, then repost again so the
    // sticky still ends up at the bottom.
    while (busy.has(message.channelId)) await new Promise(r => setTimeout(r, 300));
    repost(message.channelId);
  }, DELAY_MS));
}

module.exports = { init, setSticky, removeSticky, hasSticky, handleMessageForSticky };
