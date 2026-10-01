const fs = require("fs");
const path = require("path");

// =====================================================================
// JOIN-TRIGGERED AD CAMPAIGNS
// ,advertise <count> <ad text>  -> starts a campaign: the next <count>
//                                   people who JOIN the server get DM'd
//                                   <ad text> the moment they join.
// ,adstop <count>               -> stops the active campaign that was
//                                   started with that target count, and
//                                   reports how many it actually got to
//                                   send before being stopped.
//
// Multiple campaigns can run at once (e.g. one for 20 joins, another for
// 50) — every active campaign in the guild fires independently for each
// new member, each counting down its own target.
//
// Data shape (data/adverts.json):
// { campaigns: [ { id, guildId, text, target, sent, createdBy, createdAt, active,
//                   recipients: [ { id, at } ] } ] }
// (recipients is what /adsee reads — ads sent before it was added just don't have it)
// =====================================================================
const DATA_FILE = path.join(__dirname, "data", "adverts.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return { campaigns: [] };
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to save adverts.json:", err);
  }
}

const data = load();

function genId() {
  return `ad_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function createCampaign(guildId, createdBy, target, text) {
  const campaign = {
    id: genId(),
    guildId,
    text,
    target,
    sent: 0,
    recipients: [],
    createdBy,
    createdAt: new Date().toISOString(),
    active: true
  };
  data.campaigns.push(campaign);
  save();
  return campaign;
}

// Stops the most recently created ACTIVE campaign in this guild whose
// target matches the number given to ,adstop. Returns the campaign
// (with however many it had sent) or null if none matched.
function stopCampaignByTarget(guildId, target) {
  const matches = data.campaigns.filter(c => c.guildId === guildId && c.active && c.target === target);
  if (!matches.length) return null;
  const campaign = matches[matches.length - 1];
  campaign.active = false;
  save();
  return campaign;
}

// Most recently created campaign in this guild with that target count
// (running or finished) — what /adsee looks up.
function findCampaignByTarget(guildId, target) {
  const matches = data.campaigns.filter(c => c.guildId === guildId && c.target === target);
  return matches.length ? matches[matches.length - 1] : null;
}

function getCampaignById(id) {
  return data.campaigns.find(c => c.id === id) || null;
}

function getActiveCampaigns(guildId) {
  return data.campaigns.filter(c => c.guildId === guildId && c.active);
}

// Called from the guildMemberAdd handler. DMs the new member on behalf of
// every currently active campaign in their guild, then counts it toward
// each campaign's target — deactivating any campaign that just hit it.
async function handleMemberJoinAds(member) {
  const campaigns = getActiveCampaigns(member.guild.id);
  if (!campaigns.length) return;

  for (const campaign of campaigns) {
    try {
      await member.send({ content: campaign.text });
      campaign.sent++;
      if (!Array.isArray(campaign.recipients)) campaign.recipients = [];
      campaign.recipients.push({ id: member.id, at: Date.now() });
      if (campaign.sent >= campaign.target) campaign.active = false;
    } catch {
      // DMs closed / bot blocked — doesn't count toward the target, just
      // move on to the next active campaign (and the next new member).
    }
  }
  save();
}

module.exports = {
  createCampaign,
  stopCampaignByTarget,
  findCampaignByTarget,
  getCampaignById,
  getActiveCampaigns,
  handleMemberJoinAds
};
