const {
  SlashCommandBuilder, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder,
  SeparatorSpacingSize, ActionRowBuilder, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ComponentType, MessageFlags, PermissionsBitField
} = require("discord.js");
const { hasFullAccess } = require("../utils");
const { getPrefix, setPrefix, validatePrefix } = require("../prefixConfig");

const COLOR = 0x8B5CF6;
const NO_PINGS = { parse: [] };
const V2_EPHEMERAL = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

// Administrator permission only (the owner and the full access role always pass too).
function canUse(member) {
  return hasFullAccess(member) || member.permissions.has(PermissionsBitField.Flags.Administrator);
}

function divider() {
  return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
}

function commandList(p) {
  return [
    `**${p}s**\nShows the last deleted message in the channel. Staff only.`,
    `**${p}lock** and **${p}unlock**\nLocks the channel, or restores it to how it was. Admins and the lock role.`,
    `**${p}purge <amount>**\nDeletes 1 to 100 recent messages. Admins only.`,
    `**${p}roast @user**\nSends a random roast at someone. Has a cooldown.`,
    `**${p}afk [reason]**\nMarks you as AFK until you send another message.`,
    `**${p}dm @user <message>**\nSends a DM through the bot. One specific user only.`,
    `**${p}advertise <count> <ad text>**\nStarts an ad that DMs new joiners until it reaches the count. Admins and the advertise role.`,
    `**${p}adstop <count>**\nStops the running ad with that count. Admins and the advertise role.`,
    `**${p}requestclose**\nIn a ticket, asks the opener to accept or deny closing it. Staff and the request close roles.`
  ].join("\n\n");
}

function buildMenu(selected, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("prefix_menu")
      .setPlaceholder("Choose an option")
      .setDisabled(disabled)
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel("Prefix Commands")
          .setDescription("See every prefix command and what it does")
          .setValue("commands")
          .setDefault(selected === "commands"),
        new StringSelectMenuOptionBuilder()
          .setLabel("Prefix Change")
          .setDescription("Change the prefix the bot listens for")
          .setValue("change")
          .setDefault(selected === "change")
      )
  );
}

function buildPanel(guildId, view, disabled = false, notice = "") {
  const p = getPrefix(guildId);
  let body;
  if (view === "commands") {
    body = `## Prefix Commands\nCurrent prefix: \`${p}\`\n\n${commandList(p)}`;
  } else if (view === "changed") {
    body = `## Prefix Updated\n${notice}\n\nCurrent prefix: \`${p}\``;
  } else {
    body = `## Prefix\nCurrent prefix: \`${p}\`\n\nChoose an option below.`;
  }

  return new ContainerBuilder()
    .setAccentColor(COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addSeparatorComponents(divider())
    .addActionRowComponents(buildMenu(view === "commands" ? "commands" : null, disabled));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("prefix")
    .setDescription("See the prefix commands or change the prefix"),

  async execute(interaction) {
    if (!interaction.guild || !canUse(interaction.member)) {
      return interaction.reply({ content: "No permission.", flags: MessageFlags.Ephemeral });
    }

    const guildId = interaction.guild.id;
    const response = await interaction.reply({
      components: [buildPanel(guildId, "home")],
      flags: V2_EPHEMERAL,
      allowedMentions: NO_PINGS
    });

    // The menu works for 10 minutes, then disables itself.
    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 10 * 60 * 1000
    });

    collector.on("collect", async menu => {
      if (menu.user.id !== interaction.user.id) {
        return menu.reply({ content: "This menu isn't for you.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }

      try {
        const choice = menu.values[0];

        if (choice === "commands") {
          return await menu.update({ components: [buildPanel(guildId, "commands")], allowedMentions: NO_PINGS });
        }

        // Prefix Change -> ask for the new prefix in a small popup.
        const modal = new ModalBuilder()
          .setCustomId("prefix_modal")
          .setTitle("Change Prefix")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("prefix_value")
                .setLabel("New prefix (1-3 symbols, e.g. ! or ?)")
                .setStyle(TextInputStyle.Short)
                .setMinLength(1)
                .setMaxLength(3)
                .setRequired(true)
                .setValue(getPrefix(guildId))
            )
          );

        await menu.showModal(modal);

        const submit = await menu.awaitModalSubmit({
          filter: m => m.customId === "prefix_modal" && m.user.id === interaction.user.id,
          time: 2 * 60 * 1000
        }).catch(() => null);
        if (!submit) return;

        const result = validatePrefix(submit.fields.getTextInputValue("prefix_value"));
        if (!result.ok) {
          return await submit.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
        }

        const old = getPrefix(guildId);
        setPrefix(guildId, result.prefix);

        const notice = old === result.prefix
          ? "The prefix is already that."
          : `Changed from \`${old}\` to \`${result.prefix}\`. Commands now start with \`${result.prefix}\`.`;
        await submit.update({ components: [buildPanel(guildId, "changed", false, notice)], allowedMentions: NO_PINGS });
      } catch (err) {
        console.error("Error in /prefix menu:", err);
        const payload = { content: "Something went wrong.", flags: MessageFlags.Ephemeral };
        if (menu.replied || menu.deferred) await menu.followUp(payload).catch(() => {});
        else await menu.reply(payload).catch(() => {});
      }
    });

    collector.on("end", () => {
      interaction.editReply({ components: [buildPanel(guildId, "home", true)] }).catch(() => {});
    });
  }
};
