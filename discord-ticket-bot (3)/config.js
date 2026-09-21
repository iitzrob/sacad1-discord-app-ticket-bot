module.exports = {
  // ==== From Railway variables ====
  token: process.env.BOT_TOKEN,
  clientId: process.env.CLIENT_ID, // used by deploy-commands.js to register slash commands
  guildId: process.env.GUILD_ID,

  // ==== Everything else — just paste your real IDs here ====
  panelChannel: "PANEL_CHANNEL_ID",
  bypassRole: "1546728771208482876", // can always type in a ticket even after it's been claimed by someone else (bypasses the claim lock)
  staffRole: "1482008632747884736", // gets pinged + can see every new ticket as soon as it's created
  // The server owner always has full access everywhere in the bot, no
  // matter what. Anyone with this role gets that exact same full access —
  // every command, every ticket action (claim/close/rename/add/etc.),
  // bypassing claim locks, ,lock/,unlock, ,purge — identical to the owner.
  // See utils.js (isStaff/isBuildStaff/isAdmin) for where this is checked.
  fullAccessRole: "1455703614432481485",
  ticketLogChannel: "1477059741657206934", // where ticket opened/claimed/closed events get logged. Leave as-is (or "") to disable logging.
  ignLogChannel: "1480429965873778738", // where IGN link/update/remove events get logged.

  // Giveaway claim checker — when someone opens a "Giveaway Claim/Sponsor"
  // ticket, these channels get scanned for a message mentioning them with
  // an amount matching what they typed for "How much did you win?" — the
  // result (found/not found, with a jump-to-win button) gets posted in the
  // ticket automatically.
  giveawayCheck: {
    channels: ["1456051574056026112", "1505822932327202816", "1477093104849912008"], // the channels your giveaway/tracker bot posts wins in
    botId: "", // optional — only check messages from this bot's user ID; leave "" to check every message in those channels
    searchLimit: 500 // how many recent messages to scan per channel (clamped 50-5000)
  },
  // Tickets with no new messages for this long get closed automatically
  // (transcript DM'd to the opener + logged, same as a normal close, just
  // labelled "Auto Closed" / "Inactive for N days"). Digout/base building
  // (serviceCategories) tickets use serviceInactivityMs instead of the
  // regular inactivityMs — see index.js's checkAutoCloseTickets().
  autoClose: {
    enabled: true,
    inactivityMs: 5 * 24 * 60 * 60 * 1000, // 5 days — buying/selling/partnership/giveaway/gamble/help/buy-ad tickets
    serviceInactivityMs: 10 * 24 * 60 * 60 * 1000, // 10 days — digout/base building (serviceCategories) tickets
    checkIntervalMs: 15 * 60 * 1000 // how often to scan for stale tickets
  },
  categories: {
    buying: "1514955042958868551",
    selling: "1479693976087957596",
    partnership: "1514960184982634517",
    giveaway: "1477059744643547228",
    gamble: "1514961845021048944",
    help: "1479694579912671293"
  },

  // Buy Ad panel — single "Buy now" button, no modal questions.
  buyAd: {
    category: "1547232247407714457", // ticket channel gets created under this category
    // NOTE: this used to be two separate "role:" keys — in JS object literals a
    // duplicate key silently overwrites the first, so only 1455703614432481485
    // was ever actually used. Both are now kept as an array.
    roles: ["1523683749223600350", "1455703614432481485"] // pinged + given access on every buy ad ticket
  },

  // Service tickets (build orders — digout / base building)
  serviceCategories: {
    digout: "1537362856444567592",
    basebuilding: "1536144986641530880"
  },
  buildTicketRole: "1536195433393557545", // pinged + given access on every digout/base building ticket
  digoutPricePerUnit: 1000, // price = L x W x H x this
  priorityFeePercent: 20,   // rush priority fee, added on top of the base price

  // Roles exempt from ,s (snipe) — if someone with one of these roles
  // deletes a message, ,s will not be able to show it.
  snipeBypassRoles: ["1455703614432481485"],

  // Only members with this role can use ,lock / ,unlock
  lockRole: "1538332080469966998",

  // Staff/Builder applications
  applicationPanelChannel: "APPLICATION_PANEL_CHANNEL_ID", // where the panel with the dropdown is posted
  applicationReviewChannels: {
    staff: "1477265874560749588",   // finished staff applications get posted here for Accept/Deny
    builder: "1536248721384144947"  // finished builder applications get posted here for Accept/Deny
  },
  applicationTimeLimitMs: 3 * 60 * 60 * 1000, // 3 hours
  applicationsEnabled: {
    staff: true,
    builder: true
  },
  // Role given automatically when an application is accepted
  approvedRoles: {
    staff: "1535572623797387274",
    builder: "1536195433393557545"
  },
  // Role pinged in the review channel when a new application comes in
  applicationPingRoles: {
    staff: "1523683749223600350",
    builder: "1536146868160041070"
  },

  // Welcome messages (sent when a new member joins)
  welcome: {
    channel: "1466269532615086101", // channel where the welcome message gets posted
    description:
      "Make sure to read <#1466270062322384926> \n" +
      "Enter all the giveaways below:\n" +
      "<#1456051574056026112> \n" +
      "<#1505822932327202816> \n" +
      "And watch out for <#1477093104849912008> \n" +
      "Make a <#1536144548269658183> Build ticket to order a build or digout\n" +
      "Make sure to show all channels aswell!\n\n" +
      "Enjoy your stay!"
  }
};
