const { SlashCommandBuilder } = require("discord.js");
const { isAdmin } = require("../utils");
const { sendLegitPoll } = require("../legit");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("are-we-legit")
    .setDescription("Post the legit vote"),

  async execute(interaction) {
    if (!interaction.guild || !isAdmin(interaction.member)) {
      return interaction.reply({ content: "No permission.", flags: 64 });
    }
    await interaction.deferReply({ flags: 64 });
    await sendLegitPoll(interaction.channel);
    return interaction.editReply(" Sent.");
  }
};
