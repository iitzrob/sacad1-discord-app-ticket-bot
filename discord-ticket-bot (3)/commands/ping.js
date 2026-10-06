const {
  SlashCommandBuilder,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  AutoModerationActionType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType
} = require("discord.js");
const config = require("../config");
const { isAdmin } = require("../utils");

// /ping protect [user] — admin only.
//
//  • /ping protect user:@someone  -> "@someone now has ping protection!"
//  • Run it again (with that same user, or with no user) -> a private panel
//    that lists EVERYONE who has protection, with one button per user.
//    Press a user to remove their protection.
//
// Uses Discord's built-in AutoMod. The bot keeps ONE keyword rule
// ("Ping Protection") and every protected user is stored in it as <@id>.
// When someone @s a protected user, AutoMod blocks the message (so it never
// pings them) and times the sender out.
//
// The bot needs Manage Server + Moderate Members. People with Administrator
// or Manage Server always bypass AutoMod (a Discord rule), and so do the
// staff roles listed in EXEMPT_ROLES.
const RULE_NAME = "Ping Protection";
const TIMEOUT_SECONDS = 10 * 60; // how long the sender is timed out (max 4 weeks)
const BLOCK_MESSAGE = "You can't ping this person.";
const EXEMPT_ROLES = [config.staffRole, config.bypassRole].filter(Boolean);
const NO_PINGS = { parse: [] };

async function findRule(guild) {
  const rules = await guild.autoModerationRules.fetch();
  return rules.find(r => r.name === RULE_NAME) || null;
}

function buildActions() {
  return [
    { type: AutoModerationActionType.BlockMessage, metadata: { customMessage: BLOCK_MESSAGE } },
    { type: AutoModerationActionType.Timeout, metadata: { durationSeconds: TIMEOUT_SECONDS } }
  ];
}

function idsFrom(rule) {
  return (rule?.triggerMetadata?.keywordFilter || [])
    .map(k => k.replace(/[^0-9]/g, ""))
    .filter(Boolean);
}

async function addProtection(guild, rule, userId, byTag) {
  const keyword = `<@${userId}>`;
  const next = [...(rule?.triggerMetadata?.keywordFilter || []), keyword];
  if (!rule) {
    await guild.autoModerationRules.create({
      name: RULE_NAME,
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: { keywordFilter: next },
      actions: buildActions(),
      enabled: true,
      exemptRoles: EXEMPT_ROLES,
      reason: `Ping protection added for ${userId} by ${byTag}`
    });
  } else {
    await rule.edit({
      triggerMetadata: { keywordFilter: next },
      actions: buildActions(),
      enabled: true,
      reason: `Ping protection added for ${userId} by ${byTag}`
    });
  }
}

async function removeProtection(guild, userId, byTag) {
  const rule = await findRule(guild);
  const keyword = `<@${userId}>`;
  const current = rule?.triggerMetadata?.keywordFilter || [];
  if (!rule || !current.includes(keyword)) return;
  const next = current.filter(k => k !== keyword);
  if (!next.length) {
    // AutoMod won't keep a keyword rule with no keywords, so remove the rule.
    await rule.delete(`Last ping protection removed by ${byTag}`);
  } else {
    await rule.edit({
      triggerMetadata: { keywordFilter: next },
      reason: `Ping protection removed for ${userId} by ${byTag}`
    });
  }
}

// Names of everyone protected (bulleted list) so you can see them all,
// even past the 25 buttons Discord allows on one message.
async function describe(client, ids) {
  const lines = [];
  for (const id of ids.slice(0, 40)) {
    const user = await client.users.fetch(id).catch(() => null);
    lines.push(`• @${user?.username || id}`);
  }
  if (ids.length > 40) lines.push(`…and ${ids.length - 40} more`);
  return lines.join("\n");
}

