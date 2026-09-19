const fs = require("fs");
const path = require("path");
const {
  Client, GatewayIntentBits, Partials, ChannelType, PermissionsBitField,
  ActionRowBuilder, EmbedBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle, Collection,
  AttachmentBuilder, ActivityType
} = require("discord.js");
const config = require("./config");
const { isStaff, isBuildStaff, isAdmin, hasFullAccess } = require("./utils");
const { tickets, sendTicketPanel, logTicketEvent, buildTranscript, addJumpToWinButton } = require("./tickets");
const {
  serviceTickets, parseDimensions, calculateDigoutCost, formatPrice,
  sendServiceTicketPanel
} = require("./service-tickets");
const { sendWelcomeMessage } = require("./welcome");
const { createCampaign, stopCampaignByTarget, handleMemberJoinAds } = require("./advertise");
const {
  APPLICATION_TYPES, sessions,
  startApplication, cancelApplication, submitAnswer, sendApplicationPanel
} = require("./applications");
const { recordDeletedMessage, getSnipe, buildSnipeEmbed } = require("./snipe");
const { handleMessageForSticky } = require("./sticky");
const { setAfk, clearAfk, getAfk } = require("./afk");
const { recordClaim, recordClose } = require("./stats");
const { buildLeaderboardEmbed, buildLeaderboardMenu } = require("./stats");
const { refreshCard } = require("./statsCards");
const {
  createTracker, recordTrackerEvent, stopTracker, startWeeklyResetScheduler
} = require("./tracker");
const { getLockSnapshot, setLockSnapshot, deleteLockSnapshot } = require("./locks");
const { touchActivity, getLastActivity, deleteActivity } = require("./ticketActivity");
const {
  buildStepOneComponents: buildTrackerStepOneComponents,
  buildStepOneContent: buildTrackerStepOneContent,
  mergeSelectionIntoIds: mergeTrackerSelectionIntoIds
} = require("./commands/tracker-start");

// channelId -> claimer's user id. Lives in ./ticketClaims (not a local Map
// here) so commands/close.js can read the same claim lock the buttons use.
const { getClaim, setClaim, deleteClaim } = require("./ticketClaims");
const { getIGN, findByIGN, setIGN, logIGNEvent } = require("./ign");
const { parseAmount, findGiveawayWin, formatAmountShort } = require("./giveawayChecker");
const { isGiveawayChecked, markGiveawayChecked } = require("./giveawayChecks");

// staffUserId -> { userIds, roleIds }, held while the admin is still
// picking users/roles in step 1 of /tracker-start.
const pendingTrackerSelection = new Map();

// staffUserId -> final deduplicated array of member IDs, held between the
// "Continue" button (end of step 1) and the channel-ID modal step of
// /tracker-start. In-memory only — if the bot restarts mid-setup, the
// admin just has to run it again.
const pendingTrackerSetup = new Map();

const LOCK_PERMS = ["SendMessages"];

function isServiceChannel(channel) {
  return Object.values(config.serviceCategories).includes(channel.parentId);
}

// ---------- Giveaway claim amount check ----------
// Looks up config.giveawayCheck.channels for a message mentioning the
// ticket owner with a matching amount, posts a clear Yes/No result in the
// ticket, and (if a win is found) adds a "Jump to Win" button onto the
// ticket panel message. Only ever runs once per ticket (tracked in
// giveawayChecks.js), whether triggered from the modal or from a later
// plain-text message.
async function runGiveawayCheck(channel, ownerId, amount) {
  if (isGiveawayChecked(channel.id)) return;
  markGiveawayChecked(channel.id);

  const result = await findGiveawayWin(channel.guild, ownerId, amount);

  if (!result.configured) {
    const emb = new EmbedBuilder()
      .setColor("#F04747")
      .setTitle("❌ No Matching Win Found")
      .setDescription(
        `No matching win found for **${formatAmountShort(amount)}**.\n\n` +
        "(Note for staff: `giveawayCheck.channels` isn't set in config.js yet, so this is unverified — please double check manually.)"
      )
      .setTimestamp();
    return channel.send({ embeds: [emb] }).catch(() => {});
  }

  if (result.found) {
    const emb = new EmbedBuilder()
      .setColor("#57F287")
      .setTitle("✅ Win Found")
      .setDescription(`Found a matching win for **${formatAmountShort(amount)}**!`)
      .setTimestamp();
    await channel.send({ embeds: [emb] }).catch(() => {});
    await addJumpToWinButton(channel, result.message.url);
  } else {
    const emb = new EmbedBuilder()
      .setColor("#F04747")
      .setTitle("❌ No Matching Win Found")
      .setDescription(`No matching win found for **${formatAmountShort(amount)}** in the configured giveaway channels. Staff can still verify manually.`)
      .setTimestamp();
    await channel.send({ embeds: [emb] }).catch(() => {});
  }
}

// A ticket channel this bot actually created always has its opener's user
// ID set as the channel topic (same check /close and /ticket-rename use).
function isTicketChannel(channel) {
  const inTicketCategory = channel.parentId && (
    Object.values(config.categories).includes(channel.parentId)
    || Object.values(config.serviceCategories).includes(channel.parentId)
    || channel.parentId === config.buyAd.category
  );
  return inTicketCategory && /^\d{15,25}$/.test(channel.topic || "");
}

// Shared by the normal Close button/modal flow, ,requestclose's Accept
// button, AND the auto-close scheduler — builds/sends the transcript, DMs
// the opener, logs it, and deletes the channel. Everything else (the
// initial ack, permission checks) is handled by whichever flow calls this.
// Pass { auto: true, days } for an automatic inactivity close — swaps the
// DM/log wording to "Auto Closed" / "Inactive for N days" and skips
// attributing a staff "close" stat to whoever/whatever triggered it.
async function performTicketClose(guild, channel, closedByUser, reason, opts = {}) {
  const auto = !!opts.auto;
  const days = opts.days;
  deleteClaim(channel.id);
  deleteActivity(channel.id);
  if (!auto) {
    recordClose(closedByUser.id);
    refreshCard(client, closedByUser.id).catch(() => {});
    recordTrackerEvent(client, guild.id, closedByUser.id, "closes").catch(() => {});
  }

  try {
    const { content, filename } = await buildTranscript(channel, reason);

    const openerId = channel.topic;
    const opener = await client.users.fetch(openerId).catch(() => null);
    if (opener) {
      await opener.send({
        content: auto
          ? `🔒 **Auto Closed**\n**Inactive for ${days} days** — here's the transcript for your ticket **#${channel.name}**.`
          : `📄 Here's the transcript for your ticket **#${channel.name}**.`,
        files: [new AttachmentBuilder(Buffer.from(content, "utf-8"), { name: filename })]
      }).catch(() => {});
    }

    await logTicketEvent(guild, {
      title: auto ? "Ticket Auto Closed" : "Ticket Closed",
      ticketChannel: `#${channel.name}`,
      category: channel.parent?.name,
      openedBy: opener ? `<@${opener.id}>` : (openerId ? `<@${openerId}>` : "Unknown"),
      actionLabel: "Closed by",
      actionBy: closedByUser,
      reason: auto ? `Inactive for ${days} days` : reason,
      color: 0xF04747,
      files: [new AttachmentBuilder(Buffer.from(content, "utf-8"), { name: filename })]
    });
  } catch (err) {
    // Code 10003 (Unknown Channel) / 50001 (Missing Access) mean the
    // channel is already gone on Discord's side — deleted manually or by
    // an earlier close, with a stale reference left behind in the local
    // cache. There's nothing to transcript and nothing left to delete, so
    // instead of erroring on it forever (every scan, every restart), evict
    // it from the cache and move on quietly.
    if (err.code === 10003 || err.code === 50001) {
      guild.channels.cache.delete(channel.id);
      console.warn(`#${channel.name} (${channel.id}) no longer exists on Discord — clearing it from tracking, nothing more to do.`);
      return;
    }

    console.error(`Failed to build/send transcript for #${channel.name}:`, err);
    // Show the actual error in the log channel itself, not just the
    // console — most hosts (Railway, etc.) bury console output somewhere
    // you have to dig for, so surfacing it here means you can see exactly
    // why it failed without leaving Discord.
    const errText = (err?.message || String(err)).slice(0, 500);
    const baseReason = auto ? `Inactive for ${days} days` : reason;
    await logTicketEvent(guild, {
      title: auto ? "Ticket Auto Closed" : "Ticket Closed",
      ticketChannel: `#${channel.name}`,
      category: channel.parent?.name,
      openedBy: channel.topic ? `<@${channel.topic}>` : "Unknown",
      actionLabel: "Closed by",
      actionBy: closedByUser,
      reason: `${baseReason ? `${baseReason}\n` : ""}⚠️ Transcript failed: \`${errText}\``,
      color: 0xF04747
    });
  }

  setTimeout(() => channel.delete().catch(() => {}), 3000);
}

