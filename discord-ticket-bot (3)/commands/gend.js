const { SlashCommandBuilder } = require("discord.js");
const { isStaff } = require("../utils");
const { findGiveaway, endGiveaway } = require("../giveaways");

// /gend prize:<giveaway prize> — staff only. Ends a running giveaway now.
module.exports = {
  data: new SlashCommandBuilder()
    .setName("gend")
    .setDescription("End a giveaway")
    .addStringOption(opt =>
      opt.setName("prize")
        .setDescription("The prize of the giveaway to end")
        .setAutocomplete(true)
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: "No permission.", flags: 64 });
    }

    const g = findGiveaway(interaction.guild.id, interaction.options.getString("prize"), { ended: false });
    if (!g) {
      return interaction.reply({ content: "❌ I couldn't find a running giveaway with that prize.", flags: 64 });
    }

    await interaction.deferReply({ flags: 64 });
    const result = await endGiveaway(interaction.client, g.id);
    if (!result) {
      return interaction.editReply("❌ That giveaway is already ending or has ended.");
    }
    return interaction.editReply(`✅ Ended the giveaway for **${g.prize}**.`);
  }
};
