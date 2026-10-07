const { SlashCommandBuilder } = require("discord.js");
const { isAdmin } = require("../utils");
const { resetUser, resetAll } = require("../stats");
const { refreshCard, refreshAllCards } = require("../statsCards");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("staff-reset")
    .setDescription("	Reset staff stats")
    .addSubcommand(sub => sub
      .setName("user")
      .setDescription("Reset one user's stats")
      .addUserOption(o => o.setName("user").setDescription("Who to reset").setRequired(true)))
    .addSubcommand(sub => sub
      .setName("all")
      .setDescription("Reset EVERYONE's stats")),

  async execute(interaction) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "all") {
      resetAll();
      refreshAllCards(interaction.client).catch(() => {});
      return interaction.reply({ content: "🧹 Reset stats for **everyone**." });
    }

    const target = interaction.options.getUser("user");
    resetUser(target.id);
    refreshCard(interaction.client, target.id).catch(() => {});
    return interaction.reply({ content: `🧹 Reset stats for ${target}.` });
  }
};