// =====================================================================
// AUTO-CLOSE — scans every open ticket channel and closes any that have
// been inactive too long. Regular tickets (buying/selling/partnership/
// giveaway/gamble/help/buy-ad) use config.autoClose.inactivityMs (default
// 5 days); digout/base building tickets (config.serviceCategories) use
// config.autoClose.serviceInactivityMs instead (default 10 days), since
// build orders naturally sit longer between replies. Activity is tracked
// in ticketActivity.js, touched on ticket creation and on every message
// sent in a ticket channel (see the messageCreate listener below). If a
// ticket has no recorded activity at all (e.g. bot restarted and it's an
// old entry), falls back to the channel's creation time.
// =====================================================================
async function checkAutoCloseTickets() {
  if (config.autoClose && config.autoClose.enabled === false) return;
  const inactivityMs = config.autoClose?.inactivityMs ?? 5 * 24 * 60 * 60 * 1000;
  const serviceInactivityMs = config.autoClose?.serviceInactivityMs ?? 10 * 24 * 60 * 60 * 1000;

  const guild = (config.guildId && client.guilds.cache.get(config.guildId)) || client.guilds.cache.first();
  if (!guild) return;

  const serviceParentIds = new Set(Object.values(config.serviceCategories));
  const ticketParentIds = new Set([
    ...Object.values(config.categories),
    ...serviceParentIds,
    config.buyAd.category
  ]);

  const now = Date.now();
  const candidates = guild.channels.cache.filter(ch =>
    ch.type === ChannelType.GuildText && ticketParentIds.has(ch.parentId) && isTicketChannel(ch)
  );

  for (const channel of candidates.values()) {
    const isService = serviceParentIds.has(channel.parentId);
    const threshold = isService ? serviceInactivityMs : inactivityMs;
    const lastActivity = getLastActivity(channel.id) ?? channel.createdTimestamp;
    if (now - lastActivity < threshold) continue;
    try {
      const days = Math.round(threshold / (24 * 60 * 60 * 1000));
      await performTicketClose(guild, channel, client.user, null, { auto: true, days });
    } catch (err) {
      console.error(`Auto-close failed for #${channel.name}:`, err);
    }
  }
}

// Role allowed to use ,requestclose.
const REQUEST_CLOSE_ROLE_ID = "1482008632747884736";
const REQUEST_CLOSE_ROLE_ID_2 = "1536195433393557545";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

// =====================================================================
// CRASH GUARDS
// discord.js emits an "error" event on the client for things like a
// modal shown on an interaction that already expired (10062 Unknown
// interaction) or a reply sent twice (40060 already acknowledged) —
// totally normal, everyday timing hiccups, NOT bugs worth taking the
// whole bot down for. With no listener attached, Node's default
// behaviour for an unhandled "error" event is to crash the process,
// which is what was killing ,lock/,unlock/close: one bad interaction
// anywhere would kill the entire bot mid-command. These two listeners
// just log the error instead of crashing, so one flaky interaction
// can't take every other command down with it.
client.on("error", err => console.error("Discord client error:", err));
process.on("unhandledRejection", err => console.error("Unhandled rejection:", err));

// =====================================================================
// COMMAND LOADER
// Drop a new file in ./commands (exporting { data, execute }) and it's
// picked up automatically — no need to touch this file. Remember to run
// `node deploy-commands.js` afterwards so Discord knows about it.
// =====================================================================
client.commands = new Collection();

const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith(".js"));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (!command?.data || !command?.execute) {
    console.warn(`⚠️  Skipping ${file} — missing "data" or "execute" export.`);
    continue;
  }
  client.commands.set(command.data.name, command);
}

// =====================================================================
// READY
// =====================================================================
client.once("ready", () => {
  console.log(`Ready — loaded ${client.commands.size} command(s): ${[...client.commands.keys()].join(", ")}`);
  console.log("Note: slash commands are registered via `node deploy-commands.js`, not on startup.");
  client.user.setActivity("discord.gg/sacad1", { type: ActivityType.Watching });
  startWeeklyResetScheduler(client);

  // 5-day ticket auto-close — run once at startup, then on a timer.
  const autoCloseIntervalMs = config.autoClose?.checkIntervalMs ?? 15 * 60 * 1000;
  checkAutoCloseTickets().catch(err => console.error("Initial auto-close check failed:", err));
  setInterval(() => {
    checkAutoCloseTickets().catch(err => console.error("Auto-close check failed:", err));
  }, autoCloseIntervalMs);
});

