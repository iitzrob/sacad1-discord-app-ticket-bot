const fs = require("fs");
const path = require("path");
const { SlashCommandBuilder } = require("discord.js");
const { isStaff } = require("../utils");

// /giveaway ping — staff only, only inside one category, once every 2 hours.
const PING_ROLE = "1501836673984630824";
const ALLOWED_CATEGORY = "1477092861714501632";
const COOLDOWN_MS = 2 * 60 * 60 * 1000;

// Cooldown is saved to disk so restarting the bot doesn't reset it.
const DATA_FILE = path.join(__dirname, "..", "data", "giveaway-ping.json");

function readLast() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")).lastUsed || 0; }
  catch { return 0; }
}

function writeLast(ts) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ lastUsed: ts }));
  } catch (err) {
    console.error("Failed to save giveaway-ping.json:", err);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Giveaway tools — staff only")
    .addSubcommand(s =>
      s.setName("ping").setDescription("Ping the giveaway role (once every 2 hours)")),

  async execute(interaction) {
    if (!interaction.guild || !isStaff(interaction.member)) {
      return interaction.reply({ content: "No permission.", flags: 64 });
    }

    if (interaction.options.getSubcommand() !== "ping") return;

    // Works in channels inside the category (and threads of those channels).
    const ch = interaction.channel;
    const categoryId = ch.isThread() ? ch.parent?.parentId : ch.parentId;
    if (categoryId !== ALLOWED_CATEGORY) {
      return interaction.reply({ content: "You can't use this command in this channel.", flags: 64 });
    }

    const last = readLast();
    const readyAt = last + COOLDOWN_MS;
    if (Date.now() < readyAt) {
      return interaction.reply({
        content: `This is on cooldown — you can use it again <t:${Math.floor(readyAt / 1000)}:R>.`,
        flags: 64
      });
    }

    // Claim the cooldown first so two quick uses can't both go through.
    writeLast(Date.now());
    try {
      await ch.send({ content: `<@&${PING_ROLE}>`, allowedMentions: { roles: [PING_ROLE] } });
    } catch (err) {
      console.error("Giveaway ping failed:", err);
      writeLast(last); // it didn't send, so give the cooldown back
      return interaction.reply({ content: "I couldn't send the ping in this channel — check my permissions.", flags: 64 });
    }

    return interaction.reply({ content: "Pinged.", flags: 64 });
  }
};
