const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { isStaff } = require("../utils");

// Named colors people are likely to type, mapped to hex.
const NAMED_COLORS = {
  red: "#ED4245",
  green: "#57F287",
  blue: "#3498DB",
  yellow: "#FEE75C",
  orange: "#E67E22",
  purple: "#9B59B6",
  pink: "#EB459E",
  black: "#000000",
  white: "#FFFFFF",
  grey: "#95A5A6",
  gray: "#95A5A6",
  blurple: "#5865F2"
};

function resolveColor(input) {
  if (!input) return "#5865F2"; // default: Discord blurple
  const cleaned = input.trim().toLowerCase();
  if (NAMED_COLORS[cleaned]) return NAMED_COLORS[cleaned];
  const hex = cleaned.startsWith("#") ? cleaned : `#${cleaned}`;
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex : null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("embed")
    .setDescription("Send an embed")
    .addStringOption(o =>
      o.setName("description")
        .setDescription("The main text of the message")
        .setRequired(true))
    .addStringOption(o =>
      o.setName("title")
        .setDescription("Optional embed title")
        .setRequired(false))
    .addStringOption(o =>
      o.setName("colour")
        .setDescription("Optional embed colour (hex like #FF0000, or a name like red/blue/green)")
        .setRequired(false))
    .addBooleanOption(o =>
      o.setName("plaintext")
        .setDescription("Send as plain text instead of an embed (default: false)")
        .setRequired(false)),

  async execute(interaction) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    const description = interaction.options.getString("description");
    const title = interaction.options.getString("title");
    const colourInput = interaction.options.getString("colour");
    const plaintext = interaction.options.getBoolean("plaintext") ?? false;

    if (plaintext) {
      const content = title ? `**${title}**\n${description}` : description;
      await interaction.channel.send({ content });
      return interaction.reply({ content: "✅ Sent.", ephemeral: true });
    }

    const color = resolveColor(colourInput);
    if (colourInput && !color) {
      return interaction.reply({
        content: "⚠️ That colour isn't valid. Use a hex code like `#FF0000` or a name like `red`, `blue`, `green`, etc.",
        ephemeral: true
      });
    }

    const embed = new EmbedBuilder()
      .setDescription(description)
      .setColor(color);

    if (title) embed.setTitle(title);

    await interaction.channel.send({ embeds: [embed] });
    return interaction.reply({ content: "✅ Sent.", ephemeral: true });
  }
};
