const {
  SlashCommandBuilder,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  AutoModerationActionType
} = require("discord.js");
const config = require("../config");
const { isAdmin } = require("../utils");

// /ping protect | unprotect | list — admin only.
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

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Ping protection — admin only")
    .addSubcommand(s => s
      .setName("protect")
      .setDescription("Anyone who @s this user gets blocked and timed out")
      .addUserOption(o => o.setName("user").setDescription("Who to protect").setRequired(true)))
    .addSubcommand(s => s
      .setName("unprotect")
      .setDescription("Remove ping protection from a user")
      .addUserOption(o => o.setName("user").setDescription("Who to unprotect").setRequired(true)))
    .addSubcommand(s => s
      .setName("list")
      .setDescription("Show everyone who's ping protected")),

  async execute(interaction) {
    if (!interaction.guild || !isAdmin(interaction.member)) {
      return interaction.reply({ content: "No permission.", flags: 64 });
    }

    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: 64 });

    try {
      const guild = interaction.guild;
      let rule = await findRule(guild);
      const current = rule?.triggerMetadata?.keywordFilter || [];

      if (sub === "list") {
        if (!current.length) return interaction.editReply("Nobody is ping protected.");
        const lines = current.map(k => k.replace(/[^0-9]/g, "")).filter(Boolean).map(id => `<@${id}>`);
        return interaction.editReply({
          content: `🛡️ Ping protected (${lines.length}):\n${lines.join("\n")}`,
          allowedMentions: { parse: [] }
        });
      }

      const user = interaction.options.getUser("user");
      const keyword = `<@${user.id}>`;

      if (sub === "protect") {
        if (current.includes(keyword)) {
          return interaction.editReply({ content: `${keyword} is already protected.`, allowedMentions: { parse: [] } });
        }
        const next = [...current, keyword];

        if (!rule) {
          await guild.autoModerationRules.create({
            name: RULE_NAME,
            eventType: AutoModerationRuleEventType.MessageSend,
            triggerType: AutoModerationRuleTriggerType.Keyword,
            triggerMetadata: { keywordFilter: next },
            actions: buildActions(),
            enabled: true,
            exemptRoles: EXEMPT_ROLES,
            reason: `Ping protection added for ${user.tag} by ${interaction.user.tag}`
          });
        } else {
          await rule.edit({
            triggerMetadata: { keywordFilter: next },
            actions: buildActions(),
            enabled: true,
            reason: `Ping protection added for ${user.tag} by ${interaction.user.tag}`
          });
        }
        return interaction.editReply({
          content: `🛡️ ${keyword} is now ping protected. Anyone who @s them gets blocked and timed out for ${TIMEOUT_SECONDS / 60} minutes.`,
          allowedMentions: { parse: [] }
        });
      }

      if (sub === "unprotect") {
        if (!rule || !current.includes(keyword)) {
          return interaction.editReply({ content: `${keyword} isn't protected.`, allowedMentions: { parse: [] } });
        }
        const next = current.filter(k => k !== keyword);
        if (!next.length) {
          // AutoMod won't keep a keyword rule with no keywords, so remove the rule.
          await rule.delete(`Last ping protection removed by ${interaction.user.tag}`);
        } else {
          await rule.edit({
            triggerMetadata: { keywordFilter: next },
            reason: `Ping protection removed for ${user.tag} by ${interaction.user.tag}`
          });
        }
        return interaction.editReply({ content: `✅ ${keyword} is no longer ping protected.`, allowedMentions: { parse: [] } });
      }
    } catch (err) {
      console.error("/ping failed:", err);
      return interaction.editReply("❌ Couldn't update AutoMod — make sure I have **Manage Server** and **Moderate Members**.");
    }
  }
};
