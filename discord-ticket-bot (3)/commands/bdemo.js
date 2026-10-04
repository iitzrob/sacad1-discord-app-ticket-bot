const { SlashCommandBuilder } = require("discord.js");
const { runRoleChange, DEMO_CHOICES } = require("../builderRoles");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("bdemo")
    .setDescription("Demote a builder to a lower role — max perms only")
    .addUserOption(o => o.setName("user").setDescription("Who to demote").setRequired(true))
    .addStringOption(o => o
      .setName("role")
      .setDescription("The role below that they're moving to")
      .setRequired(true)
      .addChoices(...DEMO_CHOICES)),

  async execute(interaction) {
    return runRoleChange(interaction, "demo");
  }
};
