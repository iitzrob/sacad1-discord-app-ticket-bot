const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("membercount")
    .setDescription("Shows the server's member count and boost count"),

  async execute(interaction) {
    const guild = interaction.guild;
    if (!guild) {
      return interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    }

    // guild.memberCount is always accurate and needs no member fetch. (The old
    // guild.members.fetch() loaded EVERY member into memory permanently.)
    const totalMembers = guild.memberCount;
    const boosts = guild.premiumSubscriptionCount ?? 0;
    const boostTier = guild.premiumTier ?? 0;

    const embed = new EmbedBuilder()
      .setColor("#8B5CF6")
      .setTitle(`📊 ${guild.name}`)
      .setThumbnail(guild.iconURL() || null)
      .addFields(
        { name: "👥 Members", value: `${totalMembers} total`, inline: true },
        { name: "🚀 Boosts", value: `${boosts} boosts\nLevel ${boostTier}`, inline: true }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
};
