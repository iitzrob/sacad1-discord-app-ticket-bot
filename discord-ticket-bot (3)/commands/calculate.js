const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

// =====================================================================
// Tiny, dependency-free math expression evaluator.
// Supports + - * / ^ ( ) and decimals, e.g. "5 + 3 * (2 - 1)", "2^10".
// Deliberately does NOT use eval()/Function() — only digits and the
// operators above are accepted, so there's no way to run arbitrary code.
// =====================================================================
function tokenize(expr) {
  const tokens = [];
  const regex = /\s*([0-9]*\.?[0-9]+|\+|-|\*|\/|\^|\(|\))\s*/y;
  let pos = 0;
  while (pos < expr.length) {
    regex.lastIndex = pos;
    const match = regex.exec(expr);
    if (!match || match[0].length === 0) {
      throw new Error(`Unexpected character near "${expr.slice(pos, pos + 1)}"`);
    }
    tokens.push(match[1]);
    pos += match[0].length;
  }
  return tokens;
}

function evaluate(expr) {
  const tokens = tokenize(expr);
  if (!tokens.length) throw new Error("Empty expression");
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpression() {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const rhs = parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  function parseTerm() {
    let value = parseUnary();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const rhs = parseUnary();
      if (op === "/" && rhs === 0) throw new Error("Division by zero");
      value = op === "*" ? value * rhs : value / rhs;
    }
    return value;
  }

  function parseUnary() {
    if (peek() === "-") { next(); return -parseUnary(); }
    if (peek() === "+") { next(); return parseUnary(); }
    return parsePower();
  }

  function parsePower() {
    const base = parseAtom();
    if (peek() === "^") {
      next();
      return Math.pow(base, parseUnary()); // right-associative
    }
    return base;
  }

  function parseAtom() {
    if (peek() === "(") {
      next();
      const value = parseExpression();
      if (next() !== ")") throw new Error("Mismatched parentheses");
      return value;
    }
    const token = next();
    const num = parseFloat(token);
    if (token === undefined || isNaN(num)) throw new Error(`Unexpected token: "${token ?? "end of input"}"`);
    return num;
  }

  const result = parseExpression();
  if (pos !== tokens.length) throw new Error(`Unexpected trailing input near "${tokens[pos]}"`);
  return result;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("calculate")
    .setDescription("Quick calculator")
    .addStringOption(o => o.setName("expression").setDescription("e.g. 5 + 3 * 2, (10-4)/2, 2^3").setRequired(true)),

  async execute(interaction) {
    const expr = interaction.options.getString("expression");

    let result;
    try {
      result = evaluate(expr);
    } catch (err) {
      return interaction.reply({ content: `❌ Couldn't calculate that — ${err.message}.`, ephemeral: true });
    }
    if (!isFinite(result)) {
      return interaction.reply({ content: "❌ That expression didn't produce a valid number.", ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setColor("#8B5CF6")
      .setTitle("🧮 Calculator")
      .addFields(
        { name: "Expression", value: `\`${expr}\`` },
        { name: "Result", value: `**${result}**` }
      );

    return interaction.reply({ embeds: [embed] });
  }
};
