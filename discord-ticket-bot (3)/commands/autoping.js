const { SlashCommandBuilder, ChannelType } = require("discord.js");
const { isAdmin } = require("../utils");
const autoping = require("../autoping");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("autoping")
    .setDescription("Ping new members in a channel")
    .addSubcommand(s =>
      s.setName("set")
        .setDescription("Set the channel")
        .addChannelOption(o =>
          o.setName("channel")
            .setDescription("Channel to ping in")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption(o =>
          o.setName("channel_id")
            .setDescription("Or paste a channel ID")))
    .addSubcommand(s =>
      s.setName("off")
        .setDescription("Turn it off")),

  async execute(interaction) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    if (interaction.options.getSubcommand() === "off") {
      const had = autoping.clearChannel(interaction.guildId);
      return interaction.reply({ content: had ? "Auto ping is off." : "It wasn't on.", ephemeral: true });
    }

    const picked = interaction.options.getChannel("channel");
    const id = picked?.id ?? interaction.options.getString("channel_id")?.trim();
    if (!id) {
      return interaction.reply({ content: "Pick a channel or paste a channel ID.", ephemeral: true });
    }

    const channel = await interaction.guild.channels.fetch(id).catch(() => null);
    if (!channel?.isTextBased()) {
      return interaction.reply({ content: "I can't find that text channel.", ephemeral: true });
    }

    autoping.setChannel(interaction.guildId, channel.id);
    return interaction.reply({
      content: `New members will be pinged in ${channel} and deleted after 5s.`,
      ephemeral: true
    });
  }
};
