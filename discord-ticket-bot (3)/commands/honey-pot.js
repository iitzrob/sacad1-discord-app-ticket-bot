const { SlashCommandBuilder } = require("discord.js");
const { isStaff } = require("../utils");
const { sendHoneypotPanel } = require("../honeypot");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("honey-pot")
    .setDescription("Set up a honeypot"),
  async execute(interaction) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    await sendHoneypotPanel(interaction.channel);
    return interaction.reply({ content: `✅ Honeypot panel sent in ${interaction.channel}. The bot needs **Ban Members** permission for it to work.`, ephemeral: true });
  }
};
