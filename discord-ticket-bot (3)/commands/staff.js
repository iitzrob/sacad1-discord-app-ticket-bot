const { SlashCommandBuilder } = require("discord.js");
const { buildLbMessage } = require("../lb");

// Public - anyone can use it, no staff role needed. Opens on Closes; the
// buttons (handled in index.js) switch to Claims / Renames / Sponsor.
module.exports = {
  data: new SlashCommandBuilder()
    .setName("staff")
    .setDescription("Open staff lb")
    .addSubcommand(sub => sub.setName("lb").setDescription("Open staff lb")),

  async execute(interaction) {
    return interaction.reply(buildLbMessage("closes"));
  }
};
