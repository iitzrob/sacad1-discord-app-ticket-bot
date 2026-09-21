const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType
} = require("discord.js");
const { isAdmin } = require("../utils");
const { getAll } = require("../ign");

const COLOR = 0x8B5CF6;
const MAX_DESCRIPTION = 3900; // Discord's embed description limit is 4096

function buildRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("linked_users_total")
      .setLabel("Total Links")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("linked_users_list")
      .setLabel("See Linked IGN's")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
}

// Splits the linked users into embed-sized chunks so every one of them is shown.
async function buildListEmbeds(guild) {
  const all = getAll().sort((a, b) => a.ign.toLowerCase().localeCompare(b.ign.toLowerCase()));

  // Load members so we can tell who has left the server (best effort).
  let membersLoaded = true;
  await guild.members.fetch().catch(() => { membersLoaded = false; });

  const lines = all.map((entry, index) => {
    const left = membersLoaded && !guild.members.cache.has(entry.userId) ? " *(left server)*" : "";
    return `**${index + 1}.** <@${entry.userId}> — \`${entry.ign}\`${left}`;
  });

  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > MAX_DESCRIPTION) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current) chunks.push(current);

  return chunks.map((description, index) =>
    new EmbedBuilder()
      .setColor(COLOR)
      .setTitle(chunks.length > 1 ? `Linked IGN's (${index + 1}/${chunks.length})` : "Linked IGN's")
      .setDescription(description)
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("linked-users")
    .setDescription("See who has linked their Minecraft IGN"),

  async execute(interaction) {
    if (!interaction.guild || !isAdmin(interaction.member)) {
      return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle("Linked IGN's")
      .setDescription("Here you can see who's linked their IGN, and how many people in total have.");

    const response = await interaction.reply({
      embeds: [embed],
      components: [buildRow()],
      ephemeral: true
    });

    // The buttons work for 10 minutes, then get disabled.
    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 10 * 60 * 1000
    });

    collector.on("collect", async btn => {
      if (btn.user.id !== interaction.user.id) {
        return btn.reply({ content: "These buttons aren't for you.", ephemeral: true }).catch(() => {});
      }

      try {
        // ---- Total Links: a second reply with just the count ----
        if (btn.customId === "linked_users_total") {
          const total = getAll().length;
          const totalEmbed = new EmbedBuilder()
            .setColor(COLOR)
            .setTitle("Total Links")
            .setDescription(`**${total.toLocaleString("en-US")}** ${total === 1 ? "person has" : "people have"} linked their IGN.`);
          return btn.reply({ embeds: [totalEmbed], ephemeral: true });
        }

        // ---- See Linked IGN's: every user + their IGN ----
        if (btn.customId === "linked_users_list") {
          await btn.deferReply({ ephemeral: true });

          const embeds = await buildListEmbeds(interaction.guild);
          if (!embeds.length) {
            return btn.editReply({ content: "Nobody has linked their IGN yet." });
          }

          await btn.editReply({ embeds: [embeds[0]], allowedMentions: { parse: [] } });
          for (const extra of embeds.slice(1)) {
            await btn.followUp({ embeds: [extra], ephemeral: true, allowedMentions: { parse: [] } });
          }
        }
      } catch (err) {
        console.error("Error in /linked-users button:", err);
        const payload = { content: "❌ Something went wrong.", ephemeral: true };
        if (btn.replied || btn.deferred) await btn.followUp(payload).catch(() => {});
        else await btn.reply(payload).catch(() => {});
      }
    });

    collector.on("end", () => {
      interaction.editReply({ components: [buildRow(true)] }).catch(() => {});
    });
  }
};
