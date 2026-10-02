// =====================================================================
// PREFIX SETTINGS
// The text-command prefix (default ","), saved per server in
// data/prefix.json so it survives restarts. Changed with /prefix.
// =====================================================================
const fs = require("fs");
const path = require("path");

const DEFAULT_PREFIX = ",";
const DATA_FILE = path.join(__dirname, "data", "prefix.json");

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    return parsed && typeof parsed.guilds === "object" && parsed.guilds ? parsed : { guilds: {} };
  } catch {
    return { guilds: {} };
  }
}

const data = load();

function save() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error("Failed to save prefix.json:", err);
  }
}

function getPrefix(guildId) {
  return data.guilds[guildId] || DEFAULT_PREFIX;
}

// 1-3 characters, no spaces, and nothing that would clash with normal chat
// (letters/digits) or Discord syntax (mentions, channels, emoji, code, slash).
function validatePrefix(value) {
  const prefix = String(value ?? "").trim();
  const length = [...prefix].length;
  if (length < 1 || length > 3) return { ok: false, reason: "The prefix must be 1 to 3 characters." };
  if (/\s/.test(prefix)) return { ok: false, reason: "The prefix can't contain spaces." };
  if (/[A-Za-z0-9<@#`\/\\]/.test(prefix)) {
    return { ok: false, reason: "Use symbols only - no letters, numbers or these: < @ # ` / \\" };
  }
  return { ok: true, prefix };
}

function setPrefix(guildId, prefix) {
  data.guilds[guildId] = prefix;
  save();
}

module.exports = { DEFAULT_PREFIX, getPrefix, setPrefix, validatePrefix };