// =====================================================================
// INTERACTIONS
// =====================================================================
client.on("interactionCreate", async i => {
  // ---- Slash commands ----
  if (i.isChatInputCommand()) {
    const command = client.commands.get(i.commandName);
    if (!command) return;
    try {
      await command.execute(i);
    } catch (err) {
      console.error(`Error running /${i.commandName}:`, err);
      const payload = { content: "❌ Something went wrong running that command.", ephemeral: true };
      if (i.replied || i.deferred) await i.followUp(payload).catch(() => {});
      else await i.reply(payload).catch(() => {});
    }
    return;
  }

  // ---- Tracker: step 1 selects — users and/or roles (/tracker-start) ----
  if ((i.isUserSelectMenu() && i.customId === "tracker_select_users") ||
      (i.isRoleSelectMenu() && i.customId === "tracker_select_roles")) {
    const selection = pendingTrackerSelection.get(i.user.id) || { userIds: [], roleIds: [] };
    if (i.customId === "tracker_select_users") selection.userIds = i.values;
    else selection.roleIds = i.values;
    pendingTrackerSelection.set(i.user.id, selection);

    return i.update({
      content: buildTrackerStepOneContent(i.guild, selection),
      components: buildTrackerStepOneComponents()
    });
  }

  // ---- Tracker: step 1 cancel (/tracker-start) ----
  if (i.isButton() && i.customId === "tracker_cancel") {
    pendingTrackerSelection.delete(i.user.id);
    return i.update({ content: "❌ Tracker setup cancelled.", components: [] });
  }

  // ---- Tracker: step 1 continue -> step 2 channel modal (/tracker-start) ----
  if (i.isButton() && i.customId === "tracker_continue") {
    const selection = pendingTrackerSelection.get(i.user.id) || { userIds: [], roleIds: [] };
    const mergedIds = [...mergeTrackerSelectionIntoIds(i.guild, selection)];

    if (!mergedIds.length) {
      return i.reply({
        content: "❌ Select at least one user, or a role that has members, before continuing.",
        ephemeral: true
      });
    }

    pendingTrackerSelection.delete(i.user.id);
    pendingTrackerSetup.set(i.user.id, mergedIds);

    const modal = new ModalBuilder().setCustomId("tracker_channel_modal").setTitle("Tracker channel");
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("channel_id")
        .setLabel("Channel ID to post the tracker in")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("e.g. 123456789012345678")
    ));
    return i.showModal(modal);
  }

  // ---- Tracker: channel modal submit (/tracker-start step 2) ----
  if (i.isModalSubmit() && i.customId === "tracker_channel_modal") {
    const userIds = pendingTrackerSetup.get(i.user.id);
    if (!userIds) {
      return i.reply({ content: "❌ That setup expired — please run `/tracker-start` again.", ephemeral: true });
    }

    const channelId = i.fields.getTextInputValue("channel_id").trim();
    const channel = await i.guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return i.reply({ content: "❌ Couldn't find a text channel with that ID in this server.", ephemeral: true });
    }

    pendingTrackerSetup.delete(i.user.id);
    try {
      await createTracker(client, i.guild, channel.id, userIds, i.user.id);
      return i.reply({ content: `✅ Tracker started — posting live in ${channel} and tracking ${userIds.length} user(s).`, ephemeral: true });
    } catch (err) {
      console.error("Failed to create tracker:", err);
      return i.reply({ content: "❌ Something went wrong creating the tracker — check that I have permission to send messages in that channel, then check the logs.", ephemeral: true });
    }
  }

  // ---- Tracker: stop select (/tracker-stop) ----
  if (i.isStringSelectMenu() && i.customId === "tracker_stop_select") {
    const trackerId = i.values[0];
    const removed = await stopTracker(client, trackerId);
    return i.update({
      content: removed ? `🛑 Stopped tracker \`${trackerId}\`.` : "❌ That tracker no longer exists.",
      components: []
    });
  }

  // ---- Ticket leaderboard select ----
  if (i.isStringSelectMenu() && i.customId === "ticket_leaderboard_select") {
    const field = i.values[0];
    const embed = await buildLeaderboardEmbed(client, field);
    return i.update({ embeds: [embed], components: [buildLeaderboardMenu(field)] });
  }

  // ---- Ticket select menu ----
  if (i.isStringSelectMenu() && i.customId === "ticket") {
    const t = i.values[0], v = tickets[t];
    const modal = new ModalBuilder().setCustomId("m_" + t).setTitle(v.label);
    v.questions.forEach((q, n) => {
      const input = new TextInputBuilder().setCustomId("q" + n).setLabel(q.label).setStyle(q.style).setRequired(true);
      if (q.placeholder) input.setPlaceholder(q.placeholder);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
    });
    await i.showModal(modal);
    // Re-send the panel's own components so the dropdown's selection
    // highlight clears — otherwise Discord shows a checkmark on the last
    // picked option and won't let you pick it again until it refreshes.
    await i.message.edit({ components: i.message.components }).catch(() => {});
    return;
  }

  // ---- Service ticket select menu (Digout / Base Building) ----
  if (i.isStringSelectMenu() && i.customId === "service_ticket") {
    const t = i.values[0], v = serviceTickets[t];
    const modal = new ModalBuilder().setCustomId("svcm_" + t).setTitle(v.label);
    v.questions.forEach((q, n) => {
      const input = new TextInputBuilder().setCustomId("q" + n).setLabel(q.label).setStyle(q.style).setRequired(true);
      if (q.placeholder) input.setPlaceholder(q.placeholder);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
    });
    await i.showModal(modal);
    await i.message.edit({ components: i.message.components }).catch(() => {});
    return;
  }

  // ---- Service ticket modal submit (Digout / Base Building) ----
  if (i.isModalSubmit() && i.customId.startsWith("svcm_")) {
    const t = i.customId.slice("svcm_".length), v = serviceTickets[t];
    const ign = i.fields.getTextInputValue("q0") || "N/A";
    const answer1 = i.fields.getTextInputValue("q1") || "N/A";
    const priorityRaw = (i.fields.getTextInputValue("q2") || "").trim().toLowerCase();
    const priority = ["yes", "y", "true"].includes(priorityRaw);

    try {
      const c = await i.guild.channels.create({
        name: `${t}-${i.user.username}`.toLowerCase(),
        type: ChannelType.GuildText,
        parent: v.category,
        topic: i.user.id,
        permissionOverwrites: [
          { id: i.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: config.staffRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: config.buildTicketRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
        ]
      });
      touchActivity(c.id);

      const emb = new EmbedBuilder().setColor("#8B5CF6").setTitle(`${v.emoji} ${v.label}`)
        .addFields(
          { name: v.questions[0].label, value: ign },
          { name: v.questions[1].label, value: answer1 },
          { name: "Priority", value: priority ? `Yes (+${config.priorityFeePercent}%)` : "No", inline: true }
        )
        .setFooter({ text: "Sac's Services" });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("claim").setLabel("Claim").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("close").setLabel("Close").setStyle(ButtonStyle.Danger)
      );

      if (t === "digout") {
        const dims = parseDimensions(answer1);
        if (dims) {
          const { base, final } = calculateDigoutCost(dims, priority);
          emb.addFields(
            { name: "Base price", value: formatPrice(base), inline: false },
            { name: "Total", value: `**${formatPrice(final)}**`, inline: false },
            { name: "Payments", value: "Please note all payments go though IGN : SacService\nNever discuss in DMs" }
          );
        } else {
          emb.addFields({ name: "⚠️ Price", value: "Couldn't auto-calculate a price from those dimensions — a staff member will work it out manually." });
        }
      } else {
        emb.addFields({ name: "Payments", value: "Please note all payments go though IGN : SacService\nNever discuss in DMs" });
      }
      await c.send({ content: `${i.user} <@&${config.buildTicketRole}>`, embeds: [emb], components: [row] });

      await logTicketEvent(i.guild, {
        title: "Ticket Opened",
        ticketChannel: c,
        category: c.parent?.name || v.label,
        actionLabel: "Opened by",
        actionBy: i.user,
        color: 0x8B5CF6
      });
      return i.reply({ content: `Created: ${c}`, ephemeral: true });
    } catch (err) {
      console.error(`Failed to create "${t}" service ticket for ${i.user.tag} (${i.user.id}):`, err);
      return i.reply({
        content: "❌ Couldn't create your ticket — the category ID for this ticket type is probably missing or invalid in config.js. A server admin should check the bot's logs.",
        ephemeral: true
      });
    }
  }

  // ---- Application type select menu ----
  if (i.isStringSelectMenu() && i.customId === "apply_type") {
    const type = i.values[0];
    if (sessions.has(i.user.id)) {
      return i.reply({ content: "You already have an application in progress in your DMs.", ephemeral: true });
    }
    const info = APPLICATION_TYPES[type];
    const embed = new EmbedBuilder()
      .setColor("#8B5CF6")
      .setTitle("Are you sure you want to apply?")
      .setDescription(
        `**${info.label}**\n\n` +
        "Once you start the application I will send you a series of questions. " +
        "You will have 3 hours to complete the application. If you do not complete the application in time, you will have to restart. " +
        "If you wish to stop the application feel free to click the cancel button at any time."
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`app_start_${type}`).setLabel("Start Application").setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("app_cancel").setLabel("Cancel Application").setEmoji("🛑").setStyle(ButtonStyle.Danger)
    );
    try {
      await i.user.send({ embeds: [embed], components: [row] });
      return i.reply({ content: "📩 Check your DMs!", ephemeral: true });
    } catch {
      return i.reply({ content: "❌ I couldn't DM you. Please enable DMs from server members and try again.", ephemeral: true });
    }
  }

  // ---- Application ticket modal submit ----
  if (i.isModalSubmit() && i.customId.startsWith("m_")) {
    const t = i.customId.slice(2), v = tickets[t];

    // Block opening a second ticket of the same type while one's already
    // open — looks for an existing channel in this type's category whose
    // topic (the opener's user ID) matches them.
    const existing = i.guild.channels.cache.find(ch =>
      ch.parentId === config.categories[t] && ch.topic === i.user.id
    );
    if (existing) {
      return i.reply({ content: `You already have an open ${v.label} ticket: ${existing}`, ephemeral: true });
    }

    try {
      const c = await i.guild.channels.create({
        name: `${t}-${i.user.username}`.toLowerCase(),
        type: ChannelType.GuildText,
        parent: config.categories[t],
        topic: i.user.id,
        permissionOverwrites: [
          { id: i.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: config.staffRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
        ]
      });
      touchActivity(c.id);

      // For giveaway tickets, parse "How much did you win?" (q0) into a
      // plain number so the amount check can use it, and so the embed
      // shows it back in short form (e.g. "50k") the way people type it.
      let wonAmount = null;
      const fieldValues = v.questions.map((q, n) => {
        const raw = i.fields.getTextInputValue("q" + n) || "N/A";
        if (t === "giveaway" && n === 0) {
          wonAmount = parseAmount(raw);
          return { name: q.label, value: wonAmount !== null ? formatAmountShort(wonAmount) : raw };
        }
        return { name: q.label, value: raw };
      });

      const emb = new EmbedBuilder().setColor("#8B5CF6").setTitle(`${v.emoji} ${v.label}`)
        .addFields(fieldValues)
        .setFooter({ text: "Sac's Services" });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("claim").setLabel("Claim").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("close").setLabel("Close").setStyle(ButtonStyle.Danger)
      );

      // Giveaway claim checker — run it now (if they gave a usable amount)
      // so the Yes/No result lands right in the ticket-opening embed,
      // instead of a separate message after. If they left the amount
      // blank/unparseable, they can still trigger it later by typing the
      // amount as a plain message in the ticket (see the messageCreate
      // listener below) — that path posts its own follow-up embed instead.
      if (t === "giveaway") {
        emb.spliceFields(0, 0, { name: "Opened By", value: `${i.user}`, inline: false });

        if (wonAmount !== null) {
          markGiveawayChecked(c.id);
          const result = await findGiveawayWin(i.guild, i.user.id, wonAmount);

          if (!result.configured) {
            emb.setColor("#F1C40F").addFields({
              name: "Claim Check",
              value: "⚠️ Not checked automatically — `giveawayCheck.channels` isn't set in config.js yet. Staff should verify manually."
            });
          } else if (result.found) {
            emb.setColor("#57F287").addFields({
              name: "Claim Check",
              value: `✅ Yes, they won **${formatAmountShort(wonAmount)}** — [jump to the win](${result.message.url})`
            });
            row.addComponents(
              new ButtonBuilder().setLabel("Jump to Win").setEmoji("🔗").setStyle(ButtonStyle.Link).setURL(result.message.url)
            );
          } else {
            emb.setColor("#F04747").addFields({
              name: "Claim Check",
              value: `❌ No matching giveaway win found for **${formatAmountShort(wonAmount)}**.`
            });
          }
        } else {
          emb.addFields({
            name: "Claim Check",
            value: "⏳ No amount given yet — once they type it in the ticket, I'll check automatically."
          });
        }
      }

      await c.send({ content: `${i.user} <@&${config.staffRole}>`, embeds: [emb], components: [row] });
      await logTicketEvent(i.guild, {
        title: "Ticket Opened",
        ticketChannel: c,
        category: c.parent?.name || v.label,
        actionLabel: "Opened by",
        actionBy: i.user,
        color: 0x8B5CF6
      });

      return i.reply({ content: `Created: ${c}`, ephemeral: true });
    } catch (err) {
      console.error(`Failed to create "${t}" ticket for ${i.user.tag} (${i.user.id}):`, err);
      return i.reply({
        content: "❌ Couldn't create your ticket — the category ID or role ID in config.js for this ticket type is probably missing or invalid. A server admin should check the bot's logs.",
        ephemeral: true
      });
    }
  }

  // ---- Buy Ad ticket button (no dropdown/modal — opens the ticket right away) ----
  if (i.isButton() && i.customId === "buyad_ticket") {
    // Acknowledge immediately — channel creation can take a moment and
    // Discord only allows 3 seconds for the initial response.
    await i.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const c = await i.guild.channels.create({
        name: `ad-${i.user.username}`.toLowerCase(),
        type: ChannelType.GuildText,
        parent: config.buyAd.category,
        topic: i.user.id,
        permissionOverwrites: [
          { id: i.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          ...config.buyAd.roles.map(roleId => ({ id: roleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }))
        ]
      });
      touchActivity(c.id);

      const emb = new EmbedBuilder().setColor("#8B5CF6").setTitle("Buy Ad")
        .setDescription(`Ticket opened by ${i.user}`)
        .setFooter({ text: "Sac's Services" });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("claim").setLabel("Claim").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("close").setLabel("Close").setStyle(ButtonStyle.Danger)
      );
      await c.send({ content: `${i.user} ${config.buyAd.roles.map(r => `<@&${r}>`).join(" ")}`, embeds: [emb], components: [row] });
      await logTicketEvent(i.guild, {
        title: "Ticket Opened",
        ticketChannel: c,
        category: c.parent?.name || "Buy Ad",
        actionLabel: "Opened by",
        actionBy: i.user,
        color: 0x8B5CF6
      });
      return i.editReply({ content: `Created: ${c}` });
    } catch (err) {
      console.error(`Failed to create buy ad ticket for ${i.user.tag} (${i.user.id}):`, err);
      return i.editReply({
        content: "❌ Couldn't create your ticket — the category ID or role ID in config.js for buyAd is probably missing or invalid, or I'm missing permissions in that category. A server admin should check the bot's logs."
      }).catch(() => {});
    }
  }

  // ---- Ticket claim/close/unclaim buttons ----
  if (i.isButton() && (i.customId === "claim" || i.customId === "close" || i.customId === "unclaim")) {
    const isService = isServiceChannel(i.channel);
    const claimerId = getClaim(i.channelId);
    const openerId = i.channel.topic;
    const hasBypass = isAdmin(i.member);

    if (i.customId === "unclaim") {
      // Only the claimer or bypass role can give up a claim (not the opener).
      const allowed = hasBypass || i.user.id === claimerId;
      if (!allowed) return i.reply({ content: "Only the claimer or bypass role can unclaim this.", ephemeral: true });
    } else if (isService && claimerId) {
      // Already claimed — locked down to the claimer, the ticket owner, or bypass role only.
      const allowed = hasBypass || i.user.id === claimerId || i.user.id === openerId;
      if (!allowed) {
        return i.reply({ content: "This ticket has been claimed — only the claimer, the ticket owner, or bypass role can do that now.", ephemeral: true });
      }
    } else if (isService ? !isBuildStaff(i.member) : !isStaff(i.member)) {
      return i.reply({ content: "No permission.", ephemeral: true });
    }

    if (i.customId == "claim") {
      if (isService) {
        await i.channel.permissionOverwrites.set([
          { id: i.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: config.staffRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages] },
          { id: config.buildTicketRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages] },
          { id: i.channel.topic, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: config.bypassRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
        ]);
      } else {
        await i.channel.permissionOverwrites.set([
          { id: i.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: config.staffRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages] },
          { id: i.channel.topic, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: config.bypassRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
        ]);
      }
      setClaim(i.channelId, i.user.id);
      recordClaim(i.user.id);
      refreshCard(client, i.user.id).catch(() => {});
      recordTrackerEvent(client, i.guild.id, i.user.id, "claims").catch(() => {});
      const e = EmbedBuilder.from(i.message.embeds[0]).setFooter({ text: `Claimed by ${i.user.tag}` });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("unclaim").setLabel("Unclaim").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("close").setLabel("Close").setStyle(ButtonStyle.Danger)
      );
      await i.update({ embeds: [e], components: [row] });
      await logTicketEvent(i.guild, {
        title: "Ticket Claimed",
        ticketChannel: i.channel,
        category: i.channel.parent?.name,
        actionLabel: "Claimed by",
        actionBy: i.user,
        color: 0x8B5CF6
      });
      return i.followUp({ content: `Claimed by ${i.user}`, ephemeral: false });
    }
    if (i.customId == "unclaim") {
      const overwrites = [
        { id: i.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: config.staffRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
        { id: i.channel.topic, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
        { id: config.bypassRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
      ];
      if (isService) {
        overwrites.push({ id: config.buildTicketRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });
      }
      await i.channel.permissionOverwrites.set(overwrites);
      deleteClaim(i.channelId);
      const e = EmbedBuilder.from(i.message.embeds[0]).setFooter({ text: "Sac's Services" });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("claim").setLabel("Claim").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("close").setLabel("Close").setStyle(ButtonStyle.Danger)
      );
      await i.update({ embeds: [e], components: [row] });
      await logTicketEvent(i.guild, {
        title: "Ticket Unclaimed",
        ticketChannel: i.channel,
        category: i.channel.parent?.name,
        actionLabel: "Unclaimed by",
        actionBy: i.user,
        color: 0xFAA61A
      });
      return i.followUp({ content: `Unclaimed by ${i.user}`, ephemeral: false });
    }
    if (i.customId == "close") {
      // Ask for an optional reason before actually closing.
      const modal = new ModalBuilder().setCustomId("close_reason").setTitle("Close Ticket");
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Reason (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder("Why is this ticket being closed?")
      ));
      return i.showModal(modal);
    }
    return;
  }

  // ---- Close ticket modal submit ----
  if (i.isModalSubmit() && i.customId === "close_reason") {
    const reason = i.fields.getTextInputValue("reason")?.trim();
    await i.reply({ content: "Closing in 3 seconds..." });
    await performTicketClose(i.guild, i.channel, i.user, reason);
    return;
  }

  // ---- ,requestclose Accept/Deny buttons ----
  if (i.isButton() && (i.customId.startsWith("reqclose_accept_") || i.customId.startsWith("reqclose_deny_"))) {
    const openerId = i.channel.topic;
    if (i.user.id !== openerId) {
      return i.reply({ content: "This isn't for you — only the person who opened this ticket can respond.", ephemeral: true });
    }

    const accepted = i.customId.startsWith("reqclose_accept_");
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("reqclose_accept_done").setLabel("Accept").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId("reqclose_deny_done").setLabel("Deny").setEmoji("❌").setStyle(ButtonStyle.Secondary).setDisabled(true)
    );

    if (!accepted) {
      await i.update({ components: [disabledRow] });
      return i.followUp({ content: `${i.user} denied the request to close this ticket.` });
    }

    await i.update({ components: [disabledRow] });
    await i.followUp({ content: `${i.user} agreed — closing in 3 seconds...` });
    await performTicketClose(i.guild, i.channel, i.user, null);
    return;
  }

  // ---- Application: Start button ----
  if (i.isButton() && i.customId.startsWith("app_start_")) {
    const type = i.customId.slice("app_start_".length);
    if (!APPLICATION_TYPES[type]) return;
    if (sessions.has(i.user.id)) return i.reply({ content: "You already have an application in progress.", ephemeral: true });
    await i.update({ content: "✅ Application started! Answer each question below.", embeds: [], components: [] });
    return startApplication(i.user, type);
  }

  // ---- Application: Cancel button (works before or during an application) ----
  if (i.isButton() && i.customId === "app_cancel") {
    await i.update({ components: [] }).catch(() => {});
    return cancelApplication(i.user);
  }

  // ---- Application: dropdown answers ----
  if (i.isStringSelectMenu() && i.customId === "app_select") {
    const session = sessions.get(i.user.id);
    if (!session || session.awaiting !== "select") return i.reply({ content: "This application isn't active anymore.", ephemeral: true });
    const value = i.values[0];
    await i.update({ content: `Answer recorded: **${value}**`, embeds: [], components: [] });
    return submitAnswer(i.user, session, value);
  }

  // ---- Application: Quick Deny (no reason) ----
  if (i.isButton() && i.customId.startsWith("app_denyquick_")) {
    if (!isStaff(i.member)) return i.reply({ content: "No permission.", ephemeral: true });

    const rest = i.customId.slice("app_denyquick_".length);
    const firstUnderscore = rest.indexOf("_");
    const type = rest.slice(0, firstUnderscore);
    const applicantId = rest.slice(firstUnderscore + 1);
    const info = APPLICATION_TYPES[type];

    const embed = EmbedBuilder.from(i.message.embeds[0]).setColor("#F04747").addFields({ name: "Status", value: `❌ Denied by ${i.user.tag}` });
    await i.update({ embeds: [embed, ...i.message.embeds.slice(1)], components: [] });

    const applicant = await client.users.fetch(applicantId).catch(() => null);
    if (applicant) {
      await applicant.send({
        embeds: [new EmbedBuilder().setColor("#F04747").setTitle(`❌ ${info.label} Denied`).setDescription(`Your ${info.label.toLowerCase()} has been **denied** by ${i.user.tag}.`)]
      }).catch(() => {});
    }
    return;
  }

  // ---- Application: Accept / Deny w/ Reason (in the review channel) ----
  if (i.isButton() && (i.customId.startsWith("app_accept_") || i.customId.startsWith("app_deny_"))) {
    if (!isStaff(i.member)) return i.reply({ content: "No permission.", ephemeral: true });

    const isAccept = i.customId.startsWith("app_accept_");
    const rest = i.customId.slice(isAccept ? "app_accept_".length : "app_deny_".length);
    const firstUnderscore = rest.indexOf("_");
    const type = rest.slice(0, firstUnderscore);
    const applicantId = rest.slice(firstUnderscore + 1);
    const info = APPLICATION_TYPES[type];

    if (isAccept) {
      const embed = EmbedBuilder.from(i.message.embeds[0]).setColor("#43B581").addFields({ name: "Status", value: `✅ Accepted by ${i.user.tag}` });
      await i.update({ embeds: [embed, ...i.message.embeds.slice(1)], components: [] });

      const roleId = config.approvedRoles[type];
      if (roleId) {
        const member = await i.guild.members.fetch(applicantId).catch(() => null);
        if (member) await member.roles.add(roleId).catch(err => console.error(`Failed to add approved role to ${applicantId}:`, err));
      }

      const applicant = await client.users.fetch(applicantId).catch(() => null);
      if (applicant) {
        await applicant.send({
          embeds: [new EmbedBuilder().setColor("#43B581").setTitle(`✅ ${info.label} Accepted`).setDescription(`Congratulations! Your ${info.label.toLowerCase()} has been **accepted** by ${i.user.tag}.`)]
        }).catch(() => {});
      }
      return;
    }

    // Deny w/ Reason -> ask for a reason via modal
    const modal = new ModalBuilder().setCustomId(`app_deny_reason_${type}_${applicantId}`).setTitle("Deny Application");
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("reason").setLabel("Reason for denial").setStyle(TextInputStyle.Paragraph).setRequired(true)
    ));
    return i.showModal(modal);
  }

  // ---- Deny reason modal submit ----
  if (i.isModalSubmit() && i.customId.startsWith("app_deny_reason_")) {
    const rest = i.customId.slice("app_deny_reason_".length);
    const firstUnderscore = rest.indexOf("_");
    const type = rest.slice(0, firstUnderscore);
    const applicantId = rest.slice(firstUnderscore + 1);
    const info = APPLICATION_TYPES[type];
    const reason = i.fields.getTextInputValue("reason");

    const embed = EmbedBuilder.from(i.message.embeds[0]).setColor("#F04747").addFields(
      { name: "Status", value: `❌ Denied by ${i.user.tag}` },
      { name: "Reason", value: reason }
    );
    await i.update({ embeds: [embed, ...i.message.embeds.slice(1)], components: [] });

    const applicant = await client.users.fetch(applicantId).catch(() => null);
    if (applicant) {
      await applicant.send({
        embeds: [new EmbedBuilder().setColor("#F04747").setTitle(`❌ ${info.label} Denied`).setDescription(`Your ${info.label.toLowerCase()} has been **denied** by ${i.user.tag}.`).addFields({ name: "Reason", value: reason })]
      }).catch(() => {});
    }
    return;
  }

  // ---- IGN link button: show the modal ----
  if (i.isButton() && i.customId === "link_ign") {
    const modal = new ModalBuilder()
      .setCustomId("link_ign_modal")
      .setTitle("Link Your Minecraft IGN");

    const ignInput = new TextInputBuilder()
      .setCustomId("ign")
      .setLabel("What's Your IGN")
      .setStyle(TextInputStyle.Short)
      .setMinLength(2)
      .setMaxLength(16)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(ignInput));
    return i.showModal(modal);
  }

  // ---- IGN link modal submit ----
  if (i.isModalSubmit() && i.customId === "link_ign_modal") {
    const ign = i.fields.getTextInputValue("ign").trim();

    if (!/^[A-Za-z0-9_.]{2,16}$/.test(ign)) {
      return i.reply({ content: "That's not a valid IGN — 2 to 16 letters, numbers, underscores, or periods.", ephemeral: true });
    }

    const takenBy = findByIGN(ign, i.user.id);
    if (takenBy) {
      return i.reply({ content: "Someone else already has that IGN linked.", ephemeral: true });
    }

    const previousIgn = getIGN(i.user.id);
    const member = i.member;
    const baseName = member.displayName.replace(/\s*\[.+\]$/, "").trim();

    // Only capture the original name the first time this user ever links —
    // on later re-links (updating the IGN) we keep the name captured back
    // then, so unlinking always restores the name from before any IGN was
    // linked, not the "[OLD_IGN]" name from the update just before this one.
    setIGN(i.user.id, ign, previousIgn ? null : baseName);

    const renamed = await member.setNickname(`${baseName} [${ign}]`).then(() => true).catch(() => false);

    await logIGNEvent(i.guild, {
      action: previousIgn ? "Updated" : "Linked",
      user: i.user,
      ign,
      previousIgn,
      actionBy: i.user
    });

    if (!renamed) {
      return i.reply({
        content: `Linked your IGN as \`${ign}\`, but I couldn't update your nickname — I probably don't have a high enough role to rename you (or you're the server owner).`,
        ephemeral: true
      });
    }

    return i.reply({ content: `Linked your IGN as \`${ign}\`.`, ephemeral: true });
  }
});

