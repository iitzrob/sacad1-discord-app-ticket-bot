const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");
const { isStaff } = require("../utils");
const config = require("../config");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ticket-add")
    .setDescription("Add someone to this ticket")
    .addUserOption(o => o.setName("user").setDescription("The user to add").setRequired(true)),

  async execute(interaction) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    const isTicketChannel = interaction.channel.parentId && (
      Object.values(config.categories).includes(interaction.channel.parentId)
      || Object.values(config.serviceCategories).includes(interaction.channel.parentId)
    );
    if (!isTicketChannel) {
      return interaction.reply({ content: "This isn't a ticket channel.", ephemeral: true });
    }

    const target = interaction.options.getUser("user");

    await interaction.channel.permissionOverwrites.edit(target.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });

    return interaction.reply({ content: `✅ Added ${target} to this ticket.` });
  }
};
