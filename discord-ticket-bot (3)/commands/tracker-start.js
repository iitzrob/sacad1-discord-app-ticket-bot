const {
  SlashCommandBuilder, ActionRowBuilder, UserSelectMenuBuilder,
  RoleSelectMenuBuilder, ButtonBuilder, ButtonStyle
} = require("discord.js");
const { isAdmin } = require("../utils");

// Step 1 of /tracker-start: let the admin pick any mix of individual users
// AND roles. Picking a role queues up everyone who currently holds that
// role. Users can be picked directly, via a role, or via several roles at
// once — mergeSelectionIntoIds() below always collapses this into a plain
// Set of member IDs, so no one ever ends up tracked twice no matter how
// many times (or ways) they were selected.
//
// Step 2 (the channel-ID modal) and the actual tracker creation happen in
// index.js, in response to the "tracker_select_users" / "tracker_select_roles"
// selects, the "tracker_continue" / "tracker_cancel" buttons, and the
// "tracker_channel_modal" modal submit — because a modal can't be shown
// directly from a slash command reply, it has to come from a component
// interaction.

function buildStepOneComponents() {
  const userRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId("tracker_select_users")
      .setPlaceholder("Select individual users (optional)")
      .setMinValues(0)
      .setMaxValues(25)
  );
  const roleRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId("tracker_select_roles")
      .setPlaceholder("Select roles — everyone with the role gets added (optional)")
      .setMinValues(0)
      .setMaxValues(25)
  );
  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("tracker_continue").setLabel("Continue").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("tracker_cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );
  return [userRow, roleRow, buttonRow];
}

// Collapses a raw { userIds, roleIds } selection into a deduplicated Set of
// member IDs. Needs the guild's member cache to be populated (tracker-start
// primes it in execute() below) so role.members is accurate rather than only
// reflecting whatever members happened to already be cached.
function mergeSelectionIntoIds(guild, selection) {
  const idSet = new Set(selection.userIds);
  for (const roleId of selection.roleIds) {
    const role = guild.roles.cache.get(roleId);
    if (role) role.members.forEach(m => idSet.add(m.id));
  }
  return idSet;
}

function buildStepOneContent(guild, selection) {
  const merged = mergeSelectionIntoIds(guild, selection);
  const roleText = selection.roleIds.length
    ? selection.roleIds.map(id => `<@&${id}>`).join(", ")
    : "*none*";
  const userText = selection.userIds.length
    ? `${selection.userIds.length} picked directly`
    : "*none*";

  return (
    "👥 **Step 1/2** — build your tracker list.\n" +
    "• Pick individual users below (optional)\n" +
    "• Pick roles below — everyone who currently has that role gets added automatically (optional)\n" +
    "• Overlap is fine — anyone selected more than once (directly, or via more than one role) only gets added to the tracker once\n\n" +
    `Roles selected: ${roleText}\n` +
    `Direct users: ${userText}\n` +
    `**Total unique members so far: ${merged.size}**\n\n` +
    "Click **Continue** once you're happy with the list, or **Cancel** to abort."
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("tracker-start")
    .setDescription("	Start a tracker"),

  async execute(interaction) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    // Prime the member cache now so that when the admin picks a role a
    // moment from now, role.members is accurate instead of only reflecting
    // whichever members happened to already be cached from other activity.
    await interaction.guild.members.fetch().catch(() => {});
    interaction.client.membersPrimedAt = Date.now(); // tells the member sweeper to wait

    const selection = { userIds: [], roleIds: [] };
    return interaction.editReply({
      content: buildStepOneContent(interaction.guild, selection),
      components: buildStepOneComponents()
    });
  },

  // Exported so index.js can reuse these while the admin is still picking.
  buildStepOneComponents,
  buildStepOneContent,
  mergeSelectionIntoIds
};
