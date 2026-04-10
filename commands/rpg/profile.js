const PlayerMigration = require('../../rpg/utils/PlayerMigration');
const ProfileCard     = require('../../rpg/utils/ProfileCard');
let AchievementManager; try { AchievementManager = require('../../rpg/utils/AchievementManager'); } catch(e) {}

module.exports = {
  name: 'profile',
  description: '👤 View player profile card',
  usage: '/profile [@user]',
  category: 'rpg',

  async execute(sock, msg, args, getDatabase, saveDatabase, sender) {
    const chatId = msg.key.remoteJid;
    const db = getDatabase();

    let targetId = sender;
    const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (mentionedJid) {
      targetId = mentionedJid;
    } else if (args[0]) {
      const searchTerm = args.join(' ').toLowerCase().replace('@', '');
      for (const userId in db.users) {
        const u = db.users[userId];
        if (u.name?.toLowerCase().includes(searchTerm) || userId.includes(searchTerm)) {
          targetId = userId; break;
        }
      }
    }

    const playerRaw = db.users[targetId];
    if (!playerRaw) {
      return sock.sendMessage(chatId, { text: '❌ Player not found!\nUse: /profile [@user] or /profile [name]' }, { quoted: msg });
    }

    const player = PlayerMigration.migratePlayer(playerRaw);
    db.users[targetId] = player;

    const SUPER_USERS = ['221951679328499@lid', '194592469209292@lid'];
    const isSuperUser = SUPER_USERS.includes(sender);
    const isViewingOwn = sender === targetId;
    if (player.profileLocked && !isViewingOwn && !isSuperUser) {
      return sock.sendMessage(chatId, { text: `🔒 *${player.name}* has locked their profile.` }, { quoted: msg });
    }

    if (AchievementManager) {
      try {
        AchievementManager.track(player, 'level_reached', player.level || 1);
        AchievementManager.track(player, 'pvp_wins', player.pvpWins || 0);
        AchievementManager.track(player, 'gold_accumulated', player.gold || 0);
      } catch(e) {}
    }
    saveDatabase();

    try {
      const cardBuffer = await ProfileCard.generateProfileCard(player);
      if (cardBuffer) {
        const className = typeof player.class === 'string' ? player.class : (player.class?.name || 'Hunter');
        const elo = player.pvpElo || 1000;
        const pvpWins = player.pvpWins || 0;
        const pvpLosses = player.pvpLosses || 0;
        const achCount = player.achievements?.unlocked?.length || 0;
        const caption =
          `👤 *${player.name}* — Lv.${player.level||1} ${className}\n` +
          `💰 ${(player.gold||0).toLocaleString()}g  |  ⚔️ ELO ${elo}  |  🏅 ${achCount} achievements\n` +
          `📊 ${pvpWins}W / ${pvpLosses}L\n\n` +
          `💡 /stats • /skills • /inventory • /artifact`;
        return sock.sendMessage(chatId, { image: cardBuffer, caption, mentions: [targetId] }, { quoted: msg });
      }
    } catch(e) {
      console.error('[Profile] Canvas error:', e.message);
    }

    // Text fallback
    const className = typeof player.class === 'string' ? player.class : (player.class?.name || 'Unclassed');
    const lvl = player.level || 1;
    const stats = player.stats || {};
    const xpNeeded = Math.floor(200 * Math.pow(lvl, 1.8));
    const xpPct = Math.floor(Math.min(100, ((player.xp||0)/xpNeeded)*100));
    const pvpWins = player.pvpWins || 0;
    const pvpLosses = player.pvpLosses || 0;
    const pvpTotal = pvpWins + pvpLosses;
    const wr = pvpTotal > 0 ? Math.floor((pvpWins/pvpTotal)*100) : 0;
    const bossKills = typeof player.bossesDefeated === 'object'
      ? Object.keys(player.bossesDefeated||{}).length : (player.bossesDefeated || 0);
    const achCount = player.achievements?.unlocked?.length || 0;
    const bar = (cur, max, len=10) => { const f = Math.round(Math.min(1, cur/max)*len); return '█'.repeat(f)+'░'.repeat(len-f); };

    const text =
`╔═══════════════════════════╗
  👤 ${player.name}'s PROFILE
╚═══════════════════════════╝
${className} | Lv.${lvl} | Rank ${player.rank||'F'}

❤️ HP  ${bar(stats.hp||0, stats.maxHp||100)} ${stats.hp||0}/${stats.maxHp||100}
⚡ EN  ${bar(stats.energy||0, stats.maxEnergy||100)} ${stats.energy||0}/${stats.maxEnergy||100}
✨ XP  ${bar(player.xp||0, xpNeeded)} ${xpPct}%

⚔️ ATK: ${stats.atk||0}  🛡️ DEF: ${stats.def||0}  💨 SPD: ${stats.speed||0}

💰 Gold: ${(player.gold||0).toLocaleString()}
💎 Crystals: ${(player.manaCrystals||0).toLocaleString()}

⚔️ PVP: ${pvpWins}W/${pvpLosses}L (${wr}%) | ELO: ${player.pvpElo||1000}
👹 Bosses: ${bossKills} | 🏅 Achievements: ${achCount}

💡 /stats • /skills • /inventory`;

    return sock.sendMessage(chatId, { text, mentions: [targetId] }, { quoted: msg });
  }
};