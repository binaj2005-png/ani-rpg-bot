// ═══════════════════════════════════════════════════════════════
// PROFILE — Solo Leveling Hunter Profile
// Shows rank, power rating, aura, class, stats, gear, gate history
// ═══════════════════════════════════════════════════════════════

const { calculatePowerRating, getPowerLabel, AWAKENING_RANKS, getXpRequired } = require('../../rpg/utils/SoloLevelingCore');
const { AuraSystem } = require('../../rpg/utils/AuraSystem');
const LevelUpManager = require('../../rpg/utils/LevelUpManager');

function buildBar(current, max, length = 10) {
  const filled = Math.round(Math.min(current, max) / max * length);
  return `[${'█'.repeat(filled)}${'░'.repeat(length - filled)}]`;
}

module.exports = {
  name: 'profile',
  aliases: ['p', 'stats', 'me', 'hunter'],
  description: '📋 View your hunter profile',

  async execute(sock, msg, args, getDatabase, saveDatabase, sender) {
    const chatId = msg.key?.remoteJid;
    const db = getDatabase();

    // Allow viewing another player's profile
    const mentionedId = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    const targetId = mentionedId || sender;
    const player = db.users[targetId];

    if (!player) {
      return sock.sendMessage(chatId, {
        text: mentionedId ? '❌ That player is not registered.' : '❌ You are not registered! Use /register'
      }, { quoted: msg });
    }

    const rank = player.awakenRank || 'E';
    const rankData = AWAKENING_RANKS[rank];
    const stats = player.stats || {};
    const power = calculatePowerRating(stats, Object.values(player.equipped || {}).filter(Boolean), player.pet);
    const powerLabel = getPowerLabel(power);

    const xpProgress = LevelUpManager.getXPProgress(player);
    const xpBar = buildBar(xpProgress.current, xpProgress.needed, 10);

    const hpBar = buildBar(stats.hp || 0, stats.maxHp || 100, 10);
    const energyBar = buildBar(stats.energy || 0, stats.maxEnergy || 100, 10);

    const aura = player.aura || 0;
    const auraTitle = AuraSystem.getAuraTitle(aura);

    const cls = player.class || null;
    const evolvedClass = player.evolvedClass || null;
    const classDisplay = evolvedClass ? `${evolvedClass} *(evolved)*` : cls ? cls : `*Not assigned yet*`;

    const gatesCleared = player.stats_history?.gatesCleared || 0;
    const pvpWins = player.stats_history?.pvpWins || 0;
    const pvpLosses = player.stats_history?.pvpLosses || 0;
    const deaths = player.deathCount || 0;

    // Equipped gear summary
    const equipped = player.equipped || {};
    const gearLines = [];
    const gearMap = {
      weapon: '⚔️', armor: '🛡️', helmet: '⛑️', gloves: '🧤',
      boots: '👟', accessory: '💍', artifact: '🔮', artifact2: '🔮'
    };
    for (const [slot, emoji] of Object.entries(gearMap)) {
      const item = equipped[slot];
      if (item) gearLines.push(`  ${emoji} ${item.name}`);
    }

    const lines = [
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `👤 *${player.name}*`,
      player.equippedTitle ? `🎖️ "${player.equippedTitle}"` : ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `${rankData.emoji} *Awakening Rank:* ${rankData.label}`,
      `⭐ *Level:* ${player.level}`,
      `⚡ *Power Rating:* ${power.toLocaleString()} ${powerLabel.emoji} ${powerLabel.label}`,
      `🎭 *Class:* ${classDisplay}`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `📊 *STATS*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `❤️  HP:     ${stats.hp || 0}/${stats.maxHp || 0}`,
      `    ${hpBar}`,
      `💙  Energy: ${stats.energy || 0}/${stats.maxEnergy || 0}`,
      `    ${energyBar}`,
      `⚔️  ATK:    ${stats.atk || 0}`,
      `🛡️  DEF:    ${stats.def || 0}`,
      `💨  SPD:    ${stats.speed || 0}`,
      `✨  Magic:  ${stats.magicPower || 0}`,
      `💥  Crit:   ${stats.critChance || 0}% (×${((stats.critDamage || 150) / 100).toFixed(1)})`,
      stats.lifesteal > 0 ? `💚  Steal:  ${stats.lifesteal}%` : ``,
      ``,
      `📈 *XP:* ${xpProgress.current.toLocaleString()} / ${xpProgress.needed.toLocaleString()} (${xpProgress.percent}%)`,
      `    ${xpBar}`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `✨ *AURA*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `${auraTitle.emoji} ${auraTitle.title} — *${aura.toLocaleString()}* Aura`,
      `⚔️ PvP: ${pvpWins}W / ${pvpLosses}L | Streak: ${player.pvpStreak || 0}`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `📋 *RECORD*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🚪 Gates Cleared: ${gatesCleared}`,
      `💀 Deaths: ${deaths}`,
      `💎 Mana Stones: ${(player.manaCrystals || 0).toLocaleString()}`,
      `📈 Upgrade Points: ${player.upgradePoints || 0}`,
      ``,
      gearLines.length > 0 ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━` : ``,
      gearLines.length > 0 ? `🗡️ *EQUIPPED GEAR*` : ``,
      gearLines.length > 0 ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━` : ``,
      ...gearLines,
      ``,
      player.guild ? `🏰 Guild: *${player.guild}*` : `🏰 Guild: *None*`,
      player.pet ? `🐾 Pet: *${player.pet.name || 'Unnamed'}* [Lv.${player.pet.level || 1}]` : `🐾 Pet: *None*`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ].filter(l => l !== null && l !== '').join('\n');

    return sock.sendMessage(chatId, { text: lines }, { quoted: msg });
  }
};