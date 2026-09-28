const fs = require("fs");
const path = require("path");
const { SlashCommandBuilder } = require("discord.js");
const { isStaff } = require("../utils");

// /partnership ping — staff only, only in one channel, once every 2 hours.
// Pings a role + @here.
const PING_ROLE = "1480173363195285696";
const ALLOWED_CHANNEL = "1480180234400694313";
const COOLDOWN_MS = 2 * 60 * 60 * 1000;

// Cooldown is saved to disk so restarting the bot doesn't reset it.
const DATA_FILE = path.join(__dirname, "..", "data", "partnership-ping.json");

function readLast() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")).lastUsed || 0; }
  catch { return 0; }
}

function writeLast(ts) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ lastUsed: ts }));
  } catch (err) {
    console.error("Failed to save partnership-ping.json:", err);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("partnership")
    .setDescription("Partnership tools — staff only")
    .addSubcommand(s =>
      s.setName("ping").setDescription("Ping the partnership role + @here (once every 2 hours)")),

  async execute(interaction) {
    if (!interaction.guild || !isStaff(interaction.member)) {
      return interaction.reply({ content: "No permission.", flags: 64 });
    }

    if (interaction.options.getSubcommand() !== "ping") return;

    const ch = interaction.channel;
    if (ch.id !== ALLOWED_CHANNEL) {
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
      // parse: ["everyone"] is what lets @here actually ping; the bot needs Mention Everyone.
      await ch.send({
        content: `<@&${PING_ROLE}> @here`,
        allowedMentions: { roles: [PING_ROLE], parse: ["everyone"] }
      });
    } catch (err) {
      console.error("Partnership ping failed:", err);
      writeLast(last); // it didn't send, so give the cooldown back
      return interaction.reply({ content: "I couldn't send the ping in this channel — check my permissions.", flags: 64 });
    }

    return interaction.reply({ content: "Pinged.", flags: 64 });
  }
};
