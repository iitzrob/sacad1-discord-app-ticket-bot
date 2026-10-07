const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { isAdmin } = require("../utils");
const { getGuildTrackers } = require("../tracker");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("tracker-list")
    .setDescription("	List trackers"),

  async execute(interaction) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    const trackers = getGuildTrackers(interaction.guild.id);
    if (!trackers.length) {
      return interaction.reply({ content: "There are no active trackers in this server.", ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setColor("#8B5CF6")
      .setTitle("📋 Active Trackers")
      .setDescription(trackers.map(t =>
        `\`${t.id}\` — <#${t.channelId}> — tracking ${t.users.length} user(s)`
      ).join("\n"));

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
};