// =====================================================================
// NEW MEMBER WELCOME
// =====================================================================
client.on("guildMemberAdd", member => {
  sendWelcomeMessage(member).catch(err => console.error("Failed to send welcome message:", err));
  handleMemberJoinAds(member).catch(err => console.error("Failed to send join ad(s):", err));
});

// =====================================================================
// SNIPE — remember the last deleted message per channel
// =====================================================================
client.on("messageDelete", message => {
  recordDeletedMessage(message);
});

// =====================================================================
// STICKY MESSAGES — repost the sticky to the bottom of the channel
// whenever someone else sends a message
// =====================================================================
client.on("messageCreate", message => {
  if (message.author.bot) return;
  if (!message.guild) return;
  handleMessageForSticky(message).catch(err => console.error("Sticky repost failed:", err));
});

// =====================================================================
// TICKET ACTIVITY TRACKING — records the last time any message (including
// staff/bot messages) was sent in a ticket channel. Used by the 5-day
// auto-close scheduler (checkAutoCloseTickets, defined near the top).
// =====================================================================
client.on("messageCreate", message => {
  if (!message.guild) return;
  if (!isTicketChannel(message.channel)) return;
  touchActivity(message.channel.id);
});

// =====================================================================
// ROASTS — used by ,roast @user
// =====================================================================
const ROASTS = [
  "You're the reason shampoo has instructions.",
  "You bring everyone together... to wonder what you're doing.",
  "You're not lazy, you're on energy-saving mode 24/7.",
  "If confidence was skill, you'd still be average.",
  "You're proof autocorrect can't fix everything.",
  "You have two brain cells and they're buffering.",
  "You'd lose a game of hide and seek because nobody would look.",
  "Your Wi-Fi has a stronger connection than your arguments.",
  "You're built like a loading screen.",
  "You make Mondays look exciting.",
  "You're the human version of 1% battery.",
  "If overthinking burned calories, you'd be ripped.",
  "You're about as useful as a chocolate teapot.",
  "You couldn't pour water out of a boot with instructions.",
  "You're always one step behind your own thoughts.",
  "Your luck is so bad, you'd trip over a cordless phone.",
  "You're the CEO of almost.",
  "You'd miss a free giveaway somehow.",
  "You're running on vibes and bad decisions.",
  "You're not a clown—you're the whole circus.",
  "You're the reason the mute button was invented.",
  "Your personality peaked in the tutorial.",
  "You talk a lot for someone who says nothing.",
  "You're built like an unfinished side quest.",
  "If stupidity burned calories, you'd disappear.",
  "You've got the confidence of a billionaire and the IQ of a potato.",
  "Every group chat has a weak link—you volunteered.",
  "You couldn't win an argument with autocorrect.",
  "You're proof that evolution takes breaks.",
  "You make NPCs look self-aware.",
  "You're the final boss of bad takes.",
  "Your barber deserves jail time.",
  "You're the only person who can lose a 1v0.",
  "Your ego writes checks your skills can't cash.",
  "You've got premium confidence on a free trial account.",
  "Your opinions should come with a skip button.",
  "You couldn't carry groceries, let alone a team.",
  "Your aim is so bad the walls feel safe.",
  "You're the human version of lag.",
  "Your best achievement is surviving this long.",
  "You're all keyboard, no gameplay.",
  "You make wrong decisions look consistent.",
  "You're the type to drown in shallow water.",
  "Your common sense is on permanent vacation.",
  "You got ratioed by reality.",
  "Your reflection rolls its eyes at you.",
  "You couldn't find a clue with Google Maps.",
  "You're built like expired DLC.",
  "You make disappointment look athletic.",
  "Even your excuses need better excuses.",
  "You're the reason \"low expectations\" exist.",
  "You're running on borrowed brain cells.",
  "Your chat history should be studied as a warning.",
  "You couldn't organize a two-piece puzzle.",
  "Your voice has negative FPS.",
  "You're allergic to good ideas.",
  "You're the Wi-Fi dead zone of conversations.",
  "Your luck is sponsored by failure.",
  "You make losing look professional.",
  "You're somehow loud and irrelevant.",
  "You couldn't hit water if you fell out of a boat.",
  "Your gameplay is legally considered target practice.",
  "You're the blueprint for bad timing.",
  "You couldn't spell victory if it autocorrected itself.",
  "Your decisions belong in a fail compilation.",
  "You're a plot twist nobody asked for.",
  "You make tutorials look difficult.",
  "You're the type to get lost in a straight hallway.",
  "Your strategy is just panic with confidence.",
  "You're a walking skill issue.",
  "You couldn't roast bread.",
  "Your comebacks arrive next week.",
  "You're built like an apology draft.",
  "You're the before picture in every ad.",
  "Your presence lowers team morale.",
  "You couldn't clutch with unlimited retries.",
  "You're speedrunning embarrassment.",
  "You're the reason spectators laugh.",
  "You've mastered the art of being wrong instantly.",
  "You couldn't lead ducks to a pond.",
  "Your flex is imaginary.",
  "You're the human loading icon.",
  "Your game sense is purely decorative.",
  "You couldn't outsmart a tutorial bot.",
  "You're permanently stuck in silver mindset.",
  "Your confidence has no parental supervision.",
  "You're built like a bug report.",
  "You're an expert at fumbling.",
  "You make friendly fire look intentional.",
  "You couldn't carry a backpack.",
  "Your predictions age like milk.",
  "You're the lag spike in everyone's day.",
  "Your brain files are corrupted.",
  "You couldn't finish a sentence without derailing it.",
  "Your highlight reel is buffering.",
  "You're the type to miss point-blank.",
  "Your teamwork is a horror genre.",
  "You're built like recycled excuses.",
  "You're the captain of bad decisions.",
  "Your logic needs customer support.",
  "You're somehow AFK while talking.",
  "You couldn't cook instant noodles.",
  "You're a participation trophy with Wi-Fi.",
  "Your memory resets every argument.",
  "You're the reason \"try again\" exists.",
  "Your luck owes you a refund.",
  "You're an unpaid actor in everyone else's story.",
  "You couldn't outplay a loading screen.",
  "You're the discount version of average.",
  "Your confidence is louder than your results.",
  "You couldn't catch a cold in winter.",
  "You're the typo in the group project.",
  "Your ideas arrive already outdated.",
  "You're built like an internet outage.",
  "You couldn't even gaslight Google.",
  "You're the side character who thinks he's the main event.",
  "Your talent is making simple things complicated.",
  "You're one update away from functioning.",
  "You're the reason \"skill gap\" is a phrase.",
  "You're living proof that talking and knowing aren't the same thing."
];

