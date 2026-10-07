const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require("discord.js");
const { isAdmin } = require("../utils");
const { getGuildTrackers } = require("../tracker");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("tracker-stop")
    .setDescription("	Stop a tracker"),

  async execute(interaction) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    const trackers = getGuildTrackers(interaction.guild.id);
    if (!trackers.length) {
      return interaction.reply({ content: "There are no active trackers in this server.", ephemeral: true });
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId("tracker_stop_select")
      .setPlaceholder("Select a tracker to stop")
      .addOptions(trackers.slice(0, 25).map(t => {
        const channel = interaction.guild.channels.cache.get(t.channelId);
        return {
          label: `#${channel?.name || t.channelId}`,
          description: `${t.users.length} user(s) tracked`,
          value: t.id
        };
      }));

    return interaction.reply({
      content: "Select the tracker you want to stop:",
      components: [new ActionRowBuilder().addComponents(menu)],
      ephemeral: true
    });
  }
};
