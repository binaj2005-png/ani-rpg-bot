// ═══════════════════════════════════════════════════════════════
// REGISTER — Solo Leveling Style Awakening
// - Random awakening rank (E/D/C/B/A/S) assigned on registration
// - No class at start — assigned later via checkClassAssignment
// - Currency is Mana Stones (manaCrystals), not gold
// - "System" notification style UI
// ═══════════════════════════════════════════════════════════════

const {
  rollAwakeningRank,
  buildStartingStats,
  getAwakeningMessage,
  calculatePowerRating,
  AWAKENING_RANKS,
} = require('../../rpg/utils/SoloLevelingCore');

const RegenManager = require('../../rpg/utils/RegenManager');

const RANK_START_BONUSES = {
  E: { manaStones: 500,   upgradePoints: 3  },
  D: { manaStones: 800,   upgradePoints: 4  },
  C: { manaStones: 1200,  upgradePoints: 6  },
  B: { manaStones: 2000,  upgradePoints: 8  },
  A: { manaStones: 3500,  upgradePoints: 12 },
  S: { manaStones: 6000,  upgradePoints: 20 },
};

module.exports = {
  name: 'register',
  aliases: ['reg', 'start', 'join'],
  description: 'Awaken as a hunter in the Solo Leveling world',

  async execute(sock, msg, args, getDatabase, saveDatabase, sender) {
    const chatId = msg.key?.remoteJid;
    const db = getDatabase();

    if (db.users[sender]) {
      const p = db.users[sender];
      const rank = p.awakenRank || 'E';
      const rankData = AWAKENING_RANKS[rank];
      const power = calculatePowerRating(p.stats || {});
      return sock.sendMessage(chatId, {
        text: [
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `「System」 *ALREADY AWAKENED*`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          ``,
          `👤 *${p.name}*`,
          `${rankData.emoji} *${rankData.label}*`,
          `⚡ Level ${p.level || 1} | Power: ${power.toLocaleString()}`,
          `💎 Mana Stones: ${(p.manaCrystals || 0).toLocaleString()}`,
          p.class ? `🎭 Class: *${p.class}*` : `🎭 Class: *Unassigned* (keep leveling)`,
          ``,
          `📌 Use /profile to view your full stats`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ].join('\n')
      }, { quoted: msg });
    }

    const name = args.join(' ').trim() || msg.pushName || 'Hunter';
    const cleanName = name.substring(0, 20).replace(/[<>]/g, '');

    const rank = rollAwakeningRank();
    const rankData = AWAKENING_RANKS[rank];
    const stats = buildStartingStats(rank);
    const bonus = RANK_START_BONUSES[rank];
    const power = calculatePowerRating(stats);

    const newPlayer = {
      name: cleanName,
      id: sender,
      registeredAt: Date.now(),
      awakenRank: rank,
      level: 1,
      xp: 0,
      class: null,
      classAssignedAt: null,
      evolvedClass: null,
      stats: { ...stats },
      baseStats: { ...stats },
      upgradePoints: bonus.upgradePoints,
      statAllocations: { hp: 0, atk: 0, def: 0, magicPower: 0, speed: 0, critChance: 0, critDamage: 0, lifesteal: 0, energy: 0 },
      manaCrystals: bonus.manaStones,
      gold: 0,
      skills: { active: [], locked: [], cooldowns: {} },
      inventory: { weapons: [], armor: [], accessories: [], potions: [], artifacts: [], materials: [], keyStones: [] },
      equipped: { weapon: null, armor: null, helmet: null, gloves: null, boots: null, accessory: null, artifact: null, artifact2: null },
      pet: null,
      guild: null,
      guildJoinedAt: null,
      aura: 0,
      auraTitle: null,
      inBattle: false,
      inGate: false,
      currentGateId: null,
      awakening: { tier: 0, passives: [] },
      stats_history: { gatesCleared: 0, pvpWins: 0, pvpLosses: 0, monstersKilled: 0, totalDamageDealt: 0 },
      deathCount: 0,
      lastDeathAt: null,
      titles: [],
      equippedTitle: null,
      lastDaily: null,
      lastRegen: Date.now(),
      lastActive: Date.now(),
      banned: false,
      afk: false,
    };

    db.users[sender] = newPlayer;
    saveDatabase();

    const systemMsg = getAwakeningMessage(rank);
    const isRare = ['B', 'A', 'S'].includes(rank);

    const lines = [
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      isRare ? `‼️ *RARE AWAKENING DETECTED* ‼️` : `「System」 *AWAKENING INITIATED*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      systemMsg,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `👤 Hunter: *${cleanName}*`,
      `${rankData.emoji} Rank: *${rankData.label}*`,
      `⚡ Power Rating: *${power.toLocaleString()}*`,
      ``,
      `📊 *BASE STATS:*`,
      `❤️ HP:     ${stats.maxHp}`,
      `⚔️ ATK:    ${stats.atk}`,
      `🛡️ DEF:    ${stats.def}`,
      `💨 SPD:    ${stats.speed}`,
      `💙 Energy: ${stats.maxEnergy}`,
      ``,
      `💰 *START BONUS:*`,
      `💎 ${bonus.manaStones.toLocaleString()} Mana Stones`,
      `📈 ${bonus.upgradePoints} Upgrade Points`,
      ``,
      `🎭 Class: *Not yet assigned*`,
      `    ↳ Your class will reveal itself as you grow stronger.`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `📌 *GETTING STARTED:*`,
      `/gates — View active gates`,
      `/guild — Find or create a guild`,
      `/profile — View your full profile`,
      `/upgrade — Allocate stat points`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      rankData.description,
    ];

    return sock.sendMessage(chatId, { text: lines.join('\n') }, { quoted: msg });
  }
};