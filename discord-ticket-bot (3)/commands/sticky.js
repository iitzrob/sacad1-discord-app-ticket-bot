const { SlashCommandBuilder } = require("discord.js");
const { isStaff } = require("../utils");
const { setSticky } = require("../sticky");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("sticky")
    .setDescription("Stick a message to the bottom of this channel")
    .addStringOption(o =>
      o.setName("message")
        .setDescription("The message to stick")
        .setRequired(true)),

  async execute(interaction) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    const content = interaction.options.getString("message");

    try {
      await setSticky(interaction.channel, content);
    } catch (err) {
      console.error("Failed to set sticky:", err);
      return interaction.reply({ content: "⚠️ Couldn't set the sticky message. Check my permissions in this channel.", ephemeral: true });
    }

    return interaction.reply({ content: "📌 Sticky message set for this channel.", ephemeral: true });
  }
};