// One button per protected user (max 25 = 5 rows x 5).
async function buildPanel(client, ids) {
  const rows = [];
  const shown = ids.slice(0, 25);
  for (let i = 0; i < shown.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const id of shown.slice(i, i + 5)) {
      const user = await client.users.fetch(id).catch(() => null);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`pingprot_remove_${id}`)
          .setLabel((user?.username || id).slice(0, 80))
          .setEmoji("🛡️")
          .setStyle(ButtonStyle.Secondary)
      );
    }
    rows.push(row);
  }
  return rows;
}

async function panelPayload(client, ids, intro) {
  const note = ids.length > 25 ? "\n\n_Buttons show the first 25. Remove some to reach the rest._" : "";
  return {
    content: `${intro}\n\n**Ping protected (${ids.length}):**\n${await describe(client, ids)}${note}`,
    components: await buildPanel(client, ids),
    allowedMentions: NO_PINGS
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Ping protection")
    .addSubcommand(s => s
      .setName("protect")
      .setDescription("Protect a user from pings, or open the list to remove protection")
      .addUserOption(o => o.setName("user").setDescription("User to protect").setRequired(false))),

  async execute(interaction) {
    if (!interaction.guild || !isAdmin(interaction.member)) {
      return interaction.reply({ content: "No permission.", flags: 64 });
    }

    const guild = interaction.guild;
    const user = interaction.options.getUser("user");

    try {
      // Look up who is protected BEFORE replying, so we know whether to
      // answer publicly (new protection) or privately (the removal panel).
      const rule = await findRule(guild);
      const ids = idsFrom(rule);

      // New user -> public "now has ping protection!" and nothing else.
      if (user && !ids.includes(user.id)) {
        await interaction.deferReply();
        await addProtection(guild, rule, user.id, interaction.user.tag);
        return interaction.editReply({
          content: `@${user.username} now has ping protection!`,
          allowedMentions: NO_PINGS
        });
      }

      // Already protected, or no user given -> private list of everyone protected.
      if (!ids.length) {
        return interaction.reply({ content: "Nobody is ping protected.", flags: 64 });
      }
      const intro = user
        ? `🛡️ @${user.username} already has ping protection. Press a user to **remove** their protection:`
        : "🛡️ Press a user to **remove** their ping protection:";
      await interaction.reply({ ...(await panelPayload(interaction.client, ids, intro)), flags: 64 });
      return watchPanel(interaction);
    } catch (err) {
      console.error("/ping failed:", err);
      const msg = "❌ Couldn't update AutoMod — make sure I have **Manage Server** and **Moderate Members**.";
      if (interaction.deferred || interaction.replied) return interaction.editReply({ content: msg, components: [] }).catch(() => {});
      return interaction.reply({ content: msg, flags: 64 }).catch(() => {});
    }
  }
};

async function watchPanel(interaction) {
  const msg = await interaction.fetchReply();

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: b => b.user.id === interaction.user.id && b.customId.startsWith("pingprot_remove_"),
    time: 120_000
  });

  collector.on("collect", async b => {
    const id = b.customId.slice("pingprot_remove_".length);
    try {
      await removeProtection(interaction.guild, id, interaction.user.tag);
    } catch (err) {
      console.error("/ping remove failed:", err);
      return b.reply({ content: "❌ Couldn't update AutoMod.", flags: 64 }).catch(() => {});
    }
    const removedUser = await interaction.client.users.fetch(id).catch(() => null);
    const name = `@${removedUser?.username || id}`;
    const left = idsFrom(await findRule(interaction.guild));
    if (!left.length) {
      collector.stop("empty");
      return b.update({ content: `✅ ${name} no longer has ping protection.\n\nNobody is ping protected now.`, components: [], allowedMentions: NO_PINGS });
    }
    return b.update(await panelPayload(
      interaction.client,
      left,
      `✅ ${name} no longer has ping protection.\n\n🛡️ Press another user to remove theirs:`
    ));
  });

  collector.on("end", (_c, reason) => {
    if (reason === "time") interaction.editReply({ components: [] }).catch(() => {});
  });
}
