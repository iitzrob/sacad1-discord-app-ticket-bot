const { SlashCommandBuilder, ChannelType } = require("discord.js");
const { isStaff } = require("../utils");
const { sendServiceTicketPanel } = require("../service-tickets");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("service-ticket-panel")
    .setDescription("send the build panel")
    .addChannelOption(o => o.setName("channel").setDescription("Channel to send it in (defaults to this channel)").addChannelTypes(ChannelType.GuildText).setRequired(false)),

  async execute(interaction) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    const target = interaction.options.getChannel("channel") || interaction.channel;
    await sendServiceTicketPanel(target);
    return interaction.reply({ content: `✅ Service ticket panel sent in ${target}.`, ephemeral: true });
  }
};
