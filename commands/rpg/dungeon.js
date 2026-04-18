// dungeon.js — Tower Dungeon System v2
// Party of 2-5 → form first → choose dungeon type → 20 floors
// Boss every 5 floors. Advance or leave after each boss.
// 8 dungeon types, all with unique themes/monsters.

const DungeonManager    = require('../../rpg/dungeons/DungeonManager');
const BP = require('../../rpg/utils/BattlePass');
let TitleSystem; try { TitleSystem = require('../../rpg/utils/TitleSystem'); } catch(e) {}
let DC; try { DC = require('../../rpg/utils/DailyChallenges'); } catch(e) {}
const DungeonPartyManager = require('../../rpg/dungeons/DungeonPartyManager');
const ImprovedCombat    = require('../../rpg/utils/ImprovedCombat');
let BuffManager; try { BuffManager = require('../../rpg/utils/BuffManager'); } catch(e) {}
const StatusEffectManager = require('../../rpg/utils/StatusEffectManager');
const BarSystem         = require('../../rpg/utils/BarSystem');
const LevelUpManager    = require('../../rpg/utils/LevelUpManager');
const ArtifactSystem    = require('../../rpg/utils/ArtifactSystem');
const PetManager        = require('../../rpg/utils/PetManager');
const QuestManager      = require('../../rpg/utils/QuestManager');
const AchievementManager = require('../../rpg/utils/AchievementManager');
const StatAllocationSystem = require('../../rpg/utils/StatAllocationSystem');
const SeasonManager = require('../../rpg/utils/SeasonManager');
const GuildWar = require('./guildwar');
const SkillDescriptions = require('../../rpg/utils/SkillDescriptions');
const { getPartyBonuses, formatBonusSummary } = require('../../rpg/utils/PartyRoleSystem');
const { tickDurability } = require('../../rpg/utils/GearSystem');

// ─── HELPERS ───────────────────────────────────────────────────
async function notifyAchievements(sock, playerId, player, achievements) {
  if (!achievements?.length) return;
  const n = AchievementManager.buildNotification(achievements);
  if (n) try { await sock.sendMessage(playerId.includes('@') ? playerId : `${playerId}@s.whatsapp.net`, { text: n }); } catch(e) {}
}
async function notifyQuestUpdates(sock, playerId, updates) {
  if (!updates?.length) return;
  const completed = updates.filter(u => u.type === 'completed');
  for (const u of completed) {
    try {
      await sock.sendMessage(playerId.includes('@') ? playerId : `${playerId}@s.whatsapp.net`, {
        text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎯 QUEST COMPLETED!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ *${u.questName}*\n\n💡 Use */quest complete ${u.questId}* to claim rewards!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      });
    } catch(e) {}
  }
}