// userId -> timestamp (ms) they last successfully used ,roast
const roastCooldowns = new Map();
const ROAST_COOLDOWN_MS = 10_000;

// Only this user can use ,dm — everyone else is silently ignored (well,
// told "no permission") no matter what.
const DM_COMMAND_USER_ID = "1451106424145973359";
const DM_COOLDOWN_MS = 60_000;
let dmLastUsed = 0; // only one user can ever use this command, so a single shared timestamp is enough

// Only this role can use ,advertise and ,adstop — plus the server owner and
// config.fullAccessRole, who bypass every permission check in the bot (see
// utils.js hasFullAccess).
const ADVERTISE_ROLE_ID = "1538332080469966998";
function canAdvertise(member) {
  return hasFullAccess(member) || member.roles.cache.has(ADVERTISE_ROLE_ID);
}

// =====================================================================
// AFK — clears the sender's AFK on any activity, and lets people know
// when they @mention someone who's currently AFK
// =====================================================================
client.on("messageCreate", message => {
  if (message.author.bot) return;
  if (!message.guild) return;

  // Sending any message (other than setting AFK again) clears your own AFK.
  if (!message.content.toLowerCase().startsWith(",afk")) {
    if (getAfk(message.author.id)) {
      clearAfk(message.author.id);
      message.reply({ content: `👋 Welcome back ${message.author}, I removed your AFK status.` }).catch(() => {});
    }
  }

  // Let the sender know if anyone they just mentioned is AFK.
  // Sent as an embed (not plain content) so the AFK user isn't pinged a second time.
  const mentioned = message.mentions.users.filter(u => !u.bot && u.id !== message.author.id);
  if (mentioned.size) {
    const lines = [];
    for (const user of mentioned.values()) {
      const afk = getAfk(user.id);
      if (afk) lines.push(`**${user.tag}** is AFK: ${afk.reason}`);
    }
    if (lines.length) {
      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setDescription(`💤 ${lines.join("\n")}`);
      message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } }).catch(() => {});
    }
  }
});

