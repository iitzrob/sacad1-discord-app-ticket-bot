const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");

// =====================================================================
// /coinflip — call heads or tails, then watch it flip
//
// Flow:
//   1. Caller gets Heads/Tails buttons.
//   2. On pick, the message flickers between heads/tails a few times
//      (suspense) before landing on the real result.
//   3. Result is shown as fields (Call / Landed on) rather than a
//      single description line.
// =====================================================================

const PICK_TIMEOUT_MS = 30_000;
const FLICKER_STEPS = 4;
const FLICKER_DELAY_MS = 450;

const COIN_MENTION = "<a:871153yellowheartcoin:1553056582936559666>";
const HEADS_MENTION = "<:60581heads:1553056182942433310>";
const TAILS_MENTION = "<:41056tails:1553056150646423582>";

const HEADS_EMOJI = { id: "1553056182942433310", name: "60581heads" };
const TAILS_EMOJI = { id: "1553056150646423582", name: "41056tails" };

const COLOR_IDLE = 0x8b5cf6; // sacad house purple
const COLOR_FLIP = 0xfee75c; // gold, mid-flip
const COLOR_WIN = 0x2ecc71;
const COLOR_LOSE = 0xed4245;
const COLOR_EXPIRED = 0x5a5a5a;

function callRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("cf_heads")
      .setLabel("Heads")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(HEADS_EMOJI)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("cf_tails")
      .setLabel("Tails")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(TAILS_EMOJI)
      .setDisabled(disabled),
  );
}

function callEmbed(user) {
  return new EmbedBuilder()
    .setColor(COLOR_IDLE)
    .setTitle(`${COIN_MENTION} Coin Toss`)
    .setDescription(`${user}, call it in the air.`)
    .setFooter({ text: "30 seconds to call" });
}

function flickerEmbed(guess) {
  const showing = guess === "heads" ? HEADS_MENTION : TAILS_MENTION;
  return new EmbedBuilder()
    .setColor(COLOR_FLIP)
    .setTitle(`${COIN_MENTION} Coin Toss`)
    .setDescription(`${showing} spinning...`);
}

function resultEmbed(user, choice, outcome) {
  const won = choice === outcome;
  const outcomeMention = outcome === "heads" ? HEADS_MENTION : TAILS_MENTION;
  const callMention = choice === "heads" ? HEADS_MENTION : TAILS_MENTION;

  return new EmbedBuilder()
    .setColor(won ? COLOR_WIN : COLOR_LOSE)
    .setTitle(`${COIN_MENTION} Coin Toss — ${won ? "You called it" : "Not this time"}`)
    .addFields(
      { name: "Call", value: callMention, inline: true },
      { name: "Landed on", value: outcomeMention, inline: true },
    )
    .setFooter({ text: `${user.username} ${won ? "won" : "lost"} the toss` });
}

function expiredEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR_EXPIRED)
    .setTitle(`${COIN_MENTION} Coin Toss`)
    .setDescription("No call made in time.");
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("Call heads or tails and flip a coin"),

  async execute(interaction) {
    const user = interaction.user;

    await interaction.reply({
      embeds: [callEmbed(user)],
      components: [callRow()],
    });

    const message = await interaction.fetchReply();

    let picked;
    try {
      picked = await message.awaitMessageComponent({
        filter: (i) =>
          i.user.id === user.id &&
          ["cf_heads", "cf_tails"].includes(i.customId),
        time: PICK_TIMEOUT_MS,
      });
    } catch {
      return interaction
        .editReply({ embeds: [expiredEmbed()], components: [callRow(true)] })
        .catch(() => {});
    }

    const choice = picked.customId === "cf_heads" ? "heads" : "tails";
    const outcome = Math.random() < 0.5 ? "heads" : "tails";

    await picked.update({ embeds: [flickerEmbed(choice)], components: [] });

    // Build a short flicker sequence that always ends on the real outcome.
    const sequence = [];
    for (let i = 0; i < FLICKER_STEPS - 1; i++) {
      sequence.push(Math.random() < 0.5 ? "heads" : "tails");
    }
    sequence.push(outcome);

    for (const frame of sequence) {
      await new Promise((resolve) => setTimeout(resolve, FLICKER_DELAY_MS));
      await interaction
        .editReply({ embeds: [flickerEmbed(frame)] })
        .catch(() => {});
    }

    await interaction
      .editReply({ embeds: [resultEmbed(user, choice, outcome)] })
      .catch((err) => console.error("[coinflip] result edit failed:", err));
  },
};
