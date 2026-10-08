const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { isAdmin } = require("../utils");
const { addSponsor, formatMoney } = require("../stats");
const { refreshCard } = require("../statsCards");
const { recordLbSponsor } = require("../lb");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("sponsor-add")
    .setDescription("Log a sponsorship from a user")
    .addUserOption(o => o.setName("user").setDescription("Who sponsored").setRequired(true))
    .addNumberOption(o => o.setName("amount").setDescription("Amount sponsored").setRequired(true).setMinValue(0.01)),

  async execute(interaction) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    const target = interaction.options.getUser("user");
    const amount = interaction.options.getNumber("amount");
    const total = addSponsor(target.id, amount);

    // If this user has a /staff-stats card open somewhere, update it live.
    refreshCard(interaction.client, target.id).catch(() => {});
    recordLbSponsor(interaction.client, interaction.guild.id, target.id, amount).catch(() => {});

    const embed = new EmbedBuilder()
      .setColor("#8B5CF6")
      .setTitle("💸 Sponsorship logged")
      .addFields(
        { name: "Sponsor", value: `${target}`, inline: true },
        { name: "This sponsorship", value: `$${formatMoney(amount)}`, inline: true },
        { name: "Total sponsored", value: `$${formatMoney(total)}`, inline: true }
      )
      .setFooter({ text: `Logged by ${interaction.user.tag}` });

    return interaction.reply({ embeds: [embed] });
  }
};