// =====================================================================
// GIVEAWAY CLAIM FOLLOW-UP CHECK
// If someone left "How much did you win?" blank/unparseable in the
// giveaway ticket modal, they can just type the amount as a plain message
// in their ticket afterwards and the check runs then instead.
// =====================================================================
client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild) return;
  if (message.channel.parentId !== config.categories.giveaway) return;
  if (message.channel.topic !== message.author.id) return; // only the ticket opener
  if (isGiveawayChecked(message.channel.id)) return;

  const amount = parseAmount(message.content);
  if (amount === null) return;

  await runGiveawayCheck(message.channel, message.author.id, amount).catch(err => {
    console.error("Giveaway claim check failed:", err);
  });
});

// =====================================================================
// GUILD TEXT COMMANDS (,s / ,roast / ,afk)
// =====================================================================
client.on("messageCreate", async message => {
  if (message.author.bot) return;
  if (!message.guild) return; // guild-only commands
  if (!message.content.startsWith(",")) return;

  if (message.content.toLowerCase().startsWith(",afk")) {
    const reason = message.content.slice(",afk".length).trim() || "AFK";
    setAfk(message.author.id, reason);
    return message.reply({ content: `😴 You're now AFK: ${reason}` });
  }

  const [rawCmd] = message.content.slice(1).trim().split(/\s+/);
  const cmd = (rawCmd || "").toLowerCase();

  if (cmd === "s") {
    if (!isStaff(message.member)) return message.reply({ content: "No permission." });
    const snipe = getSnipe(message.channelId);
    if (!snipe) return message.reply({ content: "There's nothing to snipe in this channel." });
    return message.channel.send({ embeds: [buildSnipeEmbed(snipe)] });
  }

  if (cmd === "lock") {
    const canLock = isAdmin(message.member) || message.member.roles.cache.has(config.lockRole);
    if (!canLock) return message.reply({ content: "No permission." });
    const channel = message.channel;
    const everyoneId = message.guild.roles.everyone.id;

    const overwrites = [...channel.permissionOverwrites.cache.values()];
    const snapshot = overwrites.map(ow => ({
      id: ow.id,
      type: ow.type, // 0 = role, 1 = member — needed so .edit() doesn't have to resolve the ID itself
      prev: Object.fromEntries(LOCK_PERMS.map(p => [
        p,
        ow.allow.has(PermissionsBitField.Flags[p]) ? true
          : ow.deny.has(PermissionsBitField.Flags[p]) ? false
          : null
      ]))
    }));

    // Track failures instead of letting one bad overwrite (e.g. a role the
    // bot can't touch) throw and abort the loop with the channel half-locked
    // and nothing saved to locks.json.
    const failed = [];
    for (const ow of overwrites) {
      try {
        // Pass { type: ow.type } explicitly — otherwise discord.js tries to
        // resolve ow.id to a cached User/Role and throws InvalidType for
        // anything not currently in cache (which any role/member easily can be).
        await channel.permissionOverwrites.edit(ow.id, { SendMessages: false }, { type: ow.type });
      } catch (err) {
        console.error(`,lock: failed to edit overwrite ${ow.id} in #${channel.name}:`, err);
        failed.push(ow.id);
      }
    }
    if (!overwrites.some(ow => ow.id === everyoneId)) {
      try {
        await channel.permissionOverwrites.edit(everyoneId, { SendMessages: false }, { type: 0 });
        snapshot.push({ id: everyoneId, type: 0, prev: { SendMessages: null } });
      } catch (err) {
        console.error(`,lock: failed to edit @everyone in #${channel.name}:`, err);
        failed.push(everyoneId);
      }
    }
    // Only persist the overwrites that actually got locked, so ,unlock
    // doesn't try (and fail again) to restore ones that were never touched.
    setLockSnapshot(channel.id, snapshot.filter(s => !failed.includes(s.id)));

    if (failed.length) {
      return channel.send({
        content: `🔒 ${channel} was partially locked by ${message.author} — couldn't update ${failed.length} overwrite(s) (check the bot's Manage Roles permission and role position). See console for details.`
      });
    }
    return channel.send({ content: `🔒 ${channel} was locked by ${message.author}` });
  }

  if (cmd === "unlock") {
    const canLock = isAdmin(message.member) || message.member.roles.cache.has(config.lockRole);
    if (!canLock) return message.reply({ content: "No permission." });
    const channel = message.channel;
    const everyoneId = message.guild.roles.everyone.id;

    const snapshot = getLockSnapshot(channel.id);
    deleteLockSnapshot(channel.id);

    // Track failures instead of silently swallowing them — an edit failing
    // (bot's role below the target role/member, or missing Manage Roles)
    // used to still end in a cheerful "was unlocked" message even though
    // nothing actually changed.
    const failed = [];

    if (snapshot) {
      for (const { id, type, prev } of snapshot) {
        // type may be undefined on snapshots saved before this fix — fall
        // back to role (0), which covers the common case (@everyone/staff roles).
        try {
          await channel.permissionOverwrites.edit(id, prev, { type: type ?? 0 });
        } catch (err) {
          console.error(`,unlock: failed to restore overwrite ${id} in #${channel.name}:`, err);
          failed.push(id);
        }
      }
    } else {
      // No saved snapshot — either this channel was never locked via ,lock,
      // or the bot restarted (e.g. redeploy) and lost it. Either way, we
      // can't restore the exact prior state, but we can still make sure
      // nothing is left stuck denying SendMessages: clear it on every
      // current overwrite, not just @everyone.
      const current = [...channel.permissionOverwrites.cache.values()];
      for (const ow of current) {
        try {
          await channel.permissionOverwrites.edit(ow.id, { SendMessages: null }, { type: ow.type });
        } catch (err) {
          console.error(`,unlock (no snapshot): failed to clear overwrite ${ow.id} in #${channel.name}:`, err);
          failed.push(ow.id);
        }
      }
      if (!current.some(ow => ow.id === everyoneId)) {
        try {
          await channel.permissionOverwrites.edit(everyoneId, { SendMessages: null }, { type: 0 });
        } catch (err) {
          console.error(`,unlock (no snapshot): failed to clear @everyone in #${channel.name}:`, err);
          failed.push(everyoneId);
        }
      }
    }

    if (failed.length) {
      return channel.send({
        content: `⚠️ ${channel} could NOT be fully unlocked — ${failed.length} overwrite(s) failed to update. This usually means my role needs to be moved higher in Server Settings > Roles (above the roles/members it's trying to edit), or I'm missing **Manage Roles**. See console for exact IDs.`
      });
    }

    return channel.send({ content: `🔓 ${channel} was unlocked by ${message.author}` });
  }

  if (cmd === "purge") {
    if (!isAdmin(message.member)) {
      return message.reply({ content: "No permission." });
    }

    const arg = message.content.slice(1).trim().split(/\s+/)[1];
    const requested = parseInt(arg, 10);
    if (!arg || isNaN(requested) || requested < 1) {
      return message.reply({ content: "Usage: `,purge <amount>` — amount must be between 1 and 100." });
    }
    const amount = Math.min(requested, 100);

    let deleted;
    try {
      // +1 to also remove the ",purge" command message itself.
      // The `true` filters out anything older than 14 days instead of
      // throwing — Discord's bulk-delete API can't touch those at all.
      deleted = await message.channel.bulkDelete(amount + 1, true);
    } catch (err) {
      console.error(",purge failed:", err);
      return message.reply({ content: "Couldn't delete those messages — check my Manage Messages permission." });
    }

    const count = Math.max(deleted.size - 1, 0); // don't count the command message itself
    const notice = await message.channel.send({
      content: `🧹 Deleted ${count} message(s)${requested > 100 ? " (capped at 100 max)" : ""} — ${message.author}`
    });
    setTimeout(() => notice.delete().catch(() => {}), 4000);
    return;
  }

  if (cmd === "roast") {
    const target = message.mentions.users.first();
    if (!target) return message.reply({ content: "Mention someone to roast! Usage: `,roast @user`" });

    const now = Date.now();
    const lastUsed = roastCooldowns.get(message.author.id);
    if (lastUsed && now - lastUsed < ROAST_COOLDOWN_MS) {
      const remaining = Math.ceil((ROAST_COOLDOWN_MS - (now - lastUsed)) / 1000);
      return message.reply({ content: `Woah, slow down — wait another ${remaining}s.` });
    }
    roastCooldowns.set(message.author.id, now);

    const roast = ROASTS[Math.floor(Math.random() * ROASTS.length)];
    return message.channel.send({ content: `${target} ${roast}` });
  }

  // ,dm @user <message> — locked to one specific user ID, full stop.
  if (cmd === "dm") {
    if (message.author.id !== DM_COMMAND_USER_ID) {
      return message.reply({ content: "No permission." });
    }

    const now = Date.now();
    const elapsed = now - dmLastUsed;
    if (elapsed < DM_COOLDOWN_MS) {
      const remaining = Math.ceil((DM_COOLDOWN_MS - elapsed) / 1000);
      return message.reply({ content: `⏳ Slow down — try again in ${remaining}s.` });
    }

    // Accept either an @mention or a raw user ID as the first argument.
    const args = message.content.slice(1).trim().split(/\s+/); // ["dm", "<target>", ...rest]
    const rawTarget = args[1];
    const mentioned = message.mentions.users.first();
    const idMatch = rawTarget && rawTarget.match(/^(?:<@!?(\d+)>|(\d{15,25}))$/);
    const targetId = mentioned?.id || (idMatch ? (idMatch[1] || idMatch[2]) : null);

    if (!targetId) {
      return message.reply({ content: "Usage: `,dm @user <message>` or `,dm <user id> <message>`" });
    }

    let target;
    try {
      target = await client.users.fetch(targetId);
    } catch {
      return message.reply({ content: `❌ Couldn't find a user with ID \`${targetId}\`.` });
    }

    // Strip the leading ",dm" and the target (mention OR raw ID, whichever
    // was used) out of the raw content — whatever's left is the message.
    const body = message.content
      .slice(message.content.indexOf("dm") + 2)
      .replace(/<@!?\d+>|\d{15,25}/, "")
      .trim();

    if (!body) {
      return message.reply({ content: "You need to actually include a message. Usage: `,dm @user <message>` or `,dm <user id> <message>`" });
    }

    try {
      await target.send({ content: body });
    } catch (err) {
      console.error(`,dm: failed to DM ${target.id}:`, err);
      return message.reply({ content: `❌ Couldn't DM ${target} — they may have DMs closed or have blocked the bot.` });
    }

    dmLastUsed = Date.now();
    return message.reply({ content: "Dm sent" });
  }

  // ,advertise <count> <ad text> — starts a campaign: the next <count>
  // people who JOIN this server get DM'd <ad text> the instant they join.
  // Multiple campaigns can run at once.
  if (cmd === "advertise") {
    if (!canAdvertise(message.member)) {
      return message.reply({ content: "No permission." });
    }

    const match = message.content.match(/^,advertise\s+(\d+)\s+([\s\S]+)$/i);
    if (!match) {
      return message.reply({ content: "Usage: `,advertise <count> <ad text>` — e.g. `,advertise 20 Check out our giveaway!`" });
    }
    const target = parseInt(match[1], 10);
    const text = match[2].trim();

    if (target <= 0) {
      return message.reply({ content: "Usage: `,advertise <count> <ad text>` — e.g. `,advertise 20 Check out our giveaway!`" });
    }
    if (!text) {
      return message.reply({ content: "You need to include the ad text. Usage: `,advertise <count> <ad text>`" });
    }

    createCampaign(message.guild.id, message.author.id, target, text);
    return message.reply({ content: `✅ Started an ad campaign — the next **${target}** members to join will be DM'd that message.` });
  }

  // ,adstop <count> — stops the active campaign that was started with that
  // target count, and reports how many it actually managed to send.
  if (cmd === "adstop") {
    if (!canAdvertise(message.member)) {
      return message.reply({ content: "No permission." });
    }

    const args = message.content.slice(1).trim().split(/\s+/);
    const target = parseInt(args[1], 10);
    if (!Number.isInteger(target) || target <= 0) {
      return message.reply({ content: "Usage: `,adstop <count>` — the same count you started the campaign with, e.g. `,adstop 20`" });
    }

    const campaign = stopCampaignByTarget(message.guild.id, target);
    if (!campaign) {
      return message.reply({ content: `❌ No active campaign found with a target of ${target}.` });
    }

    return message.reply({ content: `🛑 Stopped that campaign — it had DM'd **${campaign.sent}/${campaign.target}** members before being stopped.` });
  }

  // ,requestclose — only REQUEST_CLOSE_ROLE_ID, only inside a ticket
  // channel. Asks the ticket opener to agree via Accept/Deny buttons
  // instead of closing it outright.
  if (cmd === "requestclose") {
    const hasRequestCloseRole =
      isStaff(message.member) ||
      message.member.roles.cache.has(REQUEST_CLOSE_ROLE_ID) ||
      message.member.roles.cache.has(REQUEST_CLOSE_ROLE_ID_2);
    if (!hasRequestCloseRole) {
      return message.reply({ content: "No permission." });
    }
    if (!isTicketChannel(message.channel)) {
      return message.reply({ content: "This isn't a ticket channel." });
    }

    const openerId = message.channel.topic;
    const embed = new EmbedBuilder()
      .setColor("#F1C40F")
      .setDescription(`<@${openerId}> ${message.author} has requested to close this ticket. Do you agree?`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("reqclose_accept_").setLabel("Accept").setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("reqclose_deny_").setLabel("Deny").setEmoji("❌").setStyle(ButtonStyle.Secondary)
    );

    return message.channel.send({ content: `<@${openerId}>`, embeds: [embed], components: [row] });
  }
});

