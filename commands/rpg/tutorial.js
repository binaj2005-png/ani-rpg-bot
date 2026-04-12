// tutorial.js — Interactive game-style onboarding tutorial
// Spawns a private guided dungeon for new players only

const TUTORIAL_MONSTER = {
  name: 'Training Dummy',
  emoji: '🪆',
  stats: { hp: 80, maxHp: 80, atk: 8, def: 2 },
  abilities: ['Weak Strike'],
  level: 1,
  isTutorial: true
};

const TUTORIAL_BOSS = {
  name: 'Shadow Wisp',
  emoji: '👁️',
  stats: { hp: 150, maxHp: 150, atk: 15, def: 5 },
  abilities: ['Soul Drain', 'Dark Pulse'],
  level: 3,
  isBoss: true,
  isTutorial: true
};

// Active tutorial sessions
const tutorialSessions = new Map(); // sender → session

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function typeEffect(sock, chatId, lines, delay = 800) {
  for (const line of lines) {
    await sock.sendMessage(chatId, { text: line });
    await sleep(delay);
  }
}

async function startTutorialDungeon(sock, chatId, sender, player) {
  const tag = `@${sender.split('@')[0]}`;
  const mentions = [sender];

  // Mark tutorial as in progress
  tutorialSessions.set(sender, {
    stage: 'intro',
    monster: JSON.parse(JSON.stringify(TUTORIAL_MONSTER)),
    boss: JSON.parse(JSON.stringify(TUTORIAL_BOSS)),
    floor: 1,
    playerHp: player.stats.maxHp,
    playerMaxHp: player.stats.maxHp,
    playerEnergy: player.stats.maxEnergy,
    playerMaxEnergy: player.stats.maxEnergy,
    playerAtk: player.stats.atk,
    playerDef: player.stats.def,
    chatId
  });

  // ── CINEMATIC OPENING ─────────────────────────────────
  await sleep(500);

  await sock.sendMessage(chatId, {
    text: `⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛\n⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛\n⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛`,
    mentions
  });
  await sleep(1000);

  await sock.sendMessage(chatId, {
    text: `⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛\n⬛⬛⬛⬜⬜⬜⬜⬜⬜⬜⬜⬜⬛⬛⬛\n⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛`,
    mentions
  });
  await sleep(800);

  await sock.sendMessage(chatId, {
    text: `*S Y S T E M   N O T I F I C A T I O N*`,
    mentions
  });
  await sleep(600);

  await sock.sendMessage(chatId, {
    text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚠️ *TUTORIAL DUNGEON ACTIVATED*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${tag}, the system has detected you are a *new hunter.*\n\nA training dungeon has been opened for you.\n\n🎯 Complete it to prove yourself worthy.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    mentions
  });
  await sleep(1500);

  // ── FLOOR 1 INTRO ─────────────────────────────────────
  await sock.sendMessage(chatId, {
    text: `🌑 *[LOADING DUNGEON...]*\n▓▓▓▓▓▓▓░░░░░░░ 53%`,
    mentions
  });
  await sleep(1000);
  await sock.sendMessage(chatId, {
    text: `🌑 *[LOADING DUNGEON...]*\n▓▓▓▓▓▓▓▓▓▓▓▓░░ 89%`,
    mentions
  });
  await sleep(800);
  await sock.sendMessage(chatId, {
    text: `🌑 *[LOADING DUNGEON...]*\n▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 100%\n\n✅ *DUNGEON LOADED*`,
    mentions
  });
  await sleep(1000);

  await sock.sendMessage(chatId, {
    text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏚️ *TUTORIAL DUNGEON — FLOOR 1*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n*The air is cold. The dungeon hums.*\n*Something stirs in the shadows...*\n\n🪆 A *Training Dummy* appears!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🪆 *Training Dummy* Lv.1\n${getHpBar(80, 80)} 80/80 HP\n\n👤 *${player.name}*\n${getHpBar(player.stats.maxHp, player.stats.maxHp)} ${player.stats.maxHp}/${player.stats.maxHp} HP\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 *TUTORIAL:* This is your first enemy!\n\n👇 Type */tutorial attack* to strike!`,
    mentions
  });

  // Update stage
  const session = tutorialSessions.get(sender);
  session.stage = 'floor1_waiting_attack';
  tutorialSessions.set(sender, session);
}

async function handleTutorialAction(sock, chatId, sender, player, action, db, saveDatabase) {
  const session = tutorialSessions.get(sender);
  if (!session) return false;

  const tag = `@${sender.split('@')[0]}`;
  const mentions = [sender];

  // ── ATTACK ────────────────────────────────────────────
  if (action === 'attack' && session.stage === 'floor1_waiting_attack') {
    const playerAtk = session.playerAtk + (player.weapon?.bonus || 0);
    const dmg = Math.max(3, Math.floor(playerAtk - session.monster.stats.def * 0.4 + Math.random() * 5));
    const monsterDmg = Math.max(1, Math.floor(TUTORIAL_MONSTER.stats.atk - session.playerDef * 0.3));

    session.monster.stats.hp = Math.max(0, session.monster.stats.hp - dmg);
    session.playerHp = Math.max(0, session.playerHp - monsterDmg);

    // Attack animation
    await sock.sendMessage(chatId, {
      text: `⚔️ *${player.name}* swings at the dummy!\n\n💨 ━━━━━━━━━━▶ 🪆\n\n💥 *HIT!* Dealt *${dmg}* damage!`,
      mentions
    });
    await sleep(800);

    if (session.monster.stats.hp <= 0) {
      // Monster dead
      session.stage = 'floor1_cleared';
      tutorialSessions.set(sender, session);
      await floor1Clear(sock, chatId, sender, player, mentions, session);
    } else {
      // Monster counter
      await sleep(600);
      await sock.sendMessage(chatId, {
        text: `🪆 *Training Dummy* strikes back!\n\n💨 🪆 ━━━━━━━━━━▶ 👤\n\n🩹 Took *${monsterDmg}* damage!\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🪆 *Dummy:* ${getHpBar(session.monster.stats.hp, 80)} ${session.monster.stats.hp}/80 HP\n👤 *${player.name}:* ${getHpBar(session.playerHp, session.playerMaxHp)} ${session.playerHp}/${session.playerMaxHp} HP\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n👇 Keep attacking! */tutorial attack*\n💡 Or use a skill: */tutorial skill*`,
        mentions
      });
      session.stage = 'floor1_waiting_attack';
      tutorialSessions.set(sender, session);
    }
    return true;
  }

  // ── SKILL ─────────────────────────────────────────────
  if (action === 'skill' && (session.stage === 'floor1_waiting_attack' || session.stage === 'floor2_waiting')) {
    const skill = player.skills?.active?.[0];
    if (!skill) {
      await sock.sendMessage(chatId, { text: `❌ No skills equipped yet! Use */tutorial attack* instead.`, mentions });
      return true;
    }

    if ((session.playerEnergy || 0) < skill.energyCost) {
      await sock.sendMessage(chatId, { text: `❌ Not enough energy! Use */tutorial attack* instead.`, mentions });
      return true;
    }

    session.playerEnergy -= skill.energyCost;
    const skillDmg = Math.floor(skill.damage + session.playerAtk * 0.5);
    const isCrit = Math.random() < 0.2;
    const finalDmg = isCrit ? Math.floor(skillDmg * 1.5) : skillDmg;

    const target = session.stage === 'floor2_waiting' ? session.boss : session.monster;
    target.stats.hp = Math.max(0, target.stats.hp - finalDmg);

    const monsterDmg = Math.max(1, Math.floor((target.stats.atk || 8) - session.playerDef * 0.3));
    session.playerHp = Math.max(0, session.playerHp - Math.floor(monsterDmg * 0.7));

    await sock.sendMessage(chatId, {
      text: `✨ *${player.name}* unleashes *${skill.name}*!\n\n🔮 ╔══════════════╗\n   ║  ${skill.name.padEnd(14)}║\n   ╚══════════════╝\n\n${isCrit ? '💥 *CRITICAL HIT!*\n' : ''}⚔️ Dealt *${finalDmg}* damage!\n${player.energyColor || '💙'} Energy: ${session.playerEnergy}/${session.playerMaxEnergy}`,
      mentions
    });
    await sleep(800);

    if (target.stats.hp <= 0) {
      if (session.stage === 'floor2_waiting') {
        session.stage = 'boss_cleared';
        tutorialSessions.set(sender, session);
        await bossClear(sock, chatId, sender, player, mentions, session, db, saveDatabase);
      } else {
        session.stage = 'floor1_cleared';
        tutorialSessions.set(sender, session);
        await floor1Clear(sock, chatId, sender, player, mentions, session);
      }
    } else {
      await sock.sendMessage(chatId, {
        text: `🩹 ${target.emoji} counter attacks! Took *${Math.floor(monsterDmg * 0.7)}* damage!\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${target.emoji} *${target.name}:* ${getHpBar(target.stats.hp, target.stats.maxHp)} ${target.stats.hp}/${target.stats.maxHp}\n👤 *${player.name}:* ${getHpBar(session.playerHp, session.playerMaxHp)} ${session.playerHp}/${session.playerMaxHp}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n👇 */tutorial attack* or */tutorial skill*`,
        mentions
      });
    }
    return true;
  }

  // ── ADVANCE ───────────────────────────────────────────
  if (action === 'advance' && session.stage === 'floor1_cleared') {
    session.stage = 'floor2_intro';
    tutorialSessions.set(sender, session);
    await startBossFloor(sock, chatId, sender, player, mentions, session);
    return true;
  }

  // ── BOSS ATTACK ───────────────────────────────────────
  if (action === 'attack' && session.stage === 'floor2_waiting') {
    const playerAtk = session.playerAtk + (player.weapon?.bonus || 0);
    const dmg = Math.max(5, Math.floor(playerAtk - session.boss.stats.def * 0.4 + Math.random() * 8));
    const bossDmg = Math.max(3, Math.floor(session.boss.stats.atk - session.playerDef * 0.3));

    session.boss.stats.hp = Math.max(0, session.boss.stats.hp - dmg);
    session.playerHp = Math.max(0, session.playerHp - bossDmg);

    // Dramatic boss attack
    await sock.sendMessage(chatId, {
      text: `⚔️ *${player.name}* strikes the *Shadow Wisp*!\n\n⚡ ━━━━━━━━━━▶ 👁️\n\n💥 Dealt *${dmg}* damage!\n\n👁️ *Shadow Wisp* retaliates!\n💀 *DARK PULSE!*\n🩸 Took *${bossDmg}* damage!\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👁️ *Boss:* ${getHpBar(session.boss.stats.hp, 150)} ${session.boss.stats.hp}/150\n👤 *${player.name}:* ${getHpBar(session.playerHp, session.playerMaxHp)} ${session.playerHp}/${session.playerMaxHp}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n👇 */tutorial attack* or */tutorial skill*`,
      mentions
    });

    if (session.boss.stats.hp <= 0) {
      session.stage = 'boss_cleared';
      tutorialSessions.set(sender, session);
      await bossClear(sock, chatId, sender, player, mentions, session, db, saveDatabase);
    } else if (session.playerHp <= 0) {
      // Player died — respawn with full HP (it's tutorial)
      session.playerHp = session.playerMaxHp;
      tutorialSessions.set(sender, session);
      await sock.sendMessage(chatId, {
        text: `💀 *You were defeated...*\n\n*...*\n*...*\n\n💫 *But this is a tutorial. You respawn!*\n\n❤️ HP fully restored!\n\n👇 Try again: */tutorial attack*`,
        mentions
      });
    }
    return true;
  }

  return false;
}

async function floor1Clear(sock, chatId, sender, player, mentions, session) {
  // Restore some energy
  session.playerEnergy = Math.min(session.playerMaxEnergy, (session.playerEnergy || 0) + 20);
  tutorialSessions.set(sender, session);

  await sock.sendMessage(chatId, {
    text: `💥 *Training Dummy* shattered!\n\n✨ ✨ ✨ ✨ ✨\n🏆 *FLOOR 1 CLEARED!*\n✨ ✨ ✨ ✨ ✨\n\n📊 *REWARDS:*\n✨ +50 XP\n💰 +500 Gold\n${player.energyColor || '💙'} +20 Energy restored\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 *TUTORIAL:* Great job! Now you know how to attack.\n\nUp ahead is something more dangerous...\n*A real monster awaits on Floor 2.*\n\n👇 Type */tutorial advance* to continue!`,
    mentions
  });
}

async function startBossFloor(sock, chatId, sender, player, mentions, session) {
  await sleep(500);

  // Dramatic boss intro animation
  await sock.sendMessage(chatId, { text: `*...*`, mentions });
  await sleep(700);
  await sock.sendMessage(chatId, { text: `*The dungeon grows darker...*`, mentions });
  await sleep(800);
  await sock.sendMessage(chatId, { text: `*Something watches you from the shadows...*`, mentions });
  await sleep(900);

  await sock.sendMessage(chatId, {
    text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔴 *BOSS FLOOR — FLOOR 2*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n👁️ *SHADOW WISP* emerges!\n\n💬 *"You dare enter MY dungeon? Foolish hunter..."*\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👁️ *Shadow Wisp* Lv.3 🔴 BOSS\n${getHpBar(150, 150)} 150/150 HP\n⚔️ ATK: 15 | 🛡️ DEF: 5\n\n👤 *${player.name}*\n${getHpBar(session.playerHp, session.playerMaxHp)} ${session.playerHp}/${session.playerMaxHp} HP\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n⚠️ *Boss enemies hit harder!*\n💡 Use skills when you can!\n\n👇 */tutorial attack* — Basic strike\n👇 */tutorial skill* — Use your skill`,
    mentions
  });

  session.stage = 'floor2_waiting';
  tutorialSessions.set(sender, session);
}

