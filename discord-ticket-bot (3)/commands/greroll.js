const { SlashCommandBuilder } = require("discord.js");
const { isStaff } = require("../utils");
const { findGiveaway, rerollGiveaway } = require("../giveaways");

// /greroll prize:<giveaway prize> — staff only. Picks new winners from an
// ended giveaway's entries (previous winners are skipped).
module.exports = {
  data: new SlashCommandBuilder()
    .setName("greroll")
    .setDescription("Reroll a giveaway")
    .addStringOption(opt =>
      opt.setName("prize")
        .setDescription("The prize of the ended giveaway to reroll")
        .setAutocomplete(true)
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: "No permission.", flags: 64 });
    }

    const g = findGiveaway(interaction.guild.id, interaction.options.getString("prize"), { ended: true });
    if (!g) {
      return interaction.reply({ content: "❌ I couldn't find an ended giveaway with that prize.", flags: 64 });
    }

    await interaction.deferReply({ flags: 64 });
    const result = await rerollGiveaway(interaction.client, g.id);
    if (result.error === "no_entries") {
      return interaction.editReply("❌ There are no other entries left to reroll from.");
    }
    if (result.error) {
      return interaction.editReply("❌ That giveaway can't be rerolled right now.");
    }
    return interaction.editReply(`✅ Rerolled the giveaway for **${g.prize}**.`);
  }
};