// =====================================================================
// DM MESSAGES (text / image answers for active applications)
// =====================================================================
client.on("messageCreate", async message => {
  if (message.author.bot) return;
  if (message.guild) return; // DMs only

  const session = sessions.get(message.author.id);
  if (!session) return;

  const q = session.questions[session.index];

  if (session.awaiting === "text") {
    if (!message.content.trim()) return message.reply("Please send a text answer.");
    return submitAnswer(message.author, session, message.content.trim());
  }

  if (session.awaiting === "images") {
    const images = [...message.attachments.values()].filter(a => (a.contentType || "").startsWith("image/")).map(a => a.url);
    if (images.length < q.min || images.length > q.max) {
      return message.reply(`Please upload between ${q.min} and ${q.max} images in a single message.`);
    }
    return submitAnswer(message.author, session, images);
  }

  if (session.awaiting === "images_or_text") {
    const images = [...message.attachments.values()].filter(a => (a.contentType || "").startsWith("image/")).map(a => a.url);
    if (images.length) {
      if (images.length > q.max) return message.reply(`Please upload up to ${q.max} images.`);
      return submitAnswer(message.author, session, images);
    }
    if (!message.content.trim()) return message.reply("Please send a text answer, or upload images.");
    return submitAnswer(message.author, session, message.content.trim());
  }
  // if session.awaiting === "select", ignore plain messages — they must use the dropdown
});

client.login(config.token);
