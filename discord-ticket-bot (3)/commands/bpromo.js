const { SlashCommandBuilder } = require("discord.js");
const { runRoleChange, PROMO_CHOICES } = require("../builderRoles");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("bpromo")
    .setDescription("Promote a member to a builder role — max perms only")
    .addUserOption(o => o.setName("user").setDescription("Who to promote").setRequired(true))
    .addStringOption(o => o
      .setName("role")
      .setDescription("The role they're getting")
      .setRequired(true)
      .addChoices(...PROMO_CHOICES)),

  async execute(interaction) {
    return runRoleChange(interaction, "promo");
  }
};
