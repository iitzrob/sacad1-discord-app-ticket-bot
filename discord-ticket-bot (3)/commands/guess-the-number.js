const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

// =====================================================================
// /guessthenumber — open lobby number guessing
//
// Anyone in the channel can guess (not just whoever ran the command).
// One game per channel at a time. The embed keeps a live "range" field
// that narrows in as wrong guesses come in, so latecomers can see how
// close the field already is.
// =====================================================================

const MIN_NUMBER = 1;
const MAX_NUMBER = 100;
const GAME_TIMEOUT_MS = 60_000;
const CHANNEL_COOLDOWN_MS = 10_000;

const UP_EMOJI = "🔼";
const DOWN_EMOJI = "🔽";
const CORRECT_EMOJI = "✅";

const COLOR_IDLE = 0x8b5cf6; // sacad house purple
const COLOR_WIN = 0x2ecc71;
const COLOR_EXPIRED = 0x5a5a5a;

// channelId -> true while a game is running there
const activeGames = new Map();
// channelId -> timestamp a new game can start
const channelCooldowns = new Map();

function gameEmbed({ low, high, guessCount, guesserCount }) {
  return new EmbedBuilder()
    .setColor(COLOR_IDLE)
    .setTitle("🎯 Guess the Number")
    .setDescription("I'm thinking of a number. Anyone in this channel can guess — just type it.")
    .addFields(
      { name: "Range", value: `**${low} – ${high}**`, inline: true },
      { name: "Guesses so far", value: `${guessCount} (from ${guesserCount})`, inline: true },
    )
    .setFooter({ text: `Game ends in ${GAME_TIMEOUT_MS / 1000}s if nobody gets it` });
}

function wonEmbed({ winnerMention, answer, guessCount, guesserCount }) {
  return new EmbedBuilder()
    .setColor(COLOR_WIN)
    .setTitle("🎯 Guess the Number — Solved!")
    .setDescription(`${winnerMention} nailed it.`)
    .addFields(
      { name: "Number", value: `${answer}`, inline: true },
      { name: "Total guesses", value: `${guessCount} (from ${guesserCount})`, inline: true },
    );
}

function expiredEmbed({ answer, guessCount, guesserCount }) {
  return new EmbedBuilder()
    .setColor(COLOR_EXPIRED)
    .setTitle("🎯 Guess the Number — Time's up")
    .setDescription(`Nobody found it. The number was **${answer}**.`)
    .addFields(
      { name: "Total guesses", value: `${guessCount} (from ${guesserCount})`, inline: true },
    );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("guessthenumber")
    .setDescription(`Start an open guessing game (${MIN_NUMBER}-${MAX_NUMBER}) anyone in the channel can join`),

  async execute(interaction) {
    const channel = interaction.channel;

    if (activeGames.get(channel.id)) {
      return interaction.reply({
        content: "There's already a game running in this channel — join in by typing a number.",
        ephemeral: true,
      });
    }

    const now = Date.now();
    const readyAt = channelCooldowns.get(channel.id) || 0;
    if (now < readyAt) {
      const secondsLeft = Math.ceil((readyAt - now) / 1000);
      return interaction.reply({
        content: `A game just ended here — try again in ${secondsLeft}s.`,
        ephemeral: true,
      });
    }

    activeGames.set(channel.id, true);

    const answer = Math.floor(Math.random() * (MAX_NUMBER - MIN_NUMBER + 1)) + MIN_NUMBER;

    let low = MIN_NUMBER;
    let high = MAX_NUMBER;
    let guessCount = 0;
    const guessers = new Set();
    let won = false;

    const gameMessage = await interaction.reply({
      embeds: [gameEmbed({ low, high, guessCount, guesserCount: guessers.size })],
      fetchReply: true,
    });

    const collector = channel.createMessageCollector({
      // Anyone (not just the person who ran the command) can guess.
      filter: (m) => !m.author.bot && /^\d+$/.test(m.content.trim()),
      time: GAME_TIMEOUT_MS,
    });

    collector.on("collect", async (m) => {
      const guess = parseInt(m.content.trim(), 10);
      if (guess < MIN_NUMBER || guess > MAX_NUMBER) return;

      guessCount += 1;
      guessers.add(m.author.id);

      if (guess === answer) {
        won = true;
        collector.stop("won");
        await m.react(CORRECT_EMOJI).catch(() => {});
        await gameMessage
          .edit({
            embeds: [
              wonEmbed({
                winnerMention: m.author.toString(),
                answer,
                guessCount,
                guesserCount: guessers.size,
              }),
            ],
          })
          .catch((err) => console.error("[guessthenumber] win edit failed:", err));
        return;
      }

      if (guess < answer) {
        low = Math.max(low, guess + 1);
        await m.react(UP_EMOJI).catch(() => {});
      } else {
        high = Math.min(high, guess - 1);
        await m.react(DOWN_EMOJI).catch(() => {});
      }

      await gameMessage
        .edit({ embeds: [gameEmbed({ low, high, guessCount, guesserCount: guessers.size })] })
        .catch(() => {});
    });

    collector.on("end", async () => {
      activeGames.delete(channel.id);
      channelCooldowns.set(channel.id, Date.now() + CHANNEL_COOLDOWN_MS);

      if (!won) {
        await gameMessage
          .edit({ embeds: [expiredEmbed({ answer, guessCount, guesserCount: guessers.size })] })
          .catch((err) => console.error("[guessthenumber] expired edit failed:", err));
      }
    });
  },
};
