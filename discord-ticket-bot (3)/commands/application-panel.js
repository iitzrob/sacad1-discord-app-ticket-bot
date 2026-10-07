const { SlashCommandBuilder, ChannelType } = require("discord.js");
const { isStaff } = require("../utils");
const { sendApplicationPanel } = require("../applications");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("application-panel")
    .setDescription("Send the application panel")
    .addChannelOption(o => o.setName("channel").setDescription("Channel to send it in (defaults to this channel)").addChannelTypes(ChannelType.GuildText).setRequired(false)),

  async execute(interaction) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    const target = interaction.options.getChannel("channel") || interaction.channel;
    const sent = await sendApplicationPanel(target);
    if (!sent) {
      return interaction.reply({ content: "No application types are enabled in config.js.", ephemeral: true });
    }
    return interaction.reply({ content: `✅ Application panel sent in ${target}.`, ephemeral: true });
  }
};