// ─── MONSTER DIALOGUE ──────────────────────────────────────────
const MONSTER_DIALOGUE = {
  default: ['*growls menacingly*', '*attacks!*', '*snarls*'],
  Goblin: ['Grrr! Human flesh!', 'Me smash you!', 'Shinies! Give shinies!'],
  Wolf: ['*GROWL*', 'AWOOOO!', '*snarls and bares fangs*'],
  Skeleton: ['*rattle* *rattle*', 'Your bones will join mine!', 'Join us in death...'],
  Slime: ['*blob* *blob*', 'Squish squish!', '*jiggles menacingly*'],
  Dragon: ['INSIGNIFICANT MORTAL!', 'I will turn you to ASH!', 'You DARE?!'],
  Demon: ['Your suffering delights me!', 'I will feast on your despair!', 'This realm is MINE!'],
};
function getDialogue(name) {
  const k = Object.keys(MONSTER_DIALOGUE).find(k => name.includes(k));
  const pool = k ? MONSTER_DIALOGUE[k] : MONSTER_DIALOGUE.default;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── MONSTER AI ────────────────────────────────────────────────
function executeMonsterAI(monster, player) {
  const useSkill = Math.random() < 0.75 && monster.abilities?.length > 0;
  const ability  = useSkill ? monster.abilities[Math.floor(Math.random() * monster.abilities.length)] : null;
  const line     = getDialogue(monster.name);

  let atkMult = ability ? 1.5 : 1.0;
  const baseDmg  = Math.floor(monster.stats.atk * atkMult);
  const defReduc = Math.floor(player.stats.def * 0.4);

  // Player dodge
  const speedDiff = (player.stats.speed || 100) - (monster.stats.speed || 80);
  const dodge     = Math.max(0, Math.min(0.30, speedDiff / 200));
  if (dodge > 0 && Math.random() < dodge) {
    return `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔄 ${monster.name.toUpperCase()}'S TURN\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${monster.emoji} ${monster.name} ${ability ? `uses *${ability}*!` : 'attacks!'}\n💬 "${line}"\n💨 *DODGED!* You were too fast!\n❤️ Your HP: ${player.stats.hp}/${player.stats.maxHp}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }

  const finalDmg = Math.max(8, baseDmg - defReduc);
  player.stats.hp = Math.max(0, player.stats.hp - finalDmg);

  let msg = `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔄 ${monster.name.toUpperCase()}'S TURN\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `${monster.emoji} ${monster.name} ${ability ? `uses *${ability}*!` : 'attacks!'}\n💬 "${line}"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💥 You take *${finalDmg}* damage!\n❤️ Your HP: ${Math.max(0, player.stats.hp)}/${player.stats.maxHp}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  return msg;
}

// ─── FLOOR ADVANCE PROMPT ──────────────────────────────────────
function buildAdvancePrompt(dungeon, nextFloor, party) {
  const isBossNext = DungeonManager.isBossFloor(nextFloor);
  const aliveCount = party.members.length;
  let txt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏆 *FLOOR ${dungeon.currentFloor} CLEARED!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  txt += `📊 Progress: Floor ${dungeon.currentFloor}/${dungeon.maxFloors}\n`;
  txt += `👥 Party alive: ${aliveCount}/${party.members.length}\n\n`;
  if (nextFloor > dungeon.maxFloors) {
    txt += `🏆 *DUNGEON COMPLETE!*\nUse /dungeon finish to claim rewards.\n`;
  } else {
    if (isBossNext) {
      txt += `⚠️ *NEXT: BOSS FLOOR ${nextFloor}!*\n💭 A powerful guardian awaits...\n💡 Tip: Use potions before the boss!\n\n`;
    } else {
      txt += `🔽 *Floor ${nextFloor} awaits...*\n`;
    }
    txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    txt += `/dungeon advance — Press deeper\n`;
    txt += `/dungeon leave   — Exit & keep rewards\n`;
    txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }
  return txt;
}

// ─── MAIN MODULE ───────────────────────────────────────────────
module.exports = {
  name: 'dungeon',
  description: 'Tower Dungeon System — Party of 2-5, 20 floors, boss every 5 floors',

  async execute(sock, msg, args, getDatabase, saveDatabase, sender) {
    const chatId = msg.key?.remoteJid;
    if (!chatId) return;
    const db     = getDatabase();
    const player = db.users[sender];
    if (!player) return sock.sendMessage(chatId, { text: '❌ Register first! Use /register' }, { quoted: msg });

    const sub = args[0]?.toLowerCase();
    const OWNER_ID = '221951679328499@lid';
    const isOwner  = sender === OWNER_ID;

    // Dead players can only use items
    if (!isOwner && player.stats.hp <= 0 && !['item','help','status'].includes(sub)) {
      const party = DungeonPartyManager.getPartyByPlayer(sender);
      if (party?.status === 'active') {
        return sock.sendMessage(chatId, { text: `💀 *You are dead!*\nUse */dungeon item revive* if you have a Revive Token.\nOr wait for the dungeon to end.` }, { quoted: msg });
      }
    }

    // ── HELP ─────────────────────────────────────────────────
    if (!sub || sub === 'help') {
      return sock.sendMessage(chatId, { text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏰 *TOWER DUNGEON SYSTEM*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🗂️ 8 Dungeon Types × 20 Floors each\n👹 Boss every 5 floors (F5, F10, F15, F20)\n👤 Solo or 👥 Party of 2-5 hunters!\n\n📋 *SOLO COMMANDS:*\n/dungeon solo         — Start solo dungeon\n/dungeon solo [#]     — Pick dungeon type\n/dungeon attack       — Attack\n/dungeon use [skill]  — Use skill\n/dungeon item [hp/energy/revive] — Use item\n/dungeon advance      — Next floor\n/dungeon leave        — Exit (keep rewards)\n/dungeon flee         — Flee\n\n📋 *PARTY COMMANDS:*\n/dungeon party create — Form a party\n/dungeon party join [ID] — Join party\n/dungeon party info   — Party status\n/dungeon party leave  — Leave party\n/dungeon ready        — Mark yourself ready\n/dungeon start [#]    — Leader starts dungeon\n\n📋 *OTHER:*\n/dungeon types        — See all dungeon types\n/dungeon shop         — Buy items\n/dungeon status       — Check floor/party status\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Solo: 10 floors, easier monsters, good rewards!\n💡 Party: 20 floors, harder, MUCH better rewards!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━` }, { quoted: msg });
    }

    // ── SOLO DUNGEON ──────────────────────────────────────────
    if (sub === 'solo') {
      // Check if already in a party dungeon
      const existingParty = DungeonPartyManager.getPartyByPlayer(sender);
      if (existingParty?.status === 'active') {
        return sock.sendMessage(chatId, { text: '❌ You are already in a party dungeon!\nUse /dungeon leave to exit first.' }, { quoted: msg });
      }

      // Check if already in solo dungeon
      if (db.soloDungeons && db.soloDungeons[sender]) {
        const sd = db.soloDungeons[sender];
        const monster = sd.currentMonster;
        const hpBar = BarSystem.getMonsterHPBar(monster.stats.hp, monster.stats.maxHp);
        const pHpBar = BarSystem.getHPBar(player.stats.hp, player.stats.maxHp);
        return sock.sendMessage(chatId, {
          text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚔️ *SOLO DUNGEON IN PROGRESS*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏰 ${sd.dungeonName} | Floor ${sd.currentFloor}/10\n💰 Earned so far: ${(sd.totalGold||0).toLocaleString()}g | ✨ ${(sd.totalXp||0).toLocaleString()} XP\n\n${monster.emoji} *${monster.name}* [Lv.${monster.level}]\n${hpBar} ${monster.stats.hp}/${monster.stats.maxHp} HP\n⚔️ ATK: ${monster.stats.atk} | 🛡️ DEF: ${monster.stats.def}\n\n👤 *${player.name}*\n${pHpBar} ${player.stats.hp}/${player.stats.maxHp} HP\n\n/dungeon attack — Attack\n/dungeon use [skill] — Use skill\n/dungeon item hp — Use health potion\n/dungeon flee — Flee\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`
        }, { quoted: msg });
      }

      // Pick dungeon type
      const available = DungeonManager.getAvailableTypes(player.level);
      if (available.length === 0) {
        return sock.sendMessage(chatId, { text: '❌ No dungeons available at your level!' }, { quoted: msg });
      }

      const choice = parseInt(args[1]);
      if (!args[1] || isNaN(choice)) {
        let txt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏰 *SOLO DUNGEON — CHOOSE TYPE*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\nYour Level: ${player.level}\n⚠️ Solo: 10 floors, scaled to your level\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        available.forEach((d, i) => {
          txt += `*${i+1}.* ${d.emoji} ${d.name} [Rank ${d.rank}]\n   Req. Lv${d.minLevel}+ | ${d.description}\n\n`;
        });
        txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n/dungeon solo [#] to enter`;
        return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      }

      const dtype = available[choice - 1];
      if (!dtype) return sock.sendMessage(chatId, { text: '❌ Invalid choice!' }, { quoted: msg });

      // Spawn first monster (scaled easier for solo — 70% of normal stats)
      const monster = DungeonManager.getFloorMonster(dtype.id, 1, player.level);
      monster.stats.hp = Math.floor(monster.stats.hp * 0.5);
      monster.stats.maxHp = monster.stats.hp;
      monster.stats.atk = Math.floor(monster.stats.atk * 0.5);
      monster.stats.def = Math.floor(monster.stats.def * 0.5);

      if (!db.soloDungeons) db.soloDungeons = {};
      db.soloDungeons[sender] = {
        dungeonTypeId: dtype.id,
        dungeonName: dtype.name,
        currentFloor: 1,
        maxFloors: 10,
        currentMonster: monster,
        totalXp: 0,
        totalGold: 0,
        totalCrystals: 0,
        startTime: Date.now(),
      };
      saveDatabase();

      const hpBar = BarSystem.getMonsterHPBar(monster.stats.hp, monster.stats.maxHp);
      const atmo0 = dtype.atmosphere[Math.floor(Math.random() * dtype.atmosphere.length)];
      const line0 = getDialogue(monster.name);
      return sock.sendMessage(chatId, {
        text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${dtype.emoji} *${dtype.name.toUpperCase()} — SOLO*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${atmo0}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Solo | 10 Floors | Boss at F5 & F10\n📊 Rank: ${dtype.rank} | Monsters scaled to Lv${player.level}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔽 *FLOOR 1*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${monster.emoji} *${monster.name}* [Lv.${monster.level}]\n💬 "${line0}"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${hpBar}\n❤️ ${monster.stats.hp}/${monster.stats.maxHp} HP\n⚔️ ATK: ${monster.stats.atk} | 🛡️ DEF: ${monster.stats.def}\n💥 Abilities: ${monster.abilities.join(', ')}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚔️ /dungeon attack\n⚡ /dungeon use [skill]\n🎒 /dungeon item [hp/energy]\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      }, { quoted: msg });
    }

    // ── TYPES ─────────────────────────────────────────────────
    if (sub === 'types' || sub === 'list') {
      const available = DungeonManager.getAvailableTypes(player.level);
      const all       = DungeonManager.getAllTypes();
      let txt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏰 *DUNGEON TYPES*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\nYour Level: ${player.level}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      all.forEach((d, i) => {
        const locked = d.minLevel > player.level ? `🔒 Lv${d.minLevel}+ required` : '✅ Available';
        txt += `${i+1}. ${d.emoji} *${d.name}*\n   ${locked}\n   💭 ${d.description}\n   🏆 20 Floors | Bosses F5/F10/F15/F20\n\n`;
      });
      txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Form a party first: /dungeon party create\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
    }

    // ── PARTY COMMANDS ────────────────────────────────────────
    if (sub === 'party') {
      const partyAction = args[1]?.toLowerCase();

      if (partyAction === 'create') {
        if (player.dungeonCooldown && Date.now() < player.dungeonCooldown) {
          const left = Math.ceil((player.dungeonCooldown - Date.now()) / 60000);
          return sock.sendMessage(chatId, { text: `⏰ Dungeon cooldown: *${left} minutes* remaining.\nRest up before the next run!` }, { quoted: msg });
        }
        const existing = DungeonPartyManager.getPartyByPlayer(sender);
        if (existing) return sock.sendMessage(chatId, { text: `❌ Already in party ${existing.id}!\nLeave first: /dungeon party leave` }, { quoted: msg });

        const party = DungeonPartyManager.createParty(sender, player.name);
        player.dungeonCooldown = Date.now() + 30 * 60 * 1000;
        saveDatabase();

        return sock.sendMessage(chatId, { text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎉 *PARTY CREATED!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📋 Party ID: *${party.id}*\n👑 Leader: ${player.name}\n👥 Members: 1/5\n\n📌 *NEXT STEPS:*\n1️⃣ Friends join: /dungeon party join ${party.id}\n2️⃣ Buy items: /dungeon shop\n3️⃣ All mark ready: /dungeon ready\n4️⃣ Leader picks dungeon: /dungeon start [#]\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Min 2 players required!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━` }, { quoted: msg });
      }

      if (partyAction === 'join') {
        const partyId = args[2];
        if (!partyId) return sock.sendMessage(chatId, { text: '❌ Usage: /dungeon party join [ID]' }, { quoted: msg });
        const result = DungeonPartyManager.joinParty(partyId, sender, player.name);
        if (!result.success) return sock.sendMessage(chatId, { text: `❌ ${result.message}` }, { quoted: msg });
        saveDatabase();
        const party = result.party || DungeonPartyManager.getPartyByPlayer(sender);
        return sock.sendMessage(chatId, { text: `✅ *${player.name}* joined party *${partyId}*!\n👥 Members: ${party.members.length}/5\n\nMark ready: /dungeon ready` }, { quoted: msg });
      }

      if (partyAction === 'leave') {
        const party = DungeonPartyManager.getPartyByPlayer(sender);
        if (!party) return sock.sendMessage(chatId, { text: '❌ Not in a party!' }, { quoted: msg });
        if (party.status === 'active') return sock.sendMessage(chatId, { text: '❌ Dungeon in progress!\nUse /dungeon flee to escape.' }, { quoted: msg });
        const result = DungeonPartyManager.leaveParty(party.id, sender);
        saveDatabase();
        return sock.sendMessage(chatId, { text: result.disbanded ? '🚪 Party disbanded.' : '🚪 You left the party.' }, { quoted: msg });
      }

      if (partyAction === 'info' || !partyAction) {
        const party = DungeonPartyManager.getPartyByPlayer(sender);
        if (!party) return sock.sendMessage(chatId, { text: '❌ Not in a party!' }, { quoted: msg });
        return sock.sendMessage(chatId, { text: DungeonPartyManager.formatPartyInfo(party) }, { quoted: msg });
      }

      return sock.sendMessage(chatId, { text: '❌ Usage: /dungeon party [create/join/leave/info]' }, { quoted: msg });
    }

    // ── READY ─────────────────────────────────────────────────
    if (sub === 'ready') {
      const party = DungeonPartyManager.getPartyByPlayer(sender);
      if (!party) return sock.sendMessage(chatId, { text: '❌ Join a party first!\n/dungeon party create' }, { quoted: msg });
      DungeonPartyManager.setReady(party.id, sender, true);
      saveDatabase();
      const allReady = DungeonPartyManager.allReady(party.id);
      let txt = `✅ *${player.name}* is ready!\n\n`;
      party.members.forEach(m => { txt += `  ${m.ready ? '✅' : '⏳'} ${m.name}\n`; });
      if (allReady && party.members.length >= 2) txt += `\n🎉 *ALL READY!* Leader: /dungeon start\n/dungeon types to see options`;
      else if (party.members.length < 1)         txt += `\n✅ You can start solo or invite friends!`;
      return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
    }

    // ── SHOP ─────────────────────────────────────────────────
    if (sub === 'shop') {
      const party = DungeonPartyManager.getPartyByPlayer(sender);
      if (!party) return sock.sendMessage(chatId, { text: '❌ Join a party first!' }, { quoted: msg });
      if (party.status === 'active') return sock.sendMessage(chatId, { text: '❌ Cannot shop mid-dungeon!' }, { quoted: msg });

      const shopAction = args[1]?.toLowerCase();
      if (!shopAction) {
        return sock.sendMessage(chatId, { text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛒 *DUNGEON SHOP*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\nYour Gold: ${player.gold || 0}g\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🩹 /dungeon shop hp [qty]     — 5,000g — Restore 50% HP (party)\n💙 /dungeon shop energy [qty] — 4,000g — Restore 50% Energy (party)\n🎫 /dungeon shop revive [qty] — 10,000g — Revive a fallen member\n🍀 /dungeon shop luck [qty]   — 5,000g — +25% claim luck (personal)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎒 Party inventory:\n🩹 HP Potions: ${party.sharedItems?.healthPotions || 0}\n💙 Energy Potions: ${party.sharedItems?.energyPotions || 0}\n🎫 Revive Tokens: ${party.sharedItems?.reviveTokens || 0}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━` }, { quoted: msg });
      }

      const items = {
        hp: { key:'healthPotions', cost:5000, name:'Health Potion', emoji:'🩹', shared:true },
        health: { key:'healthPotions', cost:5000, name:'Health Potion', emoji:'🩹', shared:true },
        energy: { key:'energyPotions', cost:4000, name:'Energy Potion', emoji:'💙', shared:true },
        ep:     { key:'energyPotions', cost:4000, name:'Energy Potion', emoji:'💙', shared:true },
        revive: { key:'reviveTokens', cost:10000, name:'Revive Token', emoji:'🎫', shared:true },
        luck:   { key:'luckPotion', cost:5000, name:'Luck Potion', emoji:'🍀', shared:false },
      };
      const item = items[shopAction];
      if (!item) return sock.sendMessage(chatId, { text: '❌ Invalid item! Try: hp | energy | revive | luck' }, { quoted: msg });

      const qty  = parseInt(args[2]) || 1;
      const cost = item.cost * qty;
      if ((player.gold || 0) < cost) return sock.sendMessage(chatId, { text: `❌ Not enough gold!\nNeed: ${cost.toLocaleString()}g | Have: ${(player.gold||0).toLocaleString()}g` }, { quoted: msg });

      player.gold -= cost;
      if (item.shared) {
        DungeonPartyManager.addItem(party.id, item.key, qty);
      } else {
        if (!player.inventory) player.inventory = { items: [] };
        if (!player.inventory.items) player.inventory.items = [];
        for (let i = 0; i < qty; i++) player.inventory.items.push({ name: 'Luck Potion', type: 'Consumable', rarity: 'uncommon', isLuckPotion: true });
      }
      saveDatabase();
      return sock.sendMessage(chatId, { text: `✅ *${item.name} ×${qty}* purchased!\n💰 Spent: ${cost.toLocaleString()}g\n🏦 Gold left: ${player.gold.toLocaleString()}g` }, { quoted: msg });
    }

    // ── START ─────────────────────────────────────────────────
    if (sub === 'start') {
      let party = DungeonPartyManager.getPartyByPlayer(sender);
      if (!party) return sock.sendMessage(chatId, { text: '❌ Create a party first!\n/dungeon party create' }, { quoted: msg });
      if (party.status === 'active') return sock.sendMessage(chatId, { text: '❌ Dungeon already in progress!' }, { quoted: msg });
      if (party.leader !== sender) return sock.sendMessage(chatId, { text: '❌ Only the party leader can start!' }, { quoted: msg });
      if (!DungeonPartyManager.allReady(party.id)) return sock.sendMessage(chatId, { text: '❌ Not all members ready!\nEveryone: /dungeon ready' }, { quoted: msg });
      if (party.members.length < 1) return sock.sendMessage(chatId, { text: '❌ No members in party!' }, { quoted: msg });

      const members    = party.members.map(m => db.users[m.id]).filter(u => u);
      const avgLevel   = Math.floor(members.reduce((s,m) => s + m.level, 0) / members.length);
      const available  = DungeonManager.getAvailableTypes(avgLevel);

      // Show menu if no choice given
      const choice = parseInt(args[1]);
      if (!args[1] || isNaN(choice)) {
        let txt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏰 *CHOOSE DUNGEON*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\nParty Avg Level: ${avgLevel}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        if (available.length === 0) return sock.sendMessage(chatId, { text: '❌ No dungeons available!\nAll dungeons require higher level.' }, { quoted: msg });
        available.forEach((d,i) => {
          txt += `*${i+1}.* ${d.emoji} ${d.name}\n   📊 Rank: ${d.rank} | Req. Lv${d.minLevel}+\n   💭 ${d.description}\n\n`;
        });
        txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n/dungeon start [#] to enter\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      }

      const idx = choice - 1;
      if (idx < 0 || idx >= available.length) return sock.sendMessage(chatId, { text: `❌ Invalid number! Choose 1-${available.length}` }, { quoted: msg });

      const selected = available[idx];

      // Initialize dungeon state in party
      party.status = 'active';
      party.dungeon = {
        name:            selected.name,
        rank:            selected.rank,
        typeId:          selected.id,
        currentFloor:    1,
        maxFloors:       20,
        monstersDefeated: 0,
        totalMonsters:   1,
        turn:            1,
        startTime:       Date.now(),
        floorsCleared:   [],
        awaitingAdvance: false,
        currentMonster:  DungeonManager.getFloorMonster(selected.id, 1, avgLevel),
      };
      party._avgLevel = avgLevel;

      // Apply cooldowns
      members.forEach(m => { m.dungeonCooldown = Date.now() + 30 * 60 * 1000; });
      saveDatabase();

      const monster = party.dungeon.currentMonster;
      const dtype   = selected;
      const atmo    = dtype.atmosphere[Math.floor(Math.random() * dtype.atmosphere.length)];
      const line    = getDialogue(monster.name);
      const mBar    = BarSystem.getMonsterHPBar(monster.stats.hp, monster.stats.maxHp);
      const bonuses = getPartyBonuses(members);
      const bonusTxt = formatBonusSummary(bonuses) || '';

      return sock.sendMessage(chatId, {
        text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${dtype.emoji} *${dtype.name.toUpperCase()}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${atmo}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 Rank: ${dtype.rank} | 20 Floors\n👥 Party: ${party.members.length} hunters${bonusTxt ? '\n'+bonusTxt : ''}\n⚠️ Boss floors: F5, F10, F15, F20\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔽 *FLOOR 1*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${monster.emoji} *${monster.name}* [Lv.${monster.level}]\n💬 "${line}"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${mBar}\n⚔️ ATK: ${monster.stats.atk} | 🛡️ DEF: ${monster.stats.def}\n💥 Abilities: ${monster.abilities.join(', ')}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚔️ /dungeon attack\n⚡ /dungeon use [skill]\n🎒 /dungeon item [hp/energy]\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      }, { quoted: msg });
    }

    // ── STATUS ────────────────────────────────────────────────
    if (sub === 'status') {
      const party = DungeonPartyManager.getPartyByPlayer(sender);
      if (!party || party.status !== 'active') return sock.sendMessage(chatId, { text: '❌ Not in an active dungeon!' }, { quoted: msg });
      const dungeon = party.dungeon;
      const monster = dungeon.currentMonster;
      const mBar    = BarSystem.getMonsterHPBar(monster.stats.hp, monster.stats.maxHp);
      let txt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *FLOOR ${dungeon.currentFloor}/${dungeon.maxFloors}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      txt += `${DungeonManager.isBossFloor(dungeon.currentFloor) ? '⚠️ BOSS FLOOR!' : `🔽 Floor ${dungeon.currentFloor}`}\n`;
      txt += `${monster.emoji} *${monster.name}*\n${mBar}\n❤️ ${monster.stats.hp}/${monster.stats.maxHp}\n\n`;
      txt += `👥 *Party:*\n`;
      party.members.forEach(m => {
        const mp  = db.users[m.id];
        if (!mp) return;
        const bar = BarSystem.getHPBar(mp.stats.hp, mp.stats.maxHp);
        txt += `${mp.stats.hp > 0 ? '⚔️' : '💀'} *${m.name}* — ${bar} ${mp.stats.hp}/${mp.stats.maxHp}\n`;
      });
      txt += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
    }

    // ── ADVANCE ───────────────────────────────────────────────
    if (sub === 'advance') {
      // ── SOLO ADVANCE ──────────────────────────────────────
      if (db.soloDungeons && db.soloDungeons[sender]) {
        const sd = db.soloDungeons[sender];
        if (!sd.awaitingAdvance) {
          return sock.sendMessage(chatId, { text: '❌ Defeat the current enemy first!' }, { quoted: msg });
        }
        const nextFloor = sd.currentFloor + 1;
        if (nextFloor > sd.maxFloors) {
          // Complete
          player.xp = (player.xp || 0) + sd.totalXp;
          player.gold = (player.gold || 0) + sd.totalGold;
          player.manaCrystals = (player.manaCrystals || 0) + sd.totalCrystals;
          try { require('../../rpg/utils/BattlePass').addPassXP(player, 'dungeon_clear'); } catch(e) {}
          delete db.soloDungeons[sender];
          saveDatabase();
          LevelUpManager.checkAndApplyLevelUps(player, saveDatabase, sock, chatId);
          return sock.sendMessage(chatId, {
            text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏆 *SOLO DUNGEON COMPLETE!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ All 10 floors cleared!\n\n📊 *TOTAL REWARDS:*\n✨ XP: +${sd.totalXp.toLocaleString()}\n💰 Gold: +${sd.totalGold.toLocaleString()}\n💎 Crystals: +${sd.totalCrystals}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💪 Well done, solo hunter!`
          }, { quoted: msg });
        }

        const isBoss = nextFloor % 5 === 0;
        const monster = isBoss
          ? DungeonManager.getFloorBoss(sd.dungeonTypeId, nextFloor, player.level)
          : DungeonManager.getFloorMonster(sd.dungeonTypeId, nextFloor, player.level);

        // Scale down for solo
        monster.stats.hp = Math.floor(monster.stats.hp * 0.5);
        monster.stats.maxHp = monster.stats.hp;
        monster.stats.atk = Math.floor(monster.stats.atk * 0.5);
        monster.stats.def = Math.floor(monster.stats.def * 0.5);

        sd.currentFloor = nextFloor;
        sd.currentMonster = monster;
        sd.awaitingAdvance = false;
        saveDatabase();

        const dtype2 = DungeonManager.getDungeonType(sd.dungeonTypeId);
        const atmo2  = dtype2?.atmosphere[Math.floor(Math.random() * (dtype2.atmosphere.length || 1))] || '💭 You press deeper...';
        const line2  = getDialogue(monster.name);
        const mBar = BarSystem.getMonsterHPBar(monster.stats.hp, monster.stats.maxHp);
        let txt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        if (isBoss) {
          txt += `⚠️ *BOSS — FLOOR ${nextFloor}!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💭 ${monster.desc || 'A terrifying guardian blocks your path!'}\n`;
        } else {
          txt += `🔽 *FLOOR ${nextFloor}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${atmo2}\n`;
        }
        txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${monster.emoji} *${monster.name}* [Lv.${monster.level}]${isBoss ? ' 🔴 BOSS' : ''}\n💬 "${line2}"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${mBar}\n❤️ ${monster.stats.hp}/${monster.stats.maxHp} HP\n⚔️ ATK: ${monster.stats.atk} | 🛡️ DEF: ${monster.stats.def}\n💥 Abilities: ${monster.abilities.join(', ')}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚔️ /dungeon attack\n⚡ /dungeon use [skill]\n🎒 /dungeon item [hp/energy]\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      }

      // ── PARTY ADVANCE ─────────────────────────────────────
      const party = DungeonPartyManager.getPartyByPlayer(sender);
      if (!party || party.status !== 'active') return sock.sendMessage(chatId, { text: '❌ Not in an active dungeon!' }, { quoted: msg });
      if (party.leader !== sender) return sock.sendMessage(chatId, { text: '❌ Only the party leader can advance!' }, { quoted: msg });
      const dungeon = party.dungeon;
      if (!dungeon.awaitingAdvance) return sock.sendMessage(chatId, { text: '❌ Defeat the current enemy first!' }, { quoted: msg });

      const nextFloor = dungeon.currentFloor + 1;
      if (nextFloor > dungeon.maxFloors) {
        return handleDungeonComplete(sock, chatId, party, db, saveDatabase, msg);
      }

      const members  = party.members.map(m => db.users[m.id]).filter(u => u);
      const avgLevel = party._avgLevel || Math.floor(members.reduce((s,m) => s + m.level, 0) / members.length);
      const isBoss   = DungeonManager.isBossFloor(nextFloor);
      const monster  = isBoss
        ? DungeonManager.getFloorBoss(dungeon.typeId, nextFloor, avgLevel)
        : DungeonManager.getFloorMonster(dungeon.typeId, nextFloor, avgLevel);

      dungeon.currentFloor    = nextFloor;
      dungeon.currentMonster  = monster;
      dungeon.awaitingAdvance = false;
      dungeon.turn            = 1;
      saveDatabase();

      const dtype = DungeonManager.getDungeonType(dungeon.typeId);
      const atmo  = dtype?.atmosphere[Math.floor(Math.random() * (dtype.atmosphere.length||1))] || '💭 You press deeper...';
      const line  = getDialogue(monster.name);
      const mBar  = BarSystem.getMonsterHPBar(monster.stats.hp, monster.stats.maxHp);

      let txt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      if (isBoss) {
        txt += `⚠️ *BOSS FLOOR ${nextFloor}!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💭 ${monster.desc || 'A terrifying guardian blocks your path!'}\n`;
      } else {
        txt += `🔽 *FLOOR ${nextFloor}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${atmo}\n`;
      }
      txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${monster.emoji} *${monster.name}* [Lv.${monster.level}]${isBoss ? ' 🔴 BOSS' : ''}\n💬 "${line}"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${mBar}\n⚔️ ATK: ${monster.stats.atk} | 🛡️ DEF: ${monster.stats.def}\n💥 Abilities: ${monster.abilities.join(', ')}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
    }

    // ── LEAVE (voluntary exit) ────────────────────────────────
    if (sub === 'leave') {
      // Solo leave
      if (db.soloDungeons && db.soloDungeons[sender]) {
        const sd = db.soloDungeons[sender];
        player.xp = (player.xp || 0) + sd.totalXp;
        player.gold = (player.gold || 0) + sd.totalGold;
        player.manaCrystals = (player.manaCrystals || 0) + sd.totalCrystals;
        delete db.soloDungeons[sender];
        saveDatabase();
        LevelUpManager.checkAndApplyLevelUps(player, saveDatabase, sock, chatId);
        return sock.sendMessage(chatId, {
          text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🚪 *EXITED SOLO DUNGEON*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\nCleared ${sd.currentFloor - 1} floor(s)\n\n📦 *REWARDS KEPT:*\n✨ XP: +${sd.totalXp.toLocaleString()}\n💰 Gold: +${sd.totalGold.toLocaleString()}\n💎 Crystals: +${sd.totalCrystals}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`
        }, { quoted: msg });
      }
      const party = DungeonPartyManager.getPartyByPlayer(sender);
      if (!party || party.status !== 'active') return sock.sendMessage(chatId, { text: '❌ Not in an active dungeon!' }, { quoted: msg });
      if (!party.dungeon.awaitingAdvance && party.leader === sender) {
        return sock.sendMessage(chatId, { text: '⚠️ You can only leave after clearing a floor!\nDefeat the current enemy first.\n\nWant to flee mid-fight? Use /dungeon flee' }, { quoted: msg });
      }
      return handleDungeonExit(sock, chatId, party, db, saveDatabase, msg, sender, false);
    }

    // ── FLEE ──────────────────────────────────────────────────
    if (sub === 'flee') {
      // Solo flee — lose all rewards
      if (db.soloDungeons && db.soloDungeons[sender]) {
        delete db.soloDungeons[sender];
        saveDatabase();
        return sock.sendMessage(chatId, { text: '🏃 *You fled the dungeon!*\n❌ All rewards lost.\n\nUse /dungeon solo to try again.' }, { quoted: msg });
      }
      const party = DungeonPartyManager.getPartyByPlayer(sender);
      if (!party || party.status !== 'active') return sock.sendMessage(chatId, { text: '❌ Not in an active dungeon!' }, { quoted: msg });
      if (party.members.length === 1) return sock.sendMessage(chatId, { text: '⛓️ *You cannot flee!*\nYou are the last one standing!\nFight or fall!' }, { quoted: msg });
      return handleDungeonExit(sock, chatId, party, db, saveDatabase, msg, sender, true);
    }

    // ── ATTACK ────────────────────────────────────────────────
    if (sub === 'attack') {
      // ── SOLO ATTACK ───────────────────────────────────────
      if (db.soloDungeons && db.soloDungeons[sender]) {
        const sd = db.soloDungeons[sender];
        const monster = sd.currentMonster;

        if (sd.awaitingAdvance) {
          return sock.sendMessage(chatId, { text: '✅ Floor cleared!\n/dungeon advance — next floor\n/dungeon leave — exit with rewards' }, { quoted: msg });
        }

        // Status effects
        const fx = StatusEffectManager.processTurnEffects(player);
        let log = '';
        if (fx.messages.length) log += fx.messages.join('\n') + '\n\n';
        if (!fx.canAct) {
          log += `❌ *${player.name}* cannot act this turn!`;
          return sock.sendMessage(chatId, { text: log }, { quoted: msg });
        }

        // Player attacks monster — full bonus calculation like party
        const artBSolo = ArtifactSystem.calculateCombatBonusFromPlayer?.(player);
        const artAtkSolo = artBSolo?.bonuses?.atk || 0;
        const weapAtkSolo = player.weapon?.bonus || player.weapon?.attack || 0;
        PetManager.updateHunger(sender);
        const petBSolo = PetManager.getPetBattleBonus(sender);
        const petAtkSolo = petBSolo?.bonuses?.atk || 0;
        const modsSolo = StatusEffectManager.getStatModifiers(player);
        let consAtkSolo = 0;
        try { const CS=require('../../rpg/utils/ConstellationSystem'); consAtkSolo=CS.getSponsorBonus(player).atk||0; } catch(e) {}
        const effAtkSolo = Math.floor((player.stats.atk + weapAtkSolo + artAtkSolo + petAtkSolo + consAtkSolo) * modsSolo.atkMod);
        const isCritSolo = Math.random() < ((player.stats.critChance || 10) / 100);
        const critMSolo  = 1.5 + (player.statAllocations?.critDamage || 0) * 0.01;
        const playerDmg  = Math.max(1, Math.floor(effAtkSolo * (isCritSolo ? critMSolo : 1.0)) - Math.floor(monster.stats.def * 0.4));

        // Lifesteal
        const lsPctSolo = (player.statAllocations?.lifesteal || 0) * 0.5 / 100;
        if (lsPctSolo > 0) {
          const healLS = Math.floor(playerDmg * lsPctSolo);
          if (healLS > 0) { player.stats.hp = Math.min(player.stats.maxHp, player.stats.hp + healLS); log += `💚 Lifesteal: +${healLS} HP\n`; }
        }

        monster.stats.hp = Math.max(0, monster.stats.hp - playerDmg);

        log += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚔️ *${player.name}* attacks *${monster.name}*!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        if (isCritSolo) log += `💥 *CRITICAL HIT!*\n`;
        if (artAtkSolo > 0) log += `✨ Artifact: +${artAtkSolo} ATK!\n`;
        if (petAtkSolo > 0) log += `🐾 Pet: +${petAtkSolo} ATK!\n`;
        log += `💥 Dealt *${playerDmg}* damage!\n`;

        if (monster.stats.hp <= 0) {
          // Monster defeated
          const isBossSolo = sd.currentFloor % 5 === 0;
          const rewards = DungeonManager.getFloorRewards(sd.currentFloor, player.level, isBossSolo);
          const xpGain      = Math.floor(rewards.xp);
          const goldGain    = Math.floor(rewards.gold);
          const crystalGain = Math.floor(rewards.crystals || 0);

          sd.totalXp      += xpGain;
          sd.totalGold    += goldGain;
          sd.totalCrystals += crystalGain;

          log += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
          log += `💀 *${monster.name}* has been defeated!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
          log += `✨ +${xpGain} XP | 💰 +${goldGain} Gold | 💎 +${crystalGain} Crystals\n`;
          if (isBossSolo) {
            log += `\n👹 *BOSS DEFEATED!* You earned bonus rewards!`;
            // 25% egg drop on solo boss floors
            if (Math.random() < 0.25) {
              try {
                const { rollEggType } = require('../../rpg/utils/PetDatabase');
                const PetManager = require('../../rpg/utils/PetManager');
                const r = PetManager.giveEgg(sender, rollEggType());
                if (r.success) log += `\n🥚 *${r.egg.name}* found in the boss chamber!`;
              } catch(e) {}
            }
          }

          if (sd.currentFloor >= sd.maxFloors) {
            // Apply buff multipliers
          if (BuffManager) {
            sd.totalXp   = Math.floor(sd.totalXp   * (BuffManager.getXpMultiplier(player)   || 1));
            sd.totalGold = Math.floor(sd.totalGold * (BuffManager.getGoldMultiplier(player) || 1));
          }
          player.xp           = (player.xp           || 0) + sd.totalXp;
            player.gold         = (player.gold          || 0) + sd.totalGold;
            try { const BP2=require('../../rpg/utils/BattlePass'); BP2.addPassXP(player,'dungeon_clear'); } catch(e) {}
            player.manaCrystals = (player.manaCrystals  || 0) + sd.totalCrystals;
            delete db.soloDungeons[sender];
            saveDatabase();
            return sock.sendMessage(chatId, {
              text: `${log}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏆 *SOLO DUNGEON COMPLETE!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ All 10 floors cleared!\n\n📊 *TOTAL REWARDS:*\n✨ XP: +${sd.totalXp.toLocaleString()}\n💰 Gold: +${sd.totalGold.toLocaleString()}\n💎 Crystals: +${sd.totalCrystals}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💪 Well done, solo hunter!`
            }, { quoted: msg });
          }

          sd.awaitingAdvance = true;
          saveDatabase();
          log += `\n\n🏆 Floor ${sd.currentFloor} cleared!\n/dungeon advance — Floor ${sd.currentFloor + 1}\n/dungeon leave — Exit with rewards`;
          return sock.sendMessage(chatId, { text: log }, { quoted: msg });
        }

        // Monster counterattacks using full AI (abilities + dialogue)
        log += executeMonsterAI(monster, player);

        // Monster status effects tick
        const mfxSolo = StatusEffectManager.processTurnEffects(monster);
        if (mfxSolo.messages.length) log += '\n' + mfxSolo.messages.join('\n') + '\n';

        const mHpBar = BarSystem.getMonsterHPBar(monster.stats.hp, monster.stats.maxHp);
        const pHpBar = BarSystem.getHPBar(player.stats.hp, player.stats.maxHp);

        if (player.stats.hp <= 0) {
          // Player died — give partial rewards
          player.stats.hp = 1;
          player.xp   = (player.xp   || 0) + Math.floor(sd.totalXp  * 0.5);
          player.gold = (player.gold  || 0) + Math.floor(sd.totalGold * 0.5);
          delete db.soloDungeons[sender];
          saveDatabase();
          return sock.sendMessage(chatId, {
            text: `${log}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💀 *DEFEATED on Floor ${sd.currentFloor}!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📦 Kept 50% of earned rewards.\n✨ XP: +${Math.floor(sd.totalXp * 0.5)} | 💰 Gold: +${Math.floor(sd.totalGold * 0.5)}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏥 Use /heal to recover.`
          }, { quoted: msg });
        }

        if (!sd.turn) sd.turn = 1;
        sd.turn++;
        saveDatabase();

        log += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        log += `${monster.emoji} *${monster.name}*\n${mHpBar}\n❤️ ${monster.stats.hp}/${monster.stats.maxHp}\n\n`;
        log += `👤 *${player.name}*\n${pHpBar}\n❤️ ${player.stats.hp}/${player.stats.maxHp}\n`;
        log += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎯 Floor ${sd.currentFloor}/10 | Turn ${sd.turn}`;
        return sock.sendMessage(chatId, { text: log }, { quoted: msg });
      }

      // ── PARTY ATTACK ──────────────────────────────────────
      const party = DungeonPartyManager.getPartyByPlayer(sender);
      if (!party || party.status !== 'active') return sock.sendMessage(chatId, { text: '❌ No active dungeon!' }, { quoted: msg });
      if (party.dungeon.awaitingAdvance) return sock.sendMessage(chatId, { text: '✅ Floor cleared! Use /dungeon advance to go deeper, or /dungeon leave to exit.' }, { quoted: msg });

      const dungeon = party.dungeon;
      const monster = dungeon.currentMonster;

      // Status effects
      const fx = StatusEffectManager.processTurnEffects(player);
      let log = '';
      if (fx.messages.length) log += fx.messages.join('\n') + '\n\n';
      if (!fx.canAct) { log += `❌ ${player.name} cannot act this turn!`; return sock.sendMessage(chatId, { text: log }, { quoted: msg }); }

      // Damage calc
      const artB  = ArtifactSystem.calculateCombatBonusFromPlayer?.(player);
      const artAtk = artB?.bonuses?.atk || 0;
      const weapAtk = player.weapon?.bonus || player.weapon?.attack || 0;
      PetManager.updateHunger(sender);
      const petB   = PetManager.getPetBattleBonus(sender);
      const petAtk = petB?.bonuses?.atk || 0;
      const mods   = StatusEffectManager.getStatModifiers(player);
      let consAtkDungeon = 0;
      try { const CS=require('../../rpg/utils/ConstellationSystem'); consAtkDungeon=CS.getSponsorBonus(player).atk||0; } catch(e) {}
      const effAtk = Math.floor((player.stats.atk + weapAtk + artAtk + petAtk + consAtkDungeon) * mods.atkMod);
      const isCrit  = Math.random() < (0.10 + (player.statAllocations?.critChance || 0) * 0.005);
      const critM   = 1.5 + (player.statAllocations?.critDamage || 0) * 0.01;
      let dmg       = Math.max(1, Math.floor(effAtk * (isCrit ? critM : 1.0)) - Math.floor(monster.stats.def * 0.4));

      // Lifesteal
      const lsPct = (player.statAllocations?.lifesteal || 0) * 0.5 / 100;
      if (lsPct > 0) {
        const heal = Math.floor(dmg * lsPct);
        if (heal > 0) { player.stats.hp = Math.min(player.stats.maxHp, player.stats.hp + heal); log += `💚 Lifesteal: +${heal} HP\n`; }
      }

      monster.stats.hp -= dmg;
      dungeon.turn++;

      log += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚔️ *${player.name}* attacks!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      if (isCrit) log += `💥 *CRITICAL HIT!*\n`;
      if (artAtk > 0) log += `✨ Artifact: +${artAtk} ATK!\n`;
      if (petAtk > 0) log += `🐾 Pet: +${petAtk} ATK!\n`;
      log += `💥 Dealt *${dmg}* damage!\n`;

      if (monster.stats.hp <= 0) {
        return handleMonsterDefeat(sock, chatId, party, monster, dungeon, db, saveDatabase, msg, sender, log);
      }

      log += executeMonsterAI(monster, player);

      const mfx = StatusEffectManager.processTurnEffects(monster);
      if (mfx.messages.length) log += '\n' + mfx.messages.join('\n') + '\n';

      if (player.stats.hp <= 0) {
        return handlePlayerDeath(sock, chatId, party, dungeon, db, saveDatabase, msg, sender, log);
      }

      saveDatabase();
      log += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      log += `👤 *${player.name}* ❤️ ${player.stats.hp}/${player.stats.maxHp}\n${BarSystem.getHPBar(player.stats.hp, player.stats.maxHp)}\n`;
      log += `\n${monster.emoji} *${monster.name}*\n${BarSystem.getMonsterHPBar(monster.stats.hp, monster.stats.maxHp)}\n`;
      log += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎯 Floor ${dungeon.currentFloor}/20 | Turn ${dungeon.turn}`;
      return sock.sendMessage(chatId, { text: log }, { quoted: msg });
    }

    // ── USE SKILL ─────────────────────────────────────────────
    if (sub === 'use') {
      // ── SOLO SKILL ────────────────────────────────────────
      if (db.soloDungeons && db.soloDungeons[sender]) {
        const sd = db.soloDungeons[sender];
        if (sd.awaitingAdvance) return sock.sendMessage(chatId, { text: '✅ Floor cleared! /dungeon advance or /dungeon leave' }, { quoted: msg });

        const skillName = args.slice(1).join(' ').toLowerCase();
        if (!skillName) return sock.sendMessage(chatId, { text: '❌ Usage: /dungeon use [skill name]' }, { quoted: msg });

        const monster = sd.currentMonster;
        const fx = StatusEffectManager.processTurnEffects(player);
        let log = '';
        if (fx.messages.length) log += fx.messages.join('\n') + '\n\n';
        if (!fx.canAct) { log += `❌ ${player.name} cannot act!`; return sock.sendMessage(chatId, { text: log }, { quoted: msg }); }

        const className = typeof player.class === 'string' ? player.class : player.class?.name || 'Warrior';
        // Build player entity with artifact bonuses applied
        const _artStats = ArtifactSystem?.getEquippedArtifactStats ? ArtifactSystem.getEquippedArtifactStats(player) : {};
        const _atkBoost = BuffManager?.getAtkBoost ? BuffManager.getAtkBoost(player) : 0;
        const pStats = { ...player.stats,
          atk: (player.stats.atk || 0) + (_artStats.atk || 0) + _atkBoost,
          def: (player.stats.def || 0) + (_artStats.def || 0),
          critChance: (player.stats.critChance || 0) + (_artStats.critChance || 0)
        };
        const pEnt = { name: player.name, stats: pStats, skills: player.skills, class: { name: className }, energyType: player.energyType || 'Energy', statusEffects: player.statusEffects || [], weapon: player.weapon };
        const mEnt = { name: monster.name, stats: monster.stats, skills: {}, abilities: monster.abilities || [], statusEffects: monster.statusEffects || [] };

        const result = ImprovedCombat.executeSkill(pEnt, mEnt, skillName);
        if (!result.success) return sock.sendMessage(chatId, { text: `❌ ${result.message}` }, { quoted: msg });

        player.stats.hp      = pEnt.stats.hp;
        player.stats.energy  = pEnt.stats.energy;
        player.statusEffects = pEnt.statusEffects;
        monster.stats        = mEnt.stats;
        monster.statusEffects = mEnt.statusEffects;
        if (!sd.turn) sd.turn = 1;
        sd.turn++;

        log += result.message + '\n\n';

        if (monster.stats.hp <= 0) {
          const isBossSk = sd.currentFloor % 5 === 0;
          const rewards  = DungeonManager.getFloorRewards(sd.currentFloor, player.level, isBossSk);
          const xpGain   = Math.floor(rewards.xp);
          const goldGain = Math.floor(rewards.gold);
          const crysGain = Math.floor(rewards.crystals || 0);
          sd.totalXp += xpGain; sd.totalGold += goldGain; sd.totalCrystals += crysGain;

          log += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💀 *${monster.name}* has been defeated!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
          log += `✨ +${xpGain} XP | 💰 +${goldGain} Gold | 💎 +${crysGain} Crystals\n`;
          log += `💰 *Total earned this run: ${sd.totalGold.toLocaleString()}g*\n`;
          if (isBossSk) log += `\n👹 *BOSS DEFEATED!* Bonus rewards earned!`;

          if (sd.currentFloor >= sd.maxFloors) {
            // Apply buff multipliers
          if (BuffManager) {
            sd.totalXp   = Math.floor(sd.totalXp   * (BuffManager.getXpMultiplier(player)   || 1));
            sd.totalGold = Math.floor(sd.totalGold * (BuffManager.getGoldMultiplier(player) || 1));
          }
          player.xp           = (player.xp           || 0) + sd.totalXp;
            player.gold         = (player.gold          || 0) + sd.totalGold;
            player.manaCrystals = (player.manaCrystals  || 0) + sd.totalCrystals;
            delete db.soloDungeons[sender];
            saveDatabase();
            return sock.sendMessage(chatId, {
              text: `${log}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏆 *SOLO DUNGEON COMPLETE!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ All 10 floors cleared!\n\n📊 *TOTAL REWARDS:*\n✨ XP: +${sd.totalXp.toLocaleString()}\n💰 Gold: +${sd.totalGold.toLocaleString()}\n💎 Crystals: +${sd.totalCrystals}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💪 Well done, solo hunter!`
            }, { quoted: msg });
          }

          sd.awaitingAdvance = true;
          saveDatabase();
          log += `\n\n🏆 Floor ${sd.currentFloor} cleared!\n/dungeon advance — Floor ${sd.currentFloor + 1}\n/dungeon leave — Exit with rewards`;
          return sock.sendMessage(chatId, { text: log }, { quoted: msg });
        }

        log += executeMonsterAI(monster, player);
        const mfxSk = StatusEffectManager.processTurnEffects(monster);
        if (mfxSk.messages.length) log += '\n' + mfxSk.messages.join('\n') + '\n';

        if (player.stats.hp <= 0) {
          player.stats.hp = 1;
          player.xp   = (player.xp   || 0) + Math.floor(sd.totalXp  * 0.5);
          player.gold = (player.gold  || 0) + Math.floor(sd.totalGold * 0.5);
          delete db.soloDungeons[sender];
          saveDatabase();
          return sock.sendMessage(chatId, {
            text: `${log}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💀 *DEFEATED on Floor ${sd.currentFloor}!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📦 Kept 50% of earned rewards.\n✨ XP: +${Math.floor(sd.totalXp * 0.5)} | 💰 Gold: +${Math.floor(sd.totalGold * 0.5)}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏥 Use /heal to recover.`
          }, { quoted: msg });
        }

        saveDatabase();
        log += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${monster.emoji} *${monster.name}*\n${BarSystem.getMonsterHPBar(monster.stats.hp, monster.stats.maxHp)}\n❤️ ${monster.stats.hp}/${monster.stats.maxHp}\n\n👤 *${player.name}*\n${BarSystem.getHPBar(player.stats.hp, player.stats.maxHp)}\n❤️ ${player.stats.hp}/${player.stats.maxHp}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎯 Floor ${sd.currentFloor}/10 | Turn ${sd.turn}`;
        return sock.sendMessage(chatId, { text: log }, { quoted: msg });
      }

      // ── PARTY SKILL ───────────────────────────────────────
      const party = DungeonPartyManager.getPartyByPlayer(sender);
      if (!party || party.status !== 'active') return sock.sendMessage(chatId, { text: '❌ No active dungeon!' }, { quoted: msg });
      if (party.dungeon.awaitingAdvance) return sock.sendMessage(chatId, { text: '✅ Floor cleared! /dungeon advance or /dungeon leave' }, { quoted: msg });

      const skillName = args.slice(1).join(' ').toLowerCase();
      if (!skillName) return sock.sendMessage(chatId, { text: '❌ Usage: /dungeon use [skill name]' }, { quoted: msg });

      const dungeon = party.dungeon;
      const monster = dungeon.currentMonster;
      const fx      = StatusEffectManager.processTurnEffects(player);
      let log = '';
      if (fx.messages.length) log += fx.messages.join('\n') + '\n\n';
      if (!fx.canAct) { log += `❌ ${player.name} cannot act!`; return sock.sendMessage(chatId, { text: log }, { quoted: msg }); }

      const className = typeof player.class === 'string' ? player.class : player.class?.name || 'Warrior';
      const pEnt = { name: player.name, stats: player.stats, skills: player.skills, class: { name: className }, energyType: player.energyType || 'Energy', statusEffects: player.statusEffects || [] };
      const mEnt = { name: monster.name, stats: monster.stats, skills: {}, abilities: monster.abilities || [], statusEffects: monster.statusEffects || [] };

      const result = ImprovedCombat.executeSkill(pEnt, mEnt, skillName);
      if (!result.success) return sock.sendMessage(chatId, { text: `❌ ${result.message}` }, { quoted: msg });

      player.stats.hp     = pEnt.stats.hp;
      player.stats.energy = pEnt.stats.energy;
      player.statusEffects = pEnt.statusEffects;
      monster.stats       = mEnt.stats;
      monster.statusEffects = mEnt.statusEffects;
      dungeon.turn++;

      log += result.message + '\n\n';

      if (monster.stats.hp <= 0) {
        return handleMonsterDefeat(sock, chatId, party, monster, dungeon, db, saveDatabase, msg, sender, log);
      }

      log += executeMonsterAI(monster, player);
      if (player.stats.hp <= 0) return handlePlayerDeath(sock, chatId, party, dungeon, db, saveDatabase, msg, sender, log);

      saveDatabase();
      log += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 *${player.name}* ❤️ ${player.stats.hp}/${player.stats.maxHp}\n${BarSystem.getHPBar(player.stats.hp, player.stats.maxHp)}\n\n${monster.emoji} *${monster.name}*\n${BarSystem.getMonsterHPBar(monster.stats.hp, monster.stats.maxHp)}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎯 Floor ${dungeon.currentFloor}/20`;
      return sock.sendMessage(chatId, { text: log }, { quoted: msg });
    }

    // ── ITEM ──────────────────────────────────────────────────
    if (sub === 'item') {
      // ── SOLO ITEM ─────────────────────────────────────────
      if (db.soloDungeons && db.soloDungeons[sender]) {
        const itemType = args[1]?.toLowerCase();
        if (itemType === 'hp' || itemType === 'health') {
          const potions = player.inventory?.healthPotions || 0;
          if (potions <= 0) return sock.sendMessage(chatId, { text: '❌ No Health Potions!\nBuy some: /shop buy 1 5' }, { quoted: msg });
          player.inventory.healthPotions--;
          const heal = Math.floor(player.stats.maxHp * 0.5);
          player.stats.hp = Math.min(player.stats.maxHp, player.stats.hp + heal);
          saveDatabase();
          return sock.sendMessage(chatId, { text: `🩹 Healed *+${heal} HP*!\n❤️ ${player.stats.hp}/${player.stats.maxHp}\n🩹 Potions left: ${player.inventory.healthPotions}` }, { quoted: msg });
        }
        if (itemType === 'ep' || itemType === 'energy') {
          const potions = player.inventory?.energyPotions || player.inventory?.manaPotions || 0;
          if (potions <= 0) return sock.sendMessage(chatId, { text: '❌ No Energy Potions!\nBuy some: /shop buy 2 5' }, { quoted: msg });
          if (player.inventory.energyPotions !== undefined) player.inventory.energyPotions--;
          else player.inventory.manaPotions--;
          const restore = Math.floor(player.stats.maxEnergy * 0.5);
          player.stats.energy = Math.min(player.stats.maxEnergy, (player.stats.energy || 0) + restore);
          saveDatabase();
          return sock.sendMessage(chatId, { text: `💙 Restored *+${restore} Energy*!\n💙 ${player.stats.energy}/${player.stats.maxEnergy}` }, { quoted: msg });
        }
        return sock.sendMessage(chatId, { text: '❌ Usage: /dungeon item hp OR /dungeon item energy' }, { quoted: msg });
      }

      // ── PARTY ITEM ────────────────────────────────────────
      const party = DungeonPartyManager.getPartyByPlayer(sender);
      if (!party || party.status !== 'active') return sock.sendMessage(chatId, { text: '❌ No active dungeon!' }, { quoted: msg });

      const itemType = args[1]?.toLowerCase();
      if (itemType === 'hp' || itemType === 'health') {
        if (player.stats.hp <= 0) return sock.sendMessage(chatId, { text: '❌ You are dead! Use /dungeon item revive first.' }, { quoted: msg });
        const used = party.sharedItems?.healthPotionsUsed || 0;
        if (used >= 5) return sock.sendMessage(chatId, { text: `❌ Max 5 HP potions per dungeon! (Used: ${used}/5)` }, { quoted: msg });
        if (!DungeonPartyManager.useItem(party.id, 'healthPotions', 1)) return sock.sendMessage(chatId, { text: '❌ No HP Potions in party inventory!' }, { quoted: msg });
        if (!party.sharedItems.healthPotionsUsed) party.sharedItems.healthPotionsUsed = 0;
        party.sharedItems.healthPotionsUsed++;
        const heal = Math.floor(player.stats.maxHp * 0.5);
        player.stats.hp = Math.min(player.stats.maxHp, player.stats.hp + heal);
        saveDatabase();
        return sock.sendMessage(chatId, { text: `🩹 *${player.name}* healed *+${heal} HP*!\n❤️ ${player.stats.hp}/${player.stats.maxHp}\n🩹 Potions used: ${party.sharedItems.healthPotionsUsed}/5` }, { quoted: msg });
      }
      if (itemType === 'ep' || itemType === 'energy') {
        if (player.stats.hp <= 0) return sock.sendMessage(chatId, { text: '❌ You are dead! Use /dungeon item revive first.' }, { quoted: msg });
        if (!DungeonPartyManager.useItem(party.id, 'energyPotions', 1)) return sock.sendMessage(chatId, { text: '❌ No Energy Potions in party inventory!' }, { quoted: msg });
        const rest = Math.floor(player.stats.maxEnergy * 0.5);
        player.stats.energy = Math.min(player.stats.maxEnergy, player.stats.energy + rest);
        saveDatabase();
        return sock.sendMessage(chatId, { text: `💙 *${player.name}* restored *+${rest} Energy*!\n💙 ${player.stats.energy}/${player.stats.maxEnergy}` }, { quoted: msg });
      }
      if (itemType === 'revive') {
        if (player.stats.hp > 0) return sock.sendMessage(chatId, { text: '❌ You are not dead!' }, { quoted: msg });
        const rUsed = party.sharedItems?.reviveTokensUsed || 0;
        if (rUsed >= 1) return sock.sendMessage(chatId, { text: '❌ Only 1 revive token allowed per dungeon!' }, { quoted: msg });
        if (!DungeonPartyManager.useItem(party.id, 'reviveTokens', 1)) return sock.sendMessage(chatId, { text: '❌ No Revive Tokens in party inventory!' }, { quoted: msg });
        if (!party.sharedItems.reviveTokensUsed) party.sharedItems.reviveTokensUsed = 0;
        party.sharedItems.reviveTokensUsed++;
        player.stats.hp     = Math.floor(player.stats.maxHp * 0.3);
        player.stats.energy = Math.floor(player.stats.maxEnergy * 0.3);
        saveDatabase();
        return sock.sendMessage(chatId, { text: `🎫 *${player.name}* has been REVIVED!\n❤️ ${player.stats.hp}/${player.stats.maxHp}` }, { quoted: msg });
      }
      return sock.sendMessage(chatId, { text: '❌ Usage: /dungeon item [hp/energy/revive]' }, { quoted: msg });
    }

    // Default
    return sock.sendMessage(chatId, { text: '❌ Unknown command! /dungeon help' }, { quoted: msg });
  }
};

// ═══════════════════════════════════════════════════════════════
// MONSTER DEFEAT
// ═══════════════════════════════════════════════════════════════
async function handleMonsterDefeat(sock, chatId, party, monster, dungeon, db, saveDatabase, msg, killerId, prefixLog) {
  const members  = party.members.map(m => db.users[m.id]).filter(u => u);
  const avgLevel = party._avgLevel || Math.floor(members.reduce((s,m) => s + m.level, 0) / members.length);
  const isBoss   = dungeon.currentMonster.isBoss || dungeon.currentMonster.isFinalBoss;
  let rewards    = DungeonManager.getFloorRewards(dungeon.currentFloor, avgLevel, isBoss);
  // Apply seasonal event bonuses
  rewards = SeasonManager.applyBonuses(rewards);
  const eventActive = SeasonManager.getActiveEvent();

  let log = prefixLog || '';

  // Award rewards to all
  members.forEach(member => {
    member.xp           = (member.xp           || 0) + rewards.xp;
    member.gold         = (member.gold          || 0) + rewards.gold;
    member.manaCrystals = (member.manaCrystals  || 0) + rewards.crystals;
    if (rewards.upgradePoints) member.upgradePoints = (member.upgradePoints || 0) + rewards.upgradePoints;
    if (!member.inventory) member.inventory = {};
    member.inventory.gold = member.gold;
    LevelUpManager.checkAndApplyLevelUps(member, saveDatabase, sock, chatId);
  });

  // Boss loot + egg drops
  let lootMsg = '';
  if (isBoss) {
    const bossLoot = DungeonManager.getBossLoot(dungeon.currentFloor);
    if (bossLoot.length > 0) {
      members.forEach(member => {
        if (!member.inventory) member.inventory = { items: [] };
        if (!member.inventory.items) member.inventory.items = [];
        bossLoot.forEach(item => member.inventory.items.push({ ...item }));
      });
      lootMsg = '\n🎁 Boss loot: ' + bossLoot.map(i => i.name).join(', ');
    }
    // Boss floors have higher egg drop chance (30%)
    if (Math.random() < 0.30) {
      try {
        const { rollEggType } = require('../../rpg/utils/PetDatabase');
        const PetManager = require('../../rpg/utils/PetManager');
        const eggId = rollEggType();
        party.members.forEach(m => {
          const r = PetManager.giveEgg(m.id, eggId);
          if (r.success) lootMsg += `\n🥚 *${r.egg.name}* found by ${db.users[m.id]?.name || 'someone'}!`;
        });
      } catch(e) {}
    }
  } else {
    // Regular floors: 10% egg drop chance
    if (Math.random() < 0.10) {
      try {
        const { rollEggType } = require('../../rpg/utils/PetDatabase');
        const PetManager = require('../../rpg/utils/PetManager');
        const eggId = rollEggType();
        // Only leader gets egg on regular floors
        const leaderId = party.leader;
        const r = PetManager.giveEgg(leaderId, eggId);
        if (r.success) lootMsg += `\n🥚 *${r.egg.name}* found by ${db.users[leaderId]?.name || 'leader'}!`;
      } catch(e) {}
    }
  }

  log += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${isBoss ? '🏆' : '✅'} *${monster.name} DEFEATED!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  log += `💫 +${rewards.xp.toLocaleString()} XP (each)\n🪙 +${rewards.gold.toLocaleString()} Gold (each)\n💎 +${rewards.crystals} Crystals (each)\n`;
  if (rewards.upgradePoints) log += `⬆️ +${rewards.upgradePoints} Upgrade Points!\n`;
  log += lootMsg;

  // Guild War points — +1 per floor, +5 per boss floor
  try {
    const warPts = isBoss ? 5 : 1;
    party.members.forEach(m => { GuildWar.addWarPoints(db, m.id, warPts, null); });
  } catch(e) {}

  // Quest tracking
  for (const partyMember of party.members) {
    try {
      const killUpd = QuestManager.updateProgress(partyMember.id, { type: 'kill', target: monster.name, count: 1 });
      await notifyQuestUpdates(sock, partyMember.id, killUpd);
    } catch(e) {}
  }

  // Mark floor cleared and await advance decision
  dungeon.floorsCleared.push(dungeon.currentFloor);
      try { if (DC) { const db2 = getDatabase(); party.members.forEach(m => { const mp = db2.users[m.id]; if (mp) DC.trackProgress(mp, "dungeon_floor", 1); }); } } catch(e) {}
  dungeon.awaitingAdvance = true;
  dungeon.turn = 1;
  saveDatabase();

  const nextFloor = dungeon.currentFloor + 1;
  log += '\n' + buildAdvancePrompt(dungeon, nextFloor, party);

  return sock.sendMessage(chatId, { text: log }, { quoted: msg });
}

// ═══════════════════════════════════════════════════════════════
// PLAYER DEATH
// ═══════════════════════════════════════════════════════════════
async function handlePlayerDeath(sock, chatId, party, dungeon, db, saveDatabase, msg, senderId, log) {
  log += `\n💀 *${db.users[senderId]?.name || 'You'}* has fallen!\n`;

  const aliveMembers = party.members.filter(m => {
    const mp = db.users[m.id];
    return mp && mp.stats.hp > 0;
  });

  if (aliveMembers.length === 0) {
    // Full party wipe
    party.status = 'failed';
    setTimeout(() => delete DungeonPartyManager.parties[party.id], 5000);
    saveDatabase();
    log += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💀 *PARTY WIPED!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎯 Reached Floor: ${dungeon.currentFloor}/20\n\nAll hunters have fallen. Recover and try again!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    return sock.sendMessage(chatId, { text: log }, { quoted: msg });
  }

  saveDatabase();
  log += `⚠️ *${aliveMembers.length} hunter(s) still standing!*\n💡 Use /dungeon item revive to get back up.`;
  return sock.sendMessage(chatId, { text: log }, { quoted: msg });
}

// ═══════════════════════════════════════════════════════════════
// DUNGEON EXIT (voluntary or flee)
// ═══════════════════════════════════════════════════════════════
async function handleDungeonExit(sock, chatId, party, db, saveDatabase, msg, senderId, isFlee) {
  const dungeon  = party.dungeon;
  const members  = party.members.map(m => db.users[m.id]).filter(u => u);
  const avgLevel = party._avgLevel || Math.floor(members.reduce((s,m) => s + m.level, 0) / members.length);
  const floors   = dungeon.floorsCleared.length;
  const prog     = floors / dungeon.maxFloors;

  let xpReward   = Math.floor(avgLevel * 80 * prog * floors);
  let goldReward = Math.floor(avgLevel * 200 * prog * floors);
  let crysReward = Math.min(20, Math.floor(avgLevel * 0.25 * floors)); // ~3-5 crystals per floor, capped at 60

  // Apply seasonal bonuses
  try {
    const bonused = SeasonManager.applyBonuses({ xp: xpReward, gold: goldReward });
    xpReward = bonused.xp ?? xpReward;
    goldReward = bonused.gold ?? goldReward;
  } catch(e) {}

  if (isFlee) {
    // Give partial rewards to ALL current party members (#6 fix), then remove the fleeing player
    members.forEach(member => {
      member.xp           = (member.xp           || 0) + xpReward;
      member.gold         = (member.gold          || 0) + goldReward;
      member.manaCrystals = (member.manaCrystals  || 0) + crysReward;
      if (!member.inventory) member.inventory = {};
      member.inventory.gold = member.gold;
      LevelUpManager.checkAndApplyLevelUps(member, saveDatabase, sock, chatId);
    });

    // Remove from party, not full end
    if (party.leader === senderId) {
      const next = party.members.find(m => m.id !== senderId);
      if (next) party.leader = next.id;
    }
    party.members = party.members.filter(m => m.id !== senderId);

    if (party.members.length === 0) {
      party.status = 'failed';
      setTimeout(() => delete DungeonPartyManager.parties[party.id], 5000);
    }
    saveDatabase();

    const fleePlayer = db.users[senderId];
    return sock.sendMessage(chatId, {
      text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💨 *${fleePlayer?.name || 'A hunter'} FLED FROM DUNGEON!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎯 Floors cleared: ${floors}/20\n\n💰 Partial rewards (all members):\n✨ +${xpReward.toLocaleString()} XP\n🪙 +${goldReward.toLocaleString()} Gold\n💎 +${crysReward} Crystals\n━━━━━━━━━━━━━━━━━━━━━━━━━━━${party.members.length > 0 ? `\n⚔️ ${party.members.length} hunter(s) remain in dungeon.` : '\n💔 Party disbanded.'}`
    }, { quoted: msg });
  }

  // Full party exit after boss
  party.status = 'completed';
  setTimeout(() => delete DungeonPartyManager.parties[party.id], 5000);

  // Give rewards to everyone
  members.forEach(member => {
    member.xp           = (member.xp           || 0) + xpReward;
    member.gold         = (member.gold          || 0) + goldReward;
    member.manaCrystals = (member.manaCrystals  || 0) + crysReward;
    if (!member.inventory) member.inventory = {};
    member.inventory.gold = member.gold;
    LevelUpManager.checkAndApplyLevelUps(member, saveDatabase, sock, chatId);
  });
  saveDatabase();

  return sock.sendMessage(chatId, {
    text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🚪 *DUNGEON EXITED!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏅 Floors cleared: ${floors}/20\n\n💰 Exit rewards (each):\n✨ +${xpReward.toLocaleString()} XP\n🪙 +${goldReward.toLocaleString()} Gold\n💎 +${crysReward} Crystals\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⏰ Cooldown: 30 minutes\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  }, { quoted: msg });
}

// ═══════════════════════════════════════════════════════════════
// DUNGEON COMPLETE (all 20 floors cleared)
// ═══════════════════════════════════════════════════════════════
async function handleDungeonComplete(sock, chatId, party, db, saveDatabase, msg) {
  const dungeon  = party.dungeon;
  const members  = party.members.map(m => ({ player: db.users[m.id], id: m.id })).filter(u => u.player);
  const avgLevel = party._avgLevel || Math.floor(members.reduce((s,m) => s + m.player.level, 0) / members.length);

  let xpReward   = Math.floor(avgLevel * 500 * 20);
  let goldReward = Math.floor(avgLevel * 1500 * 20);
  let crysReward = Math.min(35, Math.floor(5 + avgLevel * 1)); // 60-120 crystals for full clear based on level
  const upReward = 20;
  const time     = Math.floor((Date.now() - dungeon.startTime) / 1000);

  // ── Apply seasonal event bonuses ─────────────────────────────
  let eventBonusMsg = '';
  try {
    const bonused = SeasonManager.applyBonuses({ xp: xpReward, gold: goldReward });
    xpReward   = bonused.xp   ?? xpReward;
    goldReward = bonused.gold ?? goldReward;
    const event = SeasonManager.getActiveEvent();
    if (event) eventBonusMsg = `\n${event.emoji} *${event.name} BONUS!*`;
  } catch(e) {}

  members.forEach(({ player: member, id: memberId }) => {
    member.xp           = (member.xp           || 0) + xpReward;
    member.gold         = (member.gold          || 0) + goldReward;
    member.manaCrystals = (member.manaCrystals  || 0) + crysReward;
    member.upgradePoints = (member.upgradePoints || 0) + upReward;
    if (!member.inventory) member.inventory = {};
    member.inventory.gold = member.gold;
    LevelUpManager.checkAndApplyLevelUps(member, saveDatabase, sock, chatId);
    try { StatAllocationSystem.awardUpgradePoints(member, 'dungeon', 'nightmare'); } catch(e) {}
    try { AchievementManager.track(member, 'dungeon_clear', 1); } catch(e) {}
    try { if (TitleSystem) TitleSystem.checkAndAwardTitles(member); } catch(e) {}
    try { if (DC) DC.trackProgress(member, 'dungeon_clear', 1); } catch(e) {}
    try { const WK=require('./weekly'); WK.trackWeeklyProgress(member,'dungeon_clear',1); } catch(e) {}
    try { const BP2=require('../../rpg/utils/BattlePass'); BP2.addPassXP(member,'dungeon_clear'); } catch(e) {}
    // Guild War points for full dungeon clear (+1 per floor = 20)
    try { if (GuildWar) GuildWar.addWarPoints(db, memberId, 20, null); } catch(e) {}
  });

  // Guaranteed legendary fragment for full clear
  members.forEach(({ player: member }) => {
    if (!member.inventory.items) member.inventory.items = [];
    member.inventory.items.push({ name: 'Legendary Fragment', type: 'QuestItem', rarity: 'legendary', from: dungeon.name, isQuestItem: true });
  });

  party.status = 'completed';
  setTimeout(() => delete DungeonPartyManager.parties[party.id], 5000);
  saveDatabase();

  return sock.sendMessage(chatId, {
    text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏆 *DUNGEON COMPLETE!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${dungeon.name}\n💭 All 20 floors conquered!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⏱️ Time: ${Math.floor(time/60)}m ${time%60}s\n👹 All bosses defeated!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎁 *FULL CLEAR BONUS (each):*\n✨ +${xpReward.toLocaleString()} XP\n🪙 +${goldReward.toLocaleString()} Gold\n💎 +${crysReward} Crystals\n⬆️ +${upReward} Upgrade Points\n📜 Legendary Fragment ×1${eventBonusMsg}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⏰ Cooldown: 30 minutes\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  }, { quoted: msg });
}