async function bossClear(sock, chatId, sender, player, mentions, session, db, saveDatabase) {
  // Give real rewards
  player.xp = (player.xp || 0) + 200;
  player.gold = (player.gold || 0) + 1500;
  player.manaCrystals = (player.manaCrystals || 0) + 30;
  if (!player.tutorialCompleted) player.tutorialCompleted = true;
  saveDatabase();

  // Remove session
  tutorialSessions.delete(sender);

  // Victory animation
  await sock.sendMessage(chatId, { text: `👁️ *The Shadow Wisp screams...*`, mentions });
  await sleep(600);
  await sock.sendMessage(chatId, { text: `💀 *...and dissolves into nothing.*`, mentions });
  await sleep(800);

  await sock.sendMessage(chatId, {
    text: `✨ ✨ ✨ ✨ ✨ ✨ ✨ ✨\n🏆 *TUTORIAL DUNGEON CLEARED!*\n✨ ✨ ✨ ✨ ✨ ✨ ✨ ✨`,
    mentions
  });
  await sleep(1000);

  await sock.sendMessage(chatId, {
    text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎊 *HUNTER ${player.name.toUpperCase()} — CERTIFIED!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📊 *TUTORIAL REWARDS:*\n✨ +200 XP\n💰 +1,500 Gold\n💎 +30 Crystals\n🏅 *Title: Rookie Hunter*\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*You have proven yourself worthy.*\n*The real dungeons await.*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    mentions
  });
  await sleep(1500);

  await sock.sendMessage(chatId, {
    text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🗺️ *WHAT TO DO NEXT:*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n⚔️ */dungeon* — Real dungeons (harder, better rewards)\n🥊 */pvp challenge @user* — Fight other players\n📅 */daily* — Claim daily gold & crystals\n💎 */summon* — Gacha pulls for artifacts\n🏪 */shop* — Buy potions & gear\n📋 */profile* — View your stats\n❓ */help* — See ALL commands\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*The hunt begins now, ${player.name}.*\n*Make your legend.* 🔥\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    mentions
  });
}

