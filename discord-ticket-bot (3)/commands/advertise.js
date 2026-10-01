const {
  SlashCommandBuilder, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder,
  SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ComponentType, MessageFlags
} = require("discord.js");
const { hasFullAccess } = require("../utils");
const { findCampaignByTarget, getCampaignById } = require("../advertise");

// Same role that's allowed to use ,advertise and ,adstop (see index.js).
const ADVERTISE_ROLE_ID = "1538332080469966998";
const COLOR = 0x8B5CF6;
const MAX_CHARS = 3500; // Components V2 allows 4000 characters of text per message
const NO_PINGS = { parse: [] };
const V2_EPHEMERAL = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

function canUse(member) {
  return hasFullAccess(member) || member.roles.cache.has(ADVERTISE_ROLE_ID);
}

function statusOf(c) {
  if (c.active) return "Running";
  return c.sent >= c.target ? "Complete" : "Stopped";
}

function divider() {
  return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
}

function buildPanel(c, label, disabled = false) {
  const started = Math.floor(new Date(c.createdAt).getTime() / 1000);

  return new ContainerBuilder()
    .setAccentColor(COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## Ad Delivery\n${label} - ${c.target}`)
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Sent to**\n${c.sent.toLocaleString("en-US")} of ${c.target.toLocaleString("en-US")} members\n\n` +
        `**Status**\n${statusOf(c)}\n\n` +
        `**Started**\n<t:${started}:R> by <@${c.createdBy}>`
      )
    )
    .addSeparatorComponents(divider())
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("adsee_recipients")
          .setLabel("See Recipients")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled)
      )
    );
}

// Splits the recipient list into message-sized chunks so everyone is shown.
function buildRecipientPanels(c) {
  const recipients = Array.isArray(c.recipients) ? c.recipients : [];

  if (!recipients.length) {
    const note = c.sent > 0
      ? "The recipient list wasn't recorded for this ad - it was sent before tracking was added."
      : "Nobody has received this ad yet.";
    return [
      new ContainerBuilder().setAccentColor(COLOR)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Recipients\n${note}`))
    ];
  }

  const lines = recipients.map((r, i) => {
    const when = r.at ? ` - <t:${Math.floor(r.at / 1000)}:R>` : "";
    return `**${i + 1}.** <@${r.id}>${when}`;
  });

  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > MAX_CHARS) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current) chunks.push(current);

  // Ads that were already running before tracking was added only have the
  // recipients from after the update — say so instead of looking complete.
  const missing = c.sent - recipients.length;
  const partial = missing > 0
    ? `\n\n${missing} earlier recipient${missing === 1 ? " wasn't" : "s weren't"} recorded.`
    : "";

  return chunks.map((text, i) =>
    new ContainerBuilder().setAccentColor(COLOR)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `## Recipients${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ""}\n${text}` +
          (i === chunks.length - 1 ? partial : "")
        )
      )
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("adsee")
    .setDescription("See how many members an ad was sent to, and who")
    .addStringOption(o =>
      o.setName("ad")
        .setDescription("The ad that was bought, e.g. Members;30")
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!interaction.guild || !canUse(interaction.member)) {
      return interaction.reply({ content: "No permission.", flags: MessageFlags.Ephemeral });
    }

    // "Members;30" -> label "Members", amount 30 (a bare "30" works too)
    const input = interaction.options.getString("ad").trim();
    const match = input.match(/^(?:([^;]+?)\s*;\s*)?(\d+)$/);
    if (!match) {
      return interaction.reply({
        content: "Use the format `Members;30` - the name of the ad, a semicolon, then the amount.",
        flags: MessageFlags.Ephemeral
      });
    }

    const label = match[1] || "Members";
    const amount = parseInt(match[2], 10);

    const campaign = findCampaignByTarget(interaction.guild.id, amount);
    if (!campaign) {
      return interaction.reply({
        content: `No ad found with an amount of ${amount}.`,
        flags: MessageFlags.Ephemeral
      });
    }

    const response = await interaction.reply({
      components: [buildPanel(campaign, label)],
      flags: V2_EPHEMERAL,
      allowedMentions: NO_PINGS
    });

    // The button works for 10 minutes, then gets disabled.
    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 10 * 60 * 1000
    });

    collector.on("collect", async btn => {
      if (btn.user.id !== interaction.user.id) {
        return btn.reply({ content: "This button isn't for you.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }

      try {
        // Re-read the campaign so a still-running ad shows its latest recipients.
        const fresh = getCampaignById(campaign.id) || campaign;
        const panels = buildRecipientPanels(fresh);

        await btn.reply({ components: [panels[0]], flags: V2_EPHEMERAL, allowedMentions: NO_PINGS });
        for (const extra of panels.slice(1)) {
          await btn.followUp({ components: [extra], flags: V2_EPHEMERAL, allowedMentions: NO_PINGS });
        }
      } catch (err) {
        console.error("Error in /adsee button:", err);
        const payload = { content: "Something went wrong.", flags: MessageFlags.Ephemeral };
        if (btn.replied || btn.deferred) await btn.followUp(payload).catch(() => {});
        else await btn.reply(payload).catch(() => {});
      }
    });

    collector.on("end", () => {
      const fresh = getCampaignById(campaign.id) || campaign;
      interaction.editReply({ components: [buildPanel(fresh, label, true)] }).catch(() => {});
    });
  }
};
