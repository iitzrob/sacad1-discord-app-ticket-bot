const { SlashCommandBuilder } = require("discord.js");
const { isStaff } = require("../utils");
const { buildCreateModal } = require("../giveaways");

// /gcreate — staff only. Opens a form asking for the prize, time,
// number of winners and an optional description.
module.exports = {
  data: new SlashCommandBuilder()
    .setName("gcreate")
    .setDescription("Start a giveaway — staff only"),

  async execute(interaction) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: "No permission.", flags: 64 });
    }
    return interaction.showModal(buildCreateModal());
  }
};