function getHpBar(current, max) {
  const pct = Math.max(0, Math.min(1, current / max));
  const filled = Math.round(pct * 10);
  const empty = 10 - filled;
  const color = pct > 0.5 ? '🟩' : pct > 0.25 ? '🟨' : '🟥';
  return color.repeat(filled) + '⬛'.repeat(empty);
}

function isInTutorial(sender) {
  return tutorialSessions.has(sender);
}

module.exports = {
  name: 'tutorial',
  description: '📖 Start the guided tutorial dungeon',
  isInTutorial,
  startTutorialDungeon,
  handleTutorialAction,

  async execute(sock, msg, args, getDatabase, saveDatabase, sender) {
    const chatId = msg.key.remoteJid;
    const db = getDatabase();
    const player = db.users[sender];
    const mentions = [sender];

    if (!player) {
      return sock.sendMessage(chatId, {
        text: `❌ Register first!\n\nType */register [your name]* to begin.`,
        mentions,
        quoted: msg
      });
    }

    const action = args[0]?.toLowerCase();

    // Handle tutorial actions
    if (action && isInTutorial(sender)) {
      const handled = await handleTutorialAction(sock, chatId, sender, player, action, db, saveDatabase);
      if (handled) return;
    }

    // Start or restart tutorial
    if (!action || action === 'start') {
      if (player.tutorialCompleted) {
        return sock.sendMessage(chatId, {
          text: `✅ You already completed the tutorial!\n\nType */dungeon* for real dungeons.`,
          mentions,
          quoted: msg
        });
      }
      await startTutorialDungeon(sock, chatId, sender, player);
      return;
    }

    // Unknown tutorial action
    if (isInTutorial(sender)) {
      return sock.sendMessage(chatId, {
        text: `⚔️ Tutorial in progress!\n\n👇 */tutorial attack* — Attack\n👇 */tutorial skill* — Use skill\n👇 */tutorial advance* — Next floor`,
        mentions,
        quoted: msg
      });
    }
  }
};