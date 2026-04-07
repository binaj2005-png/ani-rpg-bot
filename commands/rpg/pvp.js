const StatusEffectManager = require('../../rpg/utils/StatusEffectManager');
const BP = require('../../rpg/utils/BattlePass');
let TitleSystem; try { TitleSystem = require('../../rpg/utils/TitleSystem'); } catch(e) {}
let CS; try { CS = require('../../rpg/utils/ConstellationSystem'); } catch(e) {}
const BarSystem           = require('../../rpg/utils/BarSystem');
const PetManager          = require('../../rpg/utils/PetManager');
const ImprovedCombat      = require('../../rpg/utils/ImprovedCombat');
const LevelUpManager      = require('../../rpg/utils/LevelUpManager');
const AchievementManager  = require('../../rpg/utils/AchievementManager');
const PvpExtra = require('./pvp_additions');
let GuildWar; try { GuildWar = require('./guildwar'); } catch(e) {}
let QuestManager; try { QuestManager = require('../../rpg/utils/QuestManager'); } catch(e) {}
let SeasonManager; try { SeasonManager = require('../../rpg/utils/SeasonManager'); } catch(e) {}

// ═══════════════════════════════════════════════════════════════
// PENDING CHALLENGES — persisted to db.pendingChallenges
// ═══════════════════════════════════════════════════════════════
const pendingChallenges = new Map();

// Sync helpers — keep in-memory Map and db in sync
function _loadChallengesFromDb(db) {
  if (!db.pendingChallenges) db.pendingChallenges = {};
  // Remove stale challenges older than 90 seconds (expired while bot was offline)
  const now = Date.now();
  for (const [target, c] of Object.entries(db.pendingChallenges)) {
    if (now - c.timestamp > 90_000) delete db.pendingChallenges[target];
    else pendingChallenges.set(target, c);
  }
}

function _saveChallenge(db, targetId, data, saveDatabase) {
  if (!db.pendingChallenges) db.pendingChallenges = {};
  db.pendingChallenges[targetId] = data;
  saveDatabase();
}

function _deleteChallenge(db, targetId, saveDatabase) {
  pendingChallenges.delete(targetId);
  if (db.pendingChallenges) delete db.pendingChallenges[targetId];
  saveDatabase();
}

// ═══════════════════════════════════════════════════════════════
// BATTLE INACTIVITY TIMERS
// ═══════════════════════════════════════════════════════════════
const battleTimers = new Map(); // key: sorted "p1Id|p2Id", value: timeoutId
const BATTLE_INACTIVITY_SECONDS = 120; // cancel battle if no action for 2 min

function getBattleKey(id1, id2) {
  return [id1, id2].sort().join('|');
}

function clearBattleTimer(id1, id2) {
  const key = getBattleKey(id1, id2);
  if (battleTimers.has(key)) {
    clearTimeout(battleTimers.get(key));
    battleTimers.delete(key);
  }
}

function setBattleInactivityTimer(sock, db, saveDatabase, p1Id, p2Id, chatId) {
  clearBattleTimer(p1Id, p2Id);
  const key = getBattleKey(p1Id, p2Id);
  const timer = setTimeout(async () => {
    battleTimers.delete(key);
    const p1 = db.users[p1Id];
    const p2 = db.users[p2Id];
    // Only cancel if both are still in battle with each other
    if (!p1?.pvpBattle || !p2?.pvpBattle) return;
    if (p1.pvpBattle.opponentId !== p2Id && p2.pvpBattle.opponentId !== p1Id) return;

    // Cancel the battle — no winner, no ELO change, just reset
    if (p1?.pvpBattle) { p1.pvpBattle = null; if (p1.statusEffects) p1.statusEffects = []; if (p1.buffs) p1.buffs = []; }
    if (p2?.pvpBattle) { p2.pvpBattle = null; if (p2.statusEffects) p2.statusEffects = []; if (p2.buffs) p2.buffs = []; }
    saveDatabase();

    const n1 = p1?.name || 'Player 1';
    const n2 = p2?.name || 'Player 2';
    await sock.sendMessage(chatId, {
      text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⏰ *BATTLE CANCELLED — INACTIVITY*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n😴 Neither *${n1}* nor *${n2}* took action for *${BATTLE_INACTIVITY_SECONDS}s*.\n\n🏳️ Battle voided — no ELO changes.\nChallenge again: /pvp challenge @user\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      mentions: [p1Id, p2Id]
    });
  }, BATTLE_INACTIVITY_SECONDS * 1000);
  battleTimers.set(key, timer);
}

// ═══════════════════════════════════════════════════════════════
// ELO & RANKS
// ═══════════════════════════════════════════════════════════════
const PVP_RANKS = [
  { name:'Unranked',    emoji:'⚪', minElo:0    },
  { name:'Bronze',      emoji:'🥉', minElo:800  },
  { name:'Silver',      emoji:'🥈', minElo:1000 },
  { name:'Gold',        emoji:'🥇', minElo:1200 },
  { name:'Platinum',    emoji:'💠', minElo:1400 },
  { name:'Diamond',     emoji:'💎', minElo:1600 },
  { name:'Master',      emoji:'🏆', minElo:1800 },
  { name:'Grandmaster', emoji:'👑', minElo:2000 },
  { name:'Legend',      emoji:'🌟', minElo:2200 },
];
function getPvpRank(elo) {
  const e = elo || 1000;
  let r = PVP_RANKS[0];
  for (const rank of PVP_RANKS) if (e >= rank.minElo) r = rank;
  return r;
}
function calcEloChange(wElo, lElo) {
  return Math.round(32 * (1 - 1 / (1 + Math.pow(10, (lElo - wElo) / 400))));
}

// ═══════════════════════════════════════════════════════════════
// CLASS MATCHUPS
// ═══════════════════════════════════════════════════════════════
const CLASS_MATCHUPS = {
  Warrior:      { strongVs:['Archer','Berserker','Warlord'],       weakVs:['Mage','Paladin','Elementalist'] },
  Mage:         { strongVs:['Warrior','DragonKnight','BloodKnight'],weakVs:['Rogue','Assassin','Phantom'] },
  Archer:       { strongVs:['Mage','Rogue','Shaman'],              weakVs:['Warrior','Berserker','Warlord'] },
  Rogue:        { strongVs:['Mage','Necromancer','SpellBlade'],     weakVs:['Archer','Paladin','Monk'] },
  Paladin:      { strongVs:['Rogue','Berserker','BloodKnight'],     weakVs:['Archer','DragonKnight','Chronomancer'] },
  Berserker:    { strongVs:['Archer','Rogue','ShadowDancer'],       weakVs:['Warrior','Paladin','Summoner'] },
  Necromancer:  { strongVs:['Paladin','DragonKnight','Warlord'],    weakVs:['Rogue','Devourer','Phantom'] },
  Assassin:     { strongVs:['Mage','Necromancer','SpellBlade'],     weakVs:['Warrior','Paladin','Monk'] },
  DragonKnight: { strongVs:['Paladin','Devourer','Warlord'],        weakVs:['Mage','Necromancer','Elementalist'] },
  Devourer:     { strongVs:['Necromancer','Rogue','BloodKnight'],   weakVs:['DragonKnight','Warrior','Warlord'] },
  Monk:         { strongVs:['Rogue','Assassin','ShadowDancer'],     weakVs:['Mage','Necromancer','Chronomancer'] },
  Shaman:       { strongVs:['Warrior','Archer','Warlord'],          weakVs:['Mage','Rogue','Phantom'] },
  BloodKnight:  { strongVs:['Paladin','Warrior','Shaman'],          weakVs:['Mage','Devourer','Elementalist'] },
  SpellBlade:   { strongVs:['Warrior','Berserker','Warlord'],       weakVs:['Rogue','Assassin','Phantom'] },
  Summoner:     { strongVs:['Berserker','Warrior','DragonKnight'],  weakVs:['Assassin','Rogue','ShadowDancer'] },
  Warlord:      { strongVs:['Archer','Rogue','Shaman'],             weakVs:['Mage','DragonKnight','Chronomancer'] },
  Elementalist: { strongVs:['Warrior','DragonKnight','BloodKnight'],weakVs:['Rogue','Assassin','Phantom'] },
  ShadowDancer: { strongVs:['Mage','Necromancer','Summoner'],       weakVs:['Warrior','Berserker','Warlord'] },
  Chronomancer: { strongVs:['Paladin','Warrior','Warlord'],         weakVs:['Rogue','Berserker','ShadowDancer'] },
  Phantom:      { strongVs:['Mage','Necromancer','Shaman'],         weakVs:['Warrior','Berserker','BloodKnight'] },
  Knight:       { strongVs:['Berserker','Rogue','Shaman'],          weakVs:['Mage','Archer','Chronomancer'] },
  Ranger:       { strongVs:['Mage','DragonKnight','Shaman'],        weakVs:['Warrior','Berserker','BloodKnight'] },
};
function getMatchup(aClass, dClass) {
  const m = CLASS_MATCHUPS[aClass];
  if (!m) return { mult:1.0, msg:'' };
  if (m.strongVs?.includes(dClass)) return { mult:1.15, msg:`⚡ *Class Advantage!* (+15%)` };
  if (m.weakVs?.includes(dClass))   return { mult:0.88, msg:`🛡️ *Class Disadvantage* (-12%)` };
  return { mult:1.0, msg:'' };
}

// ═══════════════════════════════════════════════════════════════
// CLASS SPECIALS
// ═══════════════════════════════════════════════════════════════
const CLASS_SPECIALS = {
  Warrior:      { name:'Bladestorm',         desc:'Hit 3×70% ATK ignoring 40% DEF. Stuns if all 3 land.',   dmgMult:[0.7,0.7,0.7], armorPen:0.4, stunOnAllHit:true },
  Mage:         { name:'Arcane Overload',    desc:'200% magic dmg. Drain 25 enemy energy. Silence 1 turn.', dmgMult:[2.0], burnEnergy:25, silenceEnemy:true },
  Archer:       { name:'Snipe',              desc:'Guaranteed crit 180% unblockable. +30% if enemy < 50%.', dmgMult:[1.8], guaranteeCrit:true, unblockable:true, execBonus:0.30 },
  Rogue:        { name:'Shadowstrike',       desc:'150% + BLIND 2 turns. Gain vanish.',                     dmgMult:[1.5], applyBlind:true, gainVanish:true },
  Paladin:      { name:'Divine Judgment',    desc:'120% holy + heal 25% dmg. Shield 2 turns.',              dmgMult:[1.2], selfHealPct:0.25, gainShield:true },
  Berserker:    { name:'Primal Rage',        desc:'220% unblockable. Self-damage 10%. +40% ATK 2 turns.',   dmgMult:[2.2], selfDmgPct:0.10, unblockable:true, rageBuffTurns:2 },
  Necromancer:  { name:'Soul Rend',          desc:'120% + drain 20% max HP. Death revive at 15%.',          dmgMult:[1.2], drainMaxHpPct:0.20, deathRevive:true },
  Assassin:     { name:'Death Mark',         desc:'30% current HP instant. Execute if < 20%.',              hpExecute:0.30, executeThreshold:0.20 },
  DragonKnight: { name:'Dragon Breath',      desc:'160% fire. 70% BURN 3t. If burning: 240%.',              dmgMult:[1.6], applyBurn:true, burnChance:0.70, burnBonus:2.4 },
  Devourer:     { name:'Feast',              desc:'100% + steal all buffs + 60% lifesteal.',                dmgMult:[1.0], stealBuffs:true, lifestealPct:0.60 },
  Monk:         { name:'Final Form',         desc:'+50% ATK/SPD 3t. All crits. 20% lifesteal.',             dmgMult:[1.8], selfBuff:true, selfBuffAtk:50, selfBuffSpd:50, lifestealPct:0.20, guaranteeCrit:true },
  Shaman:       { name:"Nature's Fury",      desc:'200% nature AOE. 40% STUN. Poison 3t.',                  dmgMult:[2.0], aoe:true, stunChance:0.40, poisonAll:true },
  BloodKnight:  { name:'Crimson Apocalypse', desc:'280% true. 40% lifesteal. BLEED+WEAKEN 5t.',             dmgMult:[2.8], armorPen:1.0, lifestealPct:0.40, applyBleed:true, applyWeaken:true },
  SpellBlade:   { name:'Spellblade Finale',  desc:'250% magic+physical. +2% per energy.',                   dmgMult:[2.5], armorPen:0.3, scaleWithEnergy:true },
  Summoner:     { name:'Apocalypse Summon',  desc:'300% dmg. All negative statuses 50% each.',              dmgMult:[3.0], applyAll:true },
  Warlord:      { name:'Conquest',           desc:'3×90% unblockable. Each hit -10% enemy DEF.',            dmgMult:[0.9,0.9,0.9], unblockable:true, defShred:0.10 },
  Elementalist: { name:'Elemental Chaos',    desc:'220% chaotic. Random element bonus. 50% all statuses.',  dmgMult:[2.2], randomElement:true, applyAll:true },
  ShadowDancer: { name:'Final Curtain',      desc:'350% true. Absolute dodge 2t. Auto-counter.',            dmgMult:[3.5], armorPen:1.0, gainAbsoluteDodge:2, autoCounter:true },
  Chronomancer: { name:'Temporal Collapse',  desc:'240% + STUN+SLOW 2t. Reset enemy skill CDs.',           dmgMult:[2.4], armorPen:0.5, applyStun:true, applySlow:true },
  Phantom:      { name:'Phantom Apocalypse', desc:'380% true. All statuses. 1HP if >80% dealt.',            dmgMult:[3.8], armorPen:1.0, guaranteeCrit:true, applyAll:true, toOneHp:0.80 },
  Knight:       { name:'Excalibur',          desc:'300% holy. STUN+WEAKEN+SILENCE. Heal 20%.',             dmgMult:[3.0], armorPen:1.0, silenceEnemy:true, applyWeaken:true, applyStun:true, selfHealPct:0.20 },
  Ranger:       { name:"Hunter's End",       desc:'260% + BLEED+SLOW+BLIND 3t. +50% if <60% HP.',          dmgMult:[2.6], applyBleed:true, applySlow:true, applyBlind:true, execBonus:0.50 },
};

// ═══════════════════════════════════════════════════════════════
// DISPLAY HELPERS
// ═══════════════════════════════════════════════════════════════
function getMomentumBar(n) { const f=Math.min(5,Math.floor(n||0)); return '🔴'.repeat(f)+'⚫'.repeat(5-f); }
function getUltiBar(n)     { const f=Math.min(5,Math.floor(n||0)); return '🟣'.repeat(f)+'⬛'.repeat(5-f); }
function getStaggerBar(n)  { const s=Math.min(3,n||0); return ['⬜','⬜','⬜'].map((_,i)=>i<s?(s===3?'🔴':'🟡'):'⬜').join(''); }
function getThreatIcon(hpPct) {
  if (hpPct <= 0.15) return '💀';
  if (hpPct <= 0.30) return '❗';
  if (hpPct <= 0.50) return '⚠️';
  return '✅';
}
function getCdBar(cooldowns) {
  if (!cooldowns?.length) return '';
  return cooldowns.map((cd,i)=> cd>0 ? `${i+1}:🔒${cd}t` : `${i+1}:✅`).join(' ');
}

// ═══════════════════════════════════════════════════════════════
// BATTLE STATE
// ═══════════════════════════════════════════════════════════════
function initBattleState(opponentId, chatId) {
  return {
    opponentId, chatId,
    turnNumber: 1,
    pendingAction: null,
    startTime: Date.now(),
    momentum: 0,
    ultiGauge: 0,
    ultiReady: false,
    stagger: 0,
    guarding: false,
    parryReady: false,
    counterBonus: false,
    forcedSkip: false,
    forcedAttack: false,
    forcedAtkPenalty: 0,
    comboCount: 0,
    lastAction: null,
    lastDmgDealt: 0,
    consecutiveGuards: 0,
    rageMode: false,
    vanish: false,
    absoluteDodgeTurns: 0,
    autoCounter: false,
    deathReviveUsed: false,
    petSacrificed: false,
    shieldActive: false,
    lastSpecialUsed: null,
    stats: PvpExtra.initBattleStats(),
    _rageCommented: false,
    critStreak: 0,
    // NEW v3 systems
    skillCooldowns: [],          // per-skill cooldowns
    actionHistory: [],           // last 3 actions for chain combo detection
    desperationUsed: false,      // one-time desperation move
    feintActive: false,          // feint pending
    possessedTurn: false,        // possessed — attacks self
    phaseOut: false,             // phased out — unhittable 1 turn
    timeReversalActive: false,   // reflect all damage taken this turn
    conquerorMode: 0,            // turns remaining of conqueror (3× ATK)
    holyStrikes: 0,              // remaining holy strike charges
    shadowRealmActive: false,
    mirrorMazeActive: false,
    ancientRuinsActive: false,
    frozenTundraActive: false,
    bloodlustTurn: false,
  };
}

function processBuffDurations(entity) {
  if (!entity.buffs) { entity.buffs = []; return; }
  entity.buffs = entity.buffs.filter(b => { b.duration--; return b.duration > 0; });
}

function getClassName(player) {
  return typeof player.class === 'object' ? player.class.name : (player.class || 'Warrior');
}

function getTotalAtk(player) {
  const mods   = StatusEffectManager.getStatModifiers(player);
  const weapon = player.weapon?.bonus || player.weapon?.attack || 0;
  let petAtk   = 0;
  try { const pb = PetManager.getPetBattleBonus(player.userId||''); petAtk = pb?.bonuses?.atk || 0; } catch(e) {}
  // Title boost (ALL stats)
  let titleAtk=0, titleDef=0, titleSpd=0, titleHp=0;
  try { if (TitleSystem) { const tb=TitleSystem.getEquippedBoost(player); titleAtk=tb.atk||0; titleDef=tb.def||0; titleSpd=tb.speed||0; titleHp=tb.maxHp||0; } } catch(e) {}
  // Constellation sponsor bonus
  let consAtk=0, consDef=0, consSpd=0, consHp=0;
  try { if (CS) { const sb=CS.getSponsorBonus(player); consAtk=sb.atk||0; consDef=sb.def||0; consSpd=sb.speed||0; consHp=sb.maxHp||0; } } catch(e) {}
  let atk = Math.floor((player.stats.atk + weapon + petAtk + titleAtk + consAtk) * mods.atkMod);
  if (player.buffs?.length) {
    let bMult = 0;
    player.buffs.forEach(b => { if (b.stat === 'atk') bMult += b.amount; });
    atk = Math.floor(atk * (1 + bMult / 100));
  }
  return atk;
}

// ═══════════════════════════════════════════════════════════════
// CALCULATE ONE PLAYER'S ACTION
// ═══════════════════════════════════════════════════════════════
function calculateAction(attacker, defender, action, atkState, defState, arena) {
  const aClass   = getClassName(attacker);
  const dClass   = getClassName(defender);
  const matchup  = getMatchup(aClass, dClass);
  const totalAtk = getTotalAtk(attacker);

  // Status: skip turn
  const blocked = attacker.statusEffects?.find(e => ['stun','freeze','paralyze'].includes(e.type));
  if (blocked || atkState.forcedSkip) {
    atkState.forcedSkip = false;
    return { damage:0, narrative:`🔒 *${attacker.name}* is ${blocked?.type.toUpperCase()||'STUNNED'} — turn skipped!\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0 };
  }

  // Possessed — attacks themselves
  if (atkState.possessedTurn) {
    atkState.possessedTurn = false;
    const selfDmg = Math.floor(totalAtk * 0.5);
    attacker.stats.hp = Math.max(1, attacker.stats.hp - selfDmg);
    return { damage:0, narrative:`👻 *${attacker.name}* is POSSESSED and attacks themselves for *${selfDmg}*!\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0 };
  }

  // Fear: 40% miss
  const feared = attacker.statusEffects?.find(e => e.type === 'fear');
  if (feared && Math.random() < 0.40) {
    return { damage:0, narrative:`😱 *${attacker.name}* is paralysed with FEAR — wasted turn!\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0 };
  }

  const counterMult = atkState.counterBonus ? 1.5 : 1.0;
  if (atkState.counterBonus) atkState.counterBonus = false;

  // ── GUARD ──────────────────────────────────────────────────
  if (action.type === 'guard') {
    atkState.guarding       = true;
    atkState.consecutiveGuards++;
    atkState.comboCount     = 0;
    atkState.lastAction     = 'guard';
    atkState.actionHistory  = [...(atkState.actionHistory||[]), 'guard'].slice(-3);
    if (atkState.consecutiveGuards >= 2) atkState.parryReady = true;
    const parryMsg = atkState.parryReady ? `\n✨ *PARRY READY!* Perfect counter primed!` : '';
    return { damage:0, narrative:`🛡️ *${attacker.name}* braces for impact!\n> 65% damage reduction active.${parryMsg}\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0, isGuard:true };
  }

  atkState.consecutiveGuards = 0;

  // ── TAUNT ──────────────────────────────────────────────────
  if (action.type === 'taunt') {
    defState.forcedAttack     = true;
    defState.forcedAtkPenalty = 0.30;
    atkState.momentum         = Math.min(5, (atkState.momentum||0) + 2);
    atkState.lastAction       = 'taunt';
    atkState.actionHistory    = [...(atkState.actionHistory||[]), 'taunt'].slice(-3);
    return { damage:0, narrative:`😤 *${attacker.name}* TAUNTS!\n> ${defender.name} MUST attack next (−30% ATK)\n> +2 ⚡ Momentum!\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0 };
  }

  // ── FEINT ──────────────────────────────────────────────────
  if (action.type === 'feint') {
    atkState.feintActive = true;
    atkState.lastAction  = 'feint';
    atkState.actionHistory = [...(atkState.actionHistory||[]), 'feint'].slice(-3);
    // Deal very small damage, but if opponent was guarding -> they wasted guard, get counter next turn
    const feintDmg = Math.floor(totalAtk * 0.20);
    let narrative = `🎭 *${attacker.name}* FEINTS — minimal damage, baiting the guard!\n`;
    narrative += `💥 *${feintDmg}* chip damage!\n`;
    if (defState.guarding) {
      defState.guarding = false; // Burn their guard
      atkState.counterBonus = true; // Free counter bonus next turn
      atkState.momentum = Math.min(5, (atkState.momentum||0) + 2);
      narrative += `🧠 *FEINT SUCCESS!* Guard broken — FREE COUNTER INCOMING! +2 Momentum!\n`;
    }
    return { damage:feintDmg, narrative, energyCost:0, momentumGain:1, staggerAdd:0, isCrit:false, healing:0 };
  }

  // ── DESPERATION MOVE ───────────────────────────────────────
  if (action.type === 'desperation') {
    const hpPct = attacker.stats.hp / attacker.stats.maxHp;
    const desp = PvpExtra.DESPERATION_MOVES[aClass];
    if (!desp) return { damage:0, narrative:`❌ No desperation move for ${aClass}!\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0 };
    if (hpPct > 0.15) return { damage:0, narrative:`❌ Desperation only unlocks at ≤15% HP!\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0 };
    if (atkState.desperationUsed) return { damage:0, narrative:`❌ Desperation already used this battle!\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0 };

    atkState.desperationUsed = true;
    atkState.lastAction = 'desperation';
    atkState.actionHistory = [...(atkState.actionHistory||[]), 'desperation'].slice(-3);

    let totalDmg = 0;
    let narrative = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💀 *DESPERATION MOVE: ${desp.name}!*\n${desp.desc}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

    // Energy nuke
    if (desp.energyNuke) {
      const en = attacker.stats.energy || 0;
      const dmg = Math.floor(en * desp.dmgMult * matchup.mult);
      defender.stats.hp = Math.max(0, defender.stats.hp - dmg);
      totalDmg = dmg; attacker.stats.energy = 0;
      narrative += `💥 ${en} energy → *${dmg}* magic damage! Energy drained to 0!\n`;
    }
    // Energy scale nuke
    else if (desp.energyScaleNuke) {
      const en = attacker.stats.energy || 0;
      const defRed = desp.armorPen === 1.0 ? 0 : Math.floor((defender.stats.def||0)*0.4*(1-(desp.armorPen||0)));
      const dmg = Math.max(1, Math.floor(en * 3 * matchup.mult) - defRed);
      defender.stats.hp = Math.max(0, defender.stats.hp - dmg); totalDmg = dmg;
      narrative += `💜 ${en} energy × 3 = *${dmg}* damage! DEF ignored!\n`;
    }
    // Multi-hit
    else if (desp.dmgMult && Array.isArray(desp.dmgMult)) {
      for (let i=0; i<desp.dmgMult.length; i++) {
        const pen = desp.armorPen || 0;
        const defRed = Math.floor((defender.stats.def||0)*0.4*(1-pen));
        let hitDmg = Math.floor(totalAtk * desp.dmgMult[i] * matchup.mult);
        if (pen < 1) hitDmg -= defRed;
        hitDmg = Math.max(1, hitDmg);
        // Blind chance per hit
        if (desp.blindChance && Math.random() < desp.blindChance) StatusEffectManager.applyEffect(defender, 'blind', 2);
        defender.stats.hp = Math.max(0, defender.stats.hp - hitDmg);
        totalDmg += hitDmg;
        if (desp.lifestealPct) { const ls = Math.floor(hitDmg * desp.lifestealPct); attacker.stats.hp = Math.min(attacker.stats.maxHp, attacker.stats.hp + ls); }
      }
      if (desp.executeThreshold && defender.stats.hp / defender.stats.maxHp <= desp.executeThreshold) {
        narrative += `💀 *EXECUTE!* Target at critical HP — *INSTANT KILL!*\n`;
        defender.stats.hp = 0;
      }
      narrative += `💥 Total: *${totalDmg}* damage (${desp.dmgMult.length} hits)!\n`;
    }
    // HP drain
    else if (desp.hpDrainPct) {
      const drain = Math.floor(defender.stats.hp * desp.hpDrainPct);
      defender.stats.hp = Math.max(0, defender.stats.hp - drain);
      const heal = desp.fullLifesteal ? drain * 2 : drain;
      attacker.stats.hp = Math.min(attacker.stats.maxHp, attacker.stats.hp + heal);
      totalDmg = drain;
      narrative += `☠️ Drained *${drain}* HP! Healed *${heal}* HP!\n`;
    }
    // Max HP steal
    else if (desp.maxHpStealPct) {
      const stolen = Math.floor(defender.stats.maxHp * desp.maxHpStealPct);
      defender.stats.maxHp = Math.max(50, defender.stats.maxHp - stolen);
      defender.stats.hp    = Math.min(defender.stats.hp, defender.stats.maxHp);
      attacker.stats.maxHp += stolen;
      narrative += `👁️ *CONSUMED ${stolen} max HP* from ${defender.name}!\n`;
    }
    // Shadow world
    else if (desp.shadowWorld) {
      const d1 = Math.floor(attacker.stats.hp * 0.50);
      const d2 = Math.floor(defender.stats.hp * 0.50);
      attacker.stats.hp = Math.max(1, attacker.stats.hp - d1);
      defender.stats.hp = Math.max(0, defender.stats.hp - d2);
      attacker.stats.hp = Math.min(attacker.stats.maxHp, attacker.stats.hp + d2 * 2);
      totalDmg = d2;
      narrative += `🌑 Shadow World: both take 50% HP. ShadowDancer heals DOUBLE!\n`;
    }
    // Time reversal
    else if (desp.timeReversal) {
      atkState.timeReversalActive = true;
      narrative += `⏳ *TIME REVERSAL ACTIVE!* All damage you take this turn reflected at 150%!\n`;
    }
    // Possess
    else if (desp.possessEnemy) {
      const pen = desp.armorPen || 0;
      const defRed = Math.floor((defender.stats.def||0)*0.4*(1-pen));
      const mults = desp.dmgMult || [1.0];
      for (const m of mults) {
        const h = Math.max(1, Math.floor(totalAtk*m*matchup.mult) - defRed);
        defender.stats.hp = Math.max(0, defender.stats.hp - h); totalDmg += h;
      }
      defState.possessedTurn = true;
      narrative += `💥 *${totalDmg}* true damage!\n👻 *POSSESSED!* ${defender.name} attacks themselves next turn!\n`;
    }

    // Self effects
    if (desp.gainVanish)         { atkState.vanish = true; narrative += `👻 VANISH active!\n`; }
    if (desp.immuneToDeath)      { atkState.immuneToDeath = true; narrative += `💀 *DEATH IMMUNITY* this turn!\n`; }
    if (desp.immunityTurn)       { atkState.immunityTurn = true; narrative += `✨ *IMMUNITY SHIELD* active!\n`; }
    if (desp.healPct) { const h=Math.floor(attacker.stats.maxHp*desp.healPct); attacker.stats.hp=Math.min(attacker.stats.maxHp,attacker.stats.hp+h); narrative+=`💚 Healed *${h}* HP!\n`; }
    if (desp.selfDmgPct) { const sd=Math.floor(attacker.stats.maxHp*desp.selfDmgPct); attacker.stats.hp=Math.max(1,attacker.stats.hp-sd); narrative+=`🩸 Recoil: -${sd} HP\n`; }
    if (desp.lastStandTurns) { if(!attacker.buffs)attacker.buffs=[]; attacker.buffs.push({stat:'atk',amount:80,duration:desp.lastStandTurns,name:'Last Stand'},{stat:'def',amount:80,duration:desp.lastStandTurns,name:'Last Stand'}); narrative+=`⚔️ +80% ATK/DEF for ${desp.lastStandTurns} turns!\n`; }
    if (desp.statBoostAll) { if(!attacker.buffs)attacker.buffs=[]; attacker.buffs.push({stat:'atk',amount:Math.floor(desp.statBoostAll*100),duration:2,name:'Ascension'},{stat:'def',amount:Math.floor(desp.statBoostAll*100),duration:2,name:'Ascension'}); narrative+=`🐉 +${Math.floor(desp.statBoostAll*100)}% all stats 2 turns!\n`; }
    if (desp.absoluteDodgeTurns) { atkState.absoluteDodgeTurns = desp.absoluteDodgeTurns; narrative+=`💨 Dodge next ${desp.absoluteDodgeTurns} attacks!\n`; }
    if (desp.conquerorMode) { atkState.conquerorMode = desp.conquerorMode; narrative+=`👑 *CONQUEROR MODE!* ×3 ATK for ${desp.conquerorMode} turns!\n`; }
    if (desp.holyStrikes) { atkState.holyStrikes = desp.holyStrikes; narrative+=`✨ ${desp.holyStrikes} holy strikes loaded!\n`; }
    if (desp.cleanse && attacker.statusEffects) { attacker.statusEffects=[]; narrative+=`🌿 All debuffs cleansed!\n`; }
    if (desp.phaseOut) { atkState.phaseOut = true; narrative+=`🌿 *PHASE OUT!* Untargetable this turn!\n`; }
    if (desp.applyAll && desp.allGuaranteed) {
      const effects=['burn','poison','bleed','weaken','slow','fear'];
      for(const e of effects){StatusEffectManager.applyEffect(defender,e,3);}
      narrative+=`☠️ ALL 6 status effects applied GUARANTEED!\n`;
    }
    if (desp.applyFreeze) StatusEffectManager.applyEffect(defender,'freeze',2);
    if (desp.applyBurn)   StatusEffectManager.applyEffect(defender,'burn',3);
    if (desp.applyPoison) StatusEffectManager.applyEffect(defender,'poison',3);

    narrative += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    narrative += PvpExtra.getCommentary('desperation');

    if (atkState.stats) atkState.stats.desperationUsed = true;
    return { damage:totalDmg, narrative, energyCost:0, momentumGain:3, staggerAdd:2, isCrit:false, healing:0, wasSpecial:true };
  }

  // ── BASIC ATTACK ───────────────────────────────────────────
  if (action.type === 'attack') {
    if (atkState.lastAction === 'attack') atkState.comboCount = Math.min(4, (atkState.comboCount||0) + 1);
    else atkState.comboCount = 1;
    atkState.lastAction = 'attack';
    atkState.actionHistory = [...(atkState.actionHistory||[]), 'attack'].slice(-3);

    const comboBonus = atkState.comboCount >= 4 ? 0.40 : atkState.comboCount >= 3 ? 0.25 : atkState.comboCount >= 2 ? 0.12 : 0;
    const comboMsg   = atkState.comboCount >= 4 ? `🔥 *ULTRA COMBO ×${atkState.comboCount}!* +40%!\n` : atkState.comboCount >= 3 ? `🌀 *COMBO ×${atkState.comboCount}!* +25%!\n` : atkState.comboCount >= 2 ? `💫 *COMBO ×2!* +12%!\n` : '';

    // Shadow realm miss
    if (atkState.shadowRealmActive && Math.random() < 0.20) {
      return { damage:0, narrative:`🌑 *SHADOW REALM MISS!* ${attacker.name}'s attack vanishes into darkness!\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0 };
    }

    let critBonus = (attacker.stats.critChance || attacker.statAllocations?.critChance || 0) * 0.005;
    if (atkState.frozenTundraActive) critBonus += 0.05;
    const critChance = 0.12 + critBonus;
    let isCrit = Math.random() < critChance;

    // Chain combo: relentless auto-crit
    if (atkState._chainComboBonus?.guaranteeCrit) { isCrit = true; }

    let critMult = (atkState.shadowRealmActive ? 2.0 : 1.5) + ((attacker.stats.critDamage || attacker.statAllocations?.critDamage || 0) * 0.01);
    if (atkState.bloodlustTurn) critMult = 2.5;

    let atkMult = 1.0;
    if (atkState.forcedAttack) { atkMult *= (1 - atkState.forcedAtkPenalty); atkState.forcedAttack = false; atkState.forcedAtkPenalty = 0; }
    if (atkState.conquerorMode > 0) atkMult *= 3.0;

    let rawDmg = Math.floor(totalAtk * (isCrit ? critMult : 1.0) * matchup.mult * (1 + comboBonus) * counterMult * atkMult);

    // ── Constellation Sponsor Skills ───────────────────────────
    let sponsorMsg = '';
    try {
      if (CS && attacker.constellations && Object.keys(attacker.constellations).length) {
        const skills = CS.getSponsorSkills(attacker);
        for (const skill of skills) {
          const fav = skill.fav;
          const favMult = 1 + (fav - 1) * 0.08; // higher fav = stronger

          // Secretive Plotter — Omniscient Reading (20% counter)
          if (skill.conId === 'secretive_plotter' && defState._lastAction) {
            if (Math.random() < 0.20 * favMult) {
              rawDmg = Math.floor(rawDmg * 1.5);
              sponsorMsg += `📖 *Omniscient Reading!* Predicted the attack! (+50% dmg)
`;
            }
          }
          // Demon King — Proclamation (below 25% HP burst)
          if (skill.conId === 'demon_king_of_salvation') {
            const hpPct = attacker.stats.hp / attacker.stats.maxHp;
            if (hpPct <= 0.25 && !atkState._dkBurstUsed) {
              atkState._dkBurstUsed = true;
              rawDmg = Math.floor(attacker.stats.atk * 2.0 * favMult);
              sponsorMsg += `😈 *Demon King's Proclamation!* Dark burst unleashed! (${rawDmg} dmg)
`;
            }
          }
          // Abyssal Black Flame — every 3rd skill
          if (skill.conId === 'abyssal_black_flame_dragon') {
            if (!atkState._bfdCount) atkState._bfdCount = 0;
            atkState._bfdCount++;
            rawDmg = Math.floor(rawDmg * 1.35 * favMult);
            if (atkState._bfdCount % 3 === 0) {
              const flameDmg = Math.floor(attacker.stats.atk * 1.5 * favMult);
              rawDmg += flameDmg;
              sponsorMsg += `🐉 *Black Flame!* True damage released! (+${flameDmg})
`;
            }
          }
          // King of the Outside — ignore 30% DEF
          if (skill.conId === 'king_of_the_outside') {
            if (!defState._defShred) defState._defShred = 0;
            defState._defShred = Math.min(30, Math.floor(30 * favMult));
          }
          // Oldest Dream — first 5 turns +15%
          if (skill.conId === 'oldest_dream') {
            const turn = atkState.turn || 1;
            if (turn <= 5) { rawDmg = Math.floor(rawDmg * (1 + 0.15 * favMult)); }
          }
          // Prisoner — first attack 180%
          if (skill.conId === 'prisoner_of_golden_headband' && !atkState._prisonerUsed) {
            atkState._prisonerUsed = true;
            rawDmg = Math.floor(attacker.stats.atk * 1.8 * favMult);
            sponsorMsg += `🐒 *Ruyi Jingu Bang!* (${rawDmg} dmg)
`;
          }
          // Sea of Abyss — speed advantage bonus
          if (skill.conId === 'sea_of_abyss') {
            const atkSpd = attacker.stats.speed||0;
            const defSpd = defender.stats.speed||0;
            if (atkSpd > defSpd) { rawDmg = Math.floor(rawDmg * (1 + 0.15 * favMult)); }
          }
          // Blade Master — negate one attack
          if (skill.conId === 'blade_master_dokja' && !atkState._rewriteUsed) {
            // This applies defensively — handled below in defender section
          }
          // Pale Rider — crit chance
          if (skill.conId === 'young_pale_rider') {
            const extraCrit = 0.10 * favMult;
            if (Math.random() < extraCrit && !isCrit) { rawDmg = Math.floor(rawDmg * 1.25); }
          }
          // Storm Thunderer — chain strike 15%
          if (skill.conId === 'storm_thunderer') {
            if (Math.random() < 0.15 * favMult) {
              const chainDmg = Math.floor(rawDmg * 0.5);
              rawDmg += chainDmg;
              sponsorMsg += `⚡ *Thunder Chain!* (+${chainDmg})
`;
            }
          }
          // Sky Shepherd — HP regen at turn start (handled in processBuffDurations equivalent)
          if (skill.conId === 'sky_shepherd') {
            const turn = atkState.turn || 1;
            if (turn <= 3 && !atkState[`_skyHeal_${turn}`]) {
              atkState[`_skyHeal_${turn}`] = true;
              const heal = Math.floor(attacker.stats.maxHp * 0.05 * favMult);
              attacker.stats.hp = Math.min(attacker.stats.maxHp, attacker.stats.hp + heal);
              sponsorMsg += `☁️ *Heavenly Blessing!* +${heal} HP
`;
            }
          }
        }
      }
    } catch(eCons) {}

    // ── Weapon Passive Trigger ─────────────────────────────────
    let passiveMsg = '';
    try {
      const BS = require('../../rpg/utils/BannerSystem');
      if (attacker.weapon?.passive || attacker.weapon?.id) {
        const weapon = attacker.weapon?.passive ? attacker.weapon : (attacker.weapon?.id ? BS.ITEM_REGISTRY[attacker.weapon.id] : null);
        if (weapon) {
          if (!atkState._hitCount) atkState._hitCount = 0;
          atkState._hitCount++;
          const passResult = BS.triggerWeaponPassive(
            weapon, attacker.stats.hp, defender.stats.hp, defender.stats.maxHp,
            (atkState.turn||1), atkState._hitCount
          );
          if (passResult.triggered) {
            if (passResult.extraDmg) rawDmg = Math.floor(rawDmg * (1 + passResult.extraDmg));
            if (passResult.flatDmg)  rawDmg += passResult.flatDmg;
            if (passResult.atkBuff && !atkState._voidRampApplied) {
              atkState._voidRampApplied = true;
              // Applied to next turn's raw damage via state
            }
            if (passResult.defShred) {
              if (!defState._defShred) defState._defShred = 0;
              defState._defShred = Math.min(15, defState._defShred + passResult.defShred);
            }
            if (passResult.stun) defState._stunned = true;
            if (passResult.msg) passiveMsg = passResult.msg + '\n';
          }
        }
      }
    } catch(e) {}

    const hpPct = attacker.stats.hp / attacker.stats.maxHp;
    if (hpPct <= 0.20 && !atkState.rageMode) atkState.rageMode = true;
    if (atkState.rageMode) rawDmg = Math.floor(rawDmg * 1.30);

    // Holy strikes override
    if (atkState.holyStrikes > 0) {
      atkState.holyStrikes--;
      rawDmg = Math.floor(totalAtk * 2.0 * matchup.mult);
      const defRed2 = 0; // holy = true damage
      const finalHoly = Math.max(1, rawDmg);
      defender.stats.hp = Math.max(0, defender.stats.hp - finalHoly);
      atkState.lastDmgDealt = finalHoly;
      const lsHoly = 0;
      return { damage:finalHoly, narrative:`✨ *HOLY STRIKE!* *${finalHoly}* true holy damage! (${atkState.holyStrikes} charges left)\n`, energyCost:0, momentumGain:isCrit?2:1, staggerAdd:isCrit?2:1, isCrit, healing:0 };
    }

    let defMult = atkState.ancientRuinsActive ? 0.85 : 1.0;
    const extraDef = (defState?._titleDef||0) + (defState?._consDef||0);
    const defRed  = Math.floor(((defender.stats.def || 0) + extraDef) * 0.4 * defMult);
    const finalDmg = Math.max(1, rawDmg - defRed);
    const lsPct    = (attacker.statAllocations?.lifesteal || 0) * 0.005;
    const lsHeal   = lsPct > 0 ? Math.floor(finalDmg * lsPct) : 0;
    if (lsHeal > 0) attacker.stats.hp = Math.min(attacker.stats.maxHp, attacker.stats.hp + lsHeal);

    // Mirror maze reflect
    let reflectDmg = 0;
    if (defState.mirrorMazeActive && Math.random() < 0.25) {
      reflectDmg = Math.floor(finalDmg * 0.30);
      attacker.stats.hp = Math.max(1, attacker.stats.hp - reflectDmg);
    }

    // Chain combo bonus for iron patience
    if (atkState._chainComboBonus) {
      const cb = atkState._chainComboBonus;
      const bonusApplied = Math.floor(finalDmg * (cb.bonusMult - 1));
      defender.stats.hp = Math.max(0, defender.stats.hp - bonusApplied);
      atkState._chainComboBonus = null;
    }

    let narrative = '';
    if (isCrit) narrative += `💥 *CRITICAL HIT!*\n`;
    if (passiveMsg) narrative += passiveMsg;
    if (atkState.rageMode && !atkState._rageNarrated) { narrative += `🔥 *RAGE MODE!* +30% ATK!\n`; atkState._rageNarrated = true; }
    if (comboMsg) narrative += comboMsg;
    if (matchup.msg) narrative += matchup.msg + '\n';
    narrative += `⚔️ *${attacker.name}* strikes for *${finalDmg}* damage!\n`;
    if (lsHeal > 0) narrative += `💚 Lifesteal: +${lsHeal} HP\n`;
    if (reflectDmg > 0) narrative += `🪞 *Mirror Maze!* ${reflectDmg} reflected to attacker!\n`;

    atkState.lastDmgDealt = finalDmg;
    return { damage:finalDmg, narrative, energyCost:0, momentumGain:isCrit?2:1, staggerAdd:isCrit?2:1, isCrit, healing:lsHeal };
  }

  // ── SKILL ──────────────────────────────────────────────────
  if (action.type === 'skill') {
    const silenced = attacker.statusEffects?.find(e => e.type === 'silence');
    if (silenced) return { damage:0, narrative:`🤐 *${attacker.name}* is SILENCED — skills locked!\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0 };

    const skill = attacker.skills?.active?.[action.skillIndex];
    if (!skill) return { damage:0, narrative:`❌ Skill not found!\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0 };

    // Cooldown check
    if (atkState.skillCooldowns && !PvpExtra.isSkillReady(atkState.skillCooldowns, action.skillIndex)) {
      const cdLeft = atkState.skillCooldowns[action.skillIndex];
      return { damage:0, narrative:`🔒 *${skill.name}* is on cooldown! (${cdLeft} turns)\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0 };
    }

    const cost = skill.energyCost || 20;
    const actualCost = atkState.ancientRuinsActive ? Math.max(5, cost - 5) : cost;
    if (attacker.stats.energy < actualCost) return { damage:0, narrative:`❌ Need ${actualCost} ${attacker.energyType||'Energy'} (have ${attacker.stats.energy})!\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0 };

    // Apply cooldown
    if (atkState.skillCooldowns) atkState.skillCooldowns = PvpExtra.useSkillCooldown(atkState.skillCooldowns, action.skillIndex);

    const opStunned = defender.statusEffects?.find(e => ['stun','freeze','paralyze'].includes(e.type));
    const stunBonus = opStunned ? 1.30 : 1.0;

    const result = ImprovedCombat.processSkill(attacker, defender, skill.name, { pvp: true });
    if (!result.success) return { damage:0, narrative: result.message || `❌ Skill failed!\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0 };

    let baseDmg  = result.damage || 0;
    // Ancient ruins bonus for skills
    if (atkState.ancientRuinsActive) baseDmg = Math.floor(baseDmg * 1.20);
    const adjDmg = Math.floor(baseDmg * matchup.mult * stunBonus);
    if (adjDmg > baseDmg) defender.stats.hp = Math.max(0, defender.stats.hp - (adjDmg - baseDmg));

    atkState.lastDmgDealt = adjDmg;
    atkState.lastAction   = 'skill';
    atkState.comboCount   = 0;
    atkState.actionHistory = [...(atkState.actionHistory||[]), 'skill'].slice(-3);

    let narrative = result.narrative || `⚡ *${skill.name}* dealt *${adjDmg}* damage!\n`;
    if (opStunned) narrative += `⚡ *EXECUTE BONUS!* +30% vs stunned!\n`;
    if (matchup.msg) narrative += matchup.msg + '\n';
    if (atkState.ancientRuinsActive) narrative += `🏚️ *Ruins Empowerment!* +20% skill damage!\n`;

    // Check chain combo: deathblow
    const chain = PvpExtra.checkChainCombo(atkState.actionHistory);

    return { damage:adjDmg, narrative, energyCost:actualCost, momentumGain:result.isCrit?2:1, staggerAdd:result.isCrit?2:1, isCrit:result.isCrit||false, healing:0, _chain:chain };
  }

  // ── CLASS SPECIAL ──────────────────────────────────────────
  if (action.type === 'special') {
    const sp = CLASS_SPECIALS[aClass];
    if (!sp) return { damage:0, narrative:`❌ No special for ${aClass}!\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0 };

    atkState.ultiGauge    = 0;
    atkState.ultiReady    = false;
    atkState.lastSpecialUsed = sp.name;
    atkState.lastAction   = 'special';
    atkState.comboCount   = 0;
    atkState.actionHistory = [...(atkState.actionHistory||[]), 'special'].slice(-3);

    // Check chain combos: breakthrough, deathblow
    const chainForSpecial = PvpExtra.checkChainCombo(atkState.actionHistory);
    const chainBonusMult  = chainForSpecial?.bonusMult || 1.0;
    const chainArmorBonus = chainForSpecial?.armorPenBonus || 0;
    let chainMsg = '';
    if (chainForSpecial) {
      chainMsg = `🔗 *${chainForSpecial.name}!*\n${chainForSpecial.desc}\n`;
      if (atkState.stats) atkState.stats.combosActivated = (atkState.stats.combosActivated||0)+1;
    }

    // Perfect parry check
    if (defState.parryReady) {
      defState.parryReady   = false;
      defState.counterBonus = true;
      defState.momentum     = Math.min(5, (defState.momentum||0) + 3);
      const parryDmg        = Math.floor(totalAtk * 1.8);
      attacker.stats.hp     = Math.max(0, attacker.stats.hp - parryDmg);
      return { damage:0, narrative:`🌀 *PERFECT PARRY!* ${defender.name} reads the special!\n💥 *${parryDmg}* reflected! +3 Momentum!\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0, wasParried:true };
    }

    let totalDmg = 0;
    let narrative = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🌟 *ULTIMATE: ${sp.name}!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (chainMsg) narrative += chainMsg;

    if (sp.hpExecute) {
      const execDmg = Math.floor(defender.stats.hp * sp.hpExecute);
      const hpPctDef = defender.stats.hp / defender.stats.maxHp;
      if (sp.executeThreshold && hpPctDef <= sp.executeThreshold) {
        defender.stats.hp = 0; totalDmg = defender.stats.maxHp;
        narrative += `💀 *INSTANT EXECUTION!* Target below ${Math.floor(sp.executeThreshold*100)}% HP!\n`;
      } else {
        defender.stats.hp = Math.max(0, defender.stats.hp - execDmg); totalDmg = execDmg;
        narrative += `💀 *${sp.hpExecute*100}% CURRENT HP* torn away! (${execDmg} dmg)\n`;
      }
    } else {
      const mults = sp.dmgMult || [1.5];
      let allHit = true;
      for (let i=0; i<mults.length; i++) {
        const m      = mults[i] * chainBonusMult;
        const pen    = Math.min(1.0, (sp.armorPen||0) + chainArmorBonus);
        const defRed = Math.floor((defender.stats.def||0)*0.4*(1-pen));
        let hitDmg   = Math.floor(totalAtk * m * matchup.mult);
        if (!sp.unblockable) hitDmg -= defRed;
        if (sp.scaleWithEnergy) hitDmg += Math.floor(attacker.stats.energy * 0.02);
        if (sp.burnBonus) {
          const alreadyBurning = defender.statusEffects?.find(e=>e.type==='burn');
          if (alreadyBurning) hitDmg = Math.floor(totalAtk * sp.burnBonus * matchup.mult * chainBonusMult);
        }
        if (sp.randomElement) hitDmg = Math.floor(hitDmg * (0.9 + Math.random() * 0.4));
        hitDmg = Math.max(1, hitDmg);
        if (sp.defShred) {
          const shredAmt = Math.floor((defender.stats.def||0)*sp.defShred);
          defender.stats.def = Math.max(0, (defender.stats.def||0)-shredAmt);
          narrative += `🗡️ Hit ${i+1}: *${hitDmg}* dmg! DEF shredded by ${shredAmt}!\n`;
        } else if (mults.length>1) narrative += `⚔️ Hit ${i+1}: *${hitDmg}*\n`;
        defender.stats.hp = Math.max(0, defender.stats.hp - hitDmg);
        totalDmg += hitDmg;
        if (hitDmg <= 0) allHit = false;
      }
      if (sp.stunOnAllHit && allHit && mults.length>1) { StatusEffectManager.applyEffect(defender,'stun',1); narrative+=`⭐ *ALL HITS LANDED — STUNNED!*\n`; }
      if (mults.length===1) narrative+=`💥 *${totalDmg}* total damage!\n`;
      else narrative+=`💥 Total: *${totalDmg}* damage!\n`;
    }

    // to 1 HP
    if (sp.toOneHp && totalDmg >= defender.stats.maxHp * sp.toOneHp && defender.stats.hp > 1) {
      defender.stats.hp = 1; narrative+=`☠️ *DEVASTATING* — reduced to 1 HP!\n`;
    }
    // Exec bonus (ranged)
    if (sp.execBonus) {
      const th = sp===CLASS_SPECIALS.Archer?0.50:0.60;
      if (defender.stats.hp/defender.stats.maxHp <= th) {
        const bonus=Math.floor(totalDmg*sp.execBonus); defender.stats.hp=Math.max(0,defender.stats.hp-bonus); totalDmg+=bonus;
        narrative+=`🎯 *LOW HP BONUS!* +${bonus} extra!\n`;
      }
    }
    // Chain forceStagger
    if (chainForSpecial?.forceStagger) { StatusEffectManager.applyEffect(defender,'stun',1); narrative+=`🔗 *COMBO STAGGER!* ${defender.name} stunned!\n`; }

    // Self effects
    if (sp.selfDmgPct)   { const sd=Math.floor(attacker.stats.maxHp*sp.selfDmgPct); attacker.stats.hp=Math.max(1,attacker.stats.hp-sd); narrative+=`🩸 Recoil: ${sd} HP\n`; }
    if (sp.selfHealPct)  { const h=Math.floor(totalDmg*sp.selfHealPct); attacker.stats.hp=Math.min(attacker.stats.maxHp,attacker.stats.hp+h); narrative+=`💚 Lifesteal: +${h} HP!\n`; }
    if (sp.lifestealPct && totalDmg>0) { const ls=Math.floor(totalDmg*sp.lifestealPct); attacker.stats.hp=Math.min(attacker.stats.maxHp,attacker.stats.hp+ls); narrative+=`💚 Lifesteal: +${ls} HP!\n`; }
    if (sp.burnEnergy)   { defender.stats.energy=Math.max(0,(defender.stats.energy||0)-sp.burnEnergy); narrative+=`⚡ Drained *${sp.burnEnergy}* energy!\n`; }
    if (sp.rageBuffTurns){ if(!attacker.buffs)attacker.buffs=[]; attacker.buffs.push({stat:'atk',amount:40,duration:sp.rageBuffTurns,name:'Primal Rage'}); narrative+=`🔥 +40% ATK for ${sp.rageBuffTurns} turns!\n`; }
    if (sp.selfBuff)     { if(!attacker.buffs)attacker.buffs=[]; attacker.buffs.push({stat:'atk',amount:sp.selfBuffAtk||50,duration:3,name:'Final Form'},{stat:'spd',amount:sp.selfBuffSpd||50,duration:3,name:'Final Form'}); narrative+=`💪 +${sp.selfBuffAtk}% ATK & +${sp.selfBuffSpd}% SPD 3t!\n`; }

    if (sp.silenceEnemy) { StatusEffectManager.applyEffect(defender,'silence',2); narrative+=`🤐 *SILENCED!* 2 turns!\n`; }
    if (sp.applyBlind)   { StatusEffectManager.applyEffect(defender,'blind',2); narrative+=`🌫️ *BLINDED!* 2 turns!\n`; }
    if (sp.applyBurn && Math.random()<(sp.burnChance||0.5)) { StatusEffectManager.applyEffect(defender,'burn',3); narrative+=`🔥 *BURNING!* 3 turns!\n`; }
    if (sp.poisonAll)    { StatusEffectManager.applyEffect(defender,'poison',3); narrative+=`☠️ *POISONED!* 3 turns!\n`; }
    if (sp.applyBleed)   { StatusEffectManager.applyEffect(defender,'bleed',5); narrative+=`🩸 *BLEEDING!* 5 turns!\n`; }
    if (sp.applyWeaken)  { StatusEffectManager.applyEffect(defender,'weaken',3); narrative+=`💔 *WEAKENED!* 3 turns!\n`; }
    if (sp.applyStun)    { StatusEffectManager.applyEffect(defender,'stun',2); narrative+=`⭐ *STUNNED!* 2 turns!\n`; }
    if (sp.applySlow)    { StatusEffectManager.applyEffect(defender,'slow',2); narrative+=`🐢 *SLOWED!* 2 turns!\n`; }
    if (sp.applyAll)     {
      const allE=['burn','poison','bleed','weaken','slow','fear'];
      for(const e of allE) if(Math.random()<0.50){StatusEffectManager.applyEffect(defender,e,3);narrative+=`${e==='burn'?'🔥':e==='poison'?'☠️':e==='bleed'?'🩸':e==='weaken'?'💔':e==='slow'?'🐢':'😱'} *${e.toUpperCase()}!*\n`;}
    }
    if (sp.stealBuffs && defender.buffs?.length) {
      if(!attacker.buffs)attacker.buffs=[];
      attacker.buffs.push(...defender.buffs.map(b=>({...b})));
      const n=defender.buffs.length; defender.buffs=[];
      narrative+=`🌀 *STOLE ${n} buff(s)!*\n`;
    }
    if (sp.gainVanish)        { atkState.vanish=true; narrative+=`👻 *VANISH!*\n`; }
    if (sp.gainShield)        { atkState.shieldActive=true; narrative+=`🛡️ *DIVINE SHIELD!*\n`; }
    if (sp.gainAbsoluteDodge) { atkState.absoluteDodgeTurns=sp.gainAbsoluteDodge; narrative+=`💨 *ABSOLUTE DODGE!* ${sp.gainAbsoluteDodge} turns!\n`; }
    if (sp.autoCounter)       { atkState.autoCounter=true; narrative+=`⚡ *AUTO-COUNTER!* Reflects every hit!\n`; }
    if (sp.deathRevive)       { atkState.deathReviveUsed=false; narrative+=`💀 *SOUL PACT!* Will revive at 15% HP!\n`; }

    narrative += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (matchup.msg) narrative+=matchup.msg+'\n';
    atkState.lastDmgDealt=totalDmg;
    return { damage:totalDmg, narrative, energyCost:0, momentumGain:0, staggerAdd:2, isCrit:sp.guaranteeCrit||false, healing:0, wasSpecial:true };
  }

  return { damage:0, narrative:`❓ Unknown action\n`, energyCost:0, momentumGain:0, staggerAdd:0, isCrit:false, healing:0 };
}

// ═══════════════════════════════════════════════════════════════
// EXECUTE BOTH ACTIONS — main resolution engine
// ═══════════════════════════════════════════════════════════════
async function executeBothActions(sock, chatId, p1, p2, db, save, sender) {
  const p1Id  = Object.keys(db.users).find(id => db.users[id] === p1) || sender;
  const p2Id  = Object.keys(db.users).find(id => db.users[id] === p2);
  const p1s   = p1.pvpBattle;
  const p2s   = p2.pvpBattle;
  const p1Act = p1s.pendingAction;
  const p2Act = p2s.pendingAction;
  const p1Cls = getClassName(p1);
  const p2Cls = getClassName(p2);
  const arena = p1s.arena;

  // Arena passive effects
  let arenaMsg = '';
  if (arena?.applyPassive) {
    try {
      const am = arena.applyPassive(p1, p2, p1s, p2s, p1s.turnNumber);
      if (am) arenaMsg = `${arena.emoji} *${arena.name}:* ${am}\n`;
    } catch(e) {}
  }

  // Tick skill cooldowns
  if (p1s.skillCooldowns) p1s.skillCooldowns = PvpExtra.tickSkillCooldowns(p1s.skillCooldowns);
  if (p2s.skillCooldowns) p2s.skillCooldowns = PvpExtra.tickSkillCooldowns(p2s.skillCooldowns);

  // Conqueror mode tick
  if (p1s.conquerorMode > 0) p1s.conquerorMode--;
  if (p2s.conquerorMode > 0) p2s.conquerorMode--;

  // bloodlust resets each turn (set by event)
  p1s.bloodlustTurn = false;
  p2s.bloodlustTurn = false;

  // Resolve actions
  const r1 = calculateAction(p1, p2, p1Act, p1s, p2s, arena);
  const r2 = calculateAction(p2, p1, p2Act, p2s, p1s, arena);

  // Speed ordering
  const p1Spd = p1.stats.speed || 100;
  const p2Spd = p2.stats.speed || 100;
  const p1First = p1Spd >= p2Spd;

  let p1Takes = r2.damage;
  let p2Takes = r1.damage;

  // Phase out — unhittable
  if (p1s.phaseOut) { p1Takes = 0; p1s.phaseOut = false; }
  if (p2s.phaseOut) { p2Takes = 0; p2s.phaseOut = false; }

  // Immunity turn (Paladin/desperation)
  if (p1s.immunityTurn) { p1Takes = 0; p1s.immunityTurn = false; }
  if (p2s.immunityTurn) { p2Takes = 0; p2s.immunityTurn = false; }

  // Guard reduction
  if (p1s.guarding && !r2.unblockable) p1Takes = Math.floor(p1Takes * 0.35);
  if (p2s.guarding && !r1.unblockable) p2Takes = Math.floor(p2Takes * 0.35);

  // Feint check — if attacker feinted and defender guarded, defender guard was burned (handled in calculateAction)

  // Vanish
  if (p1s.vanish && p1Takes > 0) { p1s.vanish=false; p1Takes=0; }
  if (p2s.vanish && p2Takes > 0) { p2s.vanish=false; p2Takes=0; }

  // Absolute dodge
  if (p1s.absoluteDodgeTurns > 0) { p1s.absoluteDodgeTurns--; p1Takes=0; }
  if (p2s.absoluteDodgeTurns > 0) { p2s.absoluteDodgeTurns--; p2Takes=0; }

  // Divine shield
  if (p1s.shieldActive) { p1Takes=Math.floor(p1Takes*0.5); p1s.shieldActive=false; }
  if (p2s.shieldActive) { p2Takes=Math.floor(p2Takes*0.5); p2s.shieldActive=false; }

  // Time reversal — reflect incoming damage at 150%
  if (p1s.timeReversalActive && p1Takes > 0) {
    const reflected = Math.floor(p1Takes * 1.5);
    p2.stats.hp = Math.max(0, p2.stats.hp - reflected);
    p1Takes = 0; p1s.timeReversalActive = false;
  }
  if (p2s.timeReversalActive && p2Takes > 0) {
    const reflected = Math.floor(p2Takes * 1.5);
    p1.stats.hp = Math.max(0, p1.stats.hp - reflected);
    p2Takes = 0; p2s.timeReversalActive = false;
  }

  // Auto-counter
  if (p1s.autoCounter && p1Takes > 0) { const ref=Math.floor(p1Takes*0.6); p2.stats.hp=Math.max(0,p2.stats.hp-ref); p1s.autoCounter=false; }
  if (p2s.autoCounter && p2Takes > 0) { const ref=Math.floor(p2Takes*0.6); p1.stats.hp=Math.max(0,p1.stats.hp-ref); p2s.autoCounter=false; }

  // Death immunity (desperation)
  let p1ImmuneDeath = p1s.immuneToDeath; p1s.immuneToDeath = false;
  let p2ImmuneDeath = p2s.immuneToDeath; p2s.immuneToDeath = false;

  // Speed kill
  if (p1First && p2Takes >= p2.stats.hp && !p2ImmuneDeath) p1Takes = 0;
  if (!p1First && p1Takes >= p1.stats.hp && !p1ImmuneDeath) p2Takes = 0;

  p1.stats.hp = Math.max(0, p1.stats.hp - p1Takes);
  p2.stats.hp = Math.max(0, p2.stats.hp - p2Takes);

  // Death immunity saves at 1 HP
  if (p1.stats.hp <= 0 && p1ImmuneDeath) { p1.stats.hp = 1; }
  if (p2.stats.hp <= 0 && p2ImmuneDeath) { p2.stats.hp = 1; }

  // Death revive
  for (const [pl, plState] of [[p1,p1s],[p2,p2s]]) {
    if (pl.stats.hp <= 0 && !plState.deathReviveUsed && CLASS_SPECIALS[getClassName(pl)]?.deathRevive) {
      plState.deathReviveUsed = true;
      pl.stats.hp = Math.floor(pl.stats.maxHp * 0.15);
    }
  }

  // Pet sacrifice
  const petSacMsgs = [];
  for (const [pid, pl, plState] of [[p1Id,p1,p1s],[p2Id,p2,p2s]]) {
    if (pl.stats.hp <= 0 && !plState.petSacrificed) {
      try {
        const pet = PetManager.getActivePet(pid);
        if (pet && (pet.bonding||0) > 50) {
          plState.petSacrificed = true;
          pl.stats.hp = Math.floor(pl.stats.maxHp * 0.10);
          const pd = PetManager.getPlayerData(pid);
          if (pd) { pd.pets=pd.pets.filter(p=>p.instanceId!==pet.instanceId); if(pd.activePet===pet.instanceId)pd.activePet=pd.pets[0]?.instanceId||null; PetManager.save(); }
          if (!pl.buffs) pl.buffs=[];
          pl.buffs.push({stat:'atk',amount:30,duration:2,name:'Vengeful Rage'},{stat:'def',amount:20,duration:2,name:'Vengeful Rage'});
          petSacMsgs.push(`💀 *${pet.emoji} ${pet.nickname||pet.name}* sacrifices itself for ${pl.name}!\n🐾 Survives at ${pl.stats.hp} HP — *VENGEFUL RAGE!*\n`);
        }
      } catch(e){}
    }
  }

  // Stagger
  let p1Staggered=false, p2Staggered=false;
  if (p2Takes>0&&r1.staggerAdd) { p2s.stagger=(p2s.stagger||0)+r1.staggerAdd; if(p2s.stagger>=3){p2s.stagger=0;StatusEffectManager.applyEffect(p2,'stun',1);p2Staggered=true;} }
  if (p1Takes>0&&r2.staggerAdd) { p1s.stagger=(p1s.stagger||0)+r2.staggerAdd; if(p1s.stagger>=3){p1s.stagger=0;StatusEffectManager.applyEffect(p1,'stun',1);p1Staggered=true;} }

  // Momentum
  if (p2Takes>0) p1s.momentum=Math.min(5,(p1s.momentum||0)+(r1.momentumGain||0));
  if (p1Takes>0) p2s.momentum=Math.min(5,(p2s.momentum||0)+(r2.momentumGain||0));
  if (p1Act.type==='guard') p1s.momentum=Math.max(0,(p1s.momentum||0)-1);
  if (p2Act.type==='guard') p2s.momentum=Math.max(0,(p2s.momentum||0)-1);

  // Ultimate gauge
  if (p2Takes>0) p1s.ultiGauge=Math.min(5,(p1s.ultiGauge||0)+(r1.isCrit?2:1));
  if (p1Takes>0) p1s.ultiGauge=Math.min(5,(p1s.ultiGauge||0)+1);
  if (p1Takes>0) p2s.ultiGauge=Math.min(5,(p2s.ultiGauge||0)+(r2.isCrit?2:1));
  if (p2Takes>0) p2s.ultiGauge=Math.min(5,(p2s.ultiGauge||0)+1);
  p1s.ultiReady=(p1s.ultiGauge>=5);
  p2s.ultiReady=(p2s.ultiGauge>=5);

  // Guard interrupt counter
  const p1TotalAtk=getTotalAtk(p1); const p2TotalAtk=getTotalAtk(p2);
  if (p1s.guarding&&r2.damage>0&&r2.damage<p2TotalAtk*0.70) p1s.counterBonus=true;
  if (p2s.guarding&&r1.damage>0&&r1.damage<p1TotalAtk*0.70) p2s.counterBonus=true;

  // Energy regen (frozen tundra = -40%)
  const p1Regen = p1s.rageMode ? 18 : p1s.frozenTundraActive ? 7 : 12;
  const p2Regen = p2s.rageMode ? 18 : p2s.frozenTundraActive ? 7 : 12;
  if (p1Act.type!=='skill') p1.stats.energy=Math.min(p1.stats.maxEnergy,(p1.stats.energy||0)+p1Regen);
  if (p2Act.type!=='skill') p2.stats.energy=Math.min(p2.stats.maxEnergy,(p2.stats.energy||0)+p2Regen);
  if (r1.energyCost) p1.stats.energy=Math.max(0,p1.stats.energy-r1.energyCost);
  if (r2.energyCost) p2.stats.energy=Math.max(0,p2.stats.energy-r2.energyCost);

  p1s.guarding=false; p2s.guarding=false;

  // Status effect tick
  const p1SE = StatusEffectManager.processTurnEffects(p1);
  const p2SE = StatusEffectManager.processTurnEffects(p2);
  processBuffDurations(p1);
  processBuffDurations(p2);

  // Rage mode
  for (const [pl,plState] of [[p1,p1s],[p2,p2s]]) {
    if (pl.stats.hp/pl.stats.maxHp<=0.20&&!plState.rageMode) plState.rageMode=true;
  }

  // Pet attacks
  const petMsgs=[];
  for (const [pid,pl,other] of [[p1Id,p1,p2],[p2Id,p2,p1]]) {
    try {
      PetManager.updateHunger(pid);
      const pb=PetManager.getPetBattleBonus(pid);
      if (pb?.canUseAbility) {
        const pr=PetManager.usePetAbility(pid);
        if (pr?.success) {
          const pd=Math.max(1,Math.floor(pr.ability.damage+pr.pet.stats.atk*0.4)-Math.floor((other.stats.def||0)*0.2));
          other.stats.hp=Math.max(0,other.stats.hp-pd);
          petMsgs.push(`🐾 ${pr.pet.emoji} *${pr.pet.nickname||pr.pet.name}*: *${pr.ability.name}* — ${pd} dmg!\n`);
        }
      }
    } catch(e){}
  }

  // Crit streaks
  if (r1.isCrit) p1s.critStreak=(p1s.critStreak||0)+1; else p1s.critStreak=0;
  if (r2.isCrit) p2s.critStreak=(p2s.critStreak||0)+1; else p2s.critStreak=0;

  // Stats tracking
  if (p1s.stats) PvpExtra.updateBattleStats(p1s.stats,p2Takes,p1Takes,r1.isCrit,p1Act.type,0);
  if (p2s.stats) PvpExtra.updateBattleStats(p2s.stats,p1Takes,p2Takes,r2.isCrit,p2Act.type,0);

  // Battle event
  const turnNum=(p1s.turnNumber||1);
  const bEvent=PvpExtra.rollBattleEvent(turnNum);
  let eventMsg='';
  if (bEvent) {
    try {
      const extra=bEvent.apply(p1,p2,StatusEffectManager,p1s,p2s);
      eventMsg=`\n🌍 *BATTLE EVENT!*\n${bEvent.name}\n${bEvent.desc}\n${extra?extra+'\n':''}`;
    } catch(e){}
  }

  const bKey=PvpExtra.battleKey(p1Id,p2Id);
  PvpExtra.clearBattleTimer(bKey);

  p1s.pendingAction=null; p2s.pendingAction=null;
  p1s.turnNumber++; p2s.turnNumber++;
  save();

  // ── BUILD MESSAGE — sent one by one ───────────────────────
  const p1Rank=getPvpRank(p1.pvpElo);
  const p2Rank=getPvpRank(p2.pvpElo);
  const turn=p1s.turnNumber-1;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const ordered = p1First
    ? [[p1,r1,p1Takes,p1Cls,p1Rank,p1Id,p1s,p1Staggered],[p2,r2,p2Takes,p2Cls,p2Rank,p2Id,p2s,p2Staggered]]
    : [[p2,r2,p2Takes,p2Cls,p2Rank,p2Id,p2s,p2Staggered],[p1,r1,p1Takes,p1Cls,p1Rank,p1Id,p1s,p1Staggered]];

  // MSG 1 — Turn header
  let header = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  if (arena) header += `${arena.emoji} *${arena.name}*\n`;
  header += `⚔️ *TURN ${turn} — BOTH STRIKE!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  if (arenaMsg) header += `\n${arenaMsg}`;
  await sock.sendMessage(chatId, { text: header, mentions: [p1Id, p2Id] });
  await sleep(800);

  // MSG 2 & 3 — Each player's action separately
  for (const [pl,res,dmgTaken,cls,rank,pid,state,wasStaggered] of ordered) {
    const hpPct = pl.stats.hp / pl.stats.maxHp;
    let pmsg = `${rank.emoji} @${pid.split('@')[0]} *${pl.name}* [${cls}]:\n`;
    pmsg += res.narrative;
    if (dmgTaken > 0 && !res.wasParried) pmsg += `🩹 Took *${dmgTaken}* damage!\n`;
    if (wasStaggered) pmsg += `⭐ *STAGGERED!* Stunned next turn!\n`;
    if (state.rageMode && hpPct<=0.20) pmsg += `🔥 *RAGE MODE!* +30% ATK\n`;
    if (state.ultiReady) pmsg += `🟣 *ULTIMATE READY!* → /pvp ultimate\n`;
    if (state.conquerorMode>0) pmsg += `👑 *CONQUEROR MODE!* ×3 ATK — ${state.conquerorMode} turns left!\n`;
    if (state.holyStrikes>0) pmsg += `✨ *HOLY STRIKES:* ${state.holyStrikes} charges!\n`;
    await sock.sendMessage(chatId, { text: pmsg, mentions: [pid] });
    await sleep(900);
  }

  // MSG 4 — Pet / status effects / cinematic (if any)
  const extraParts = [];
  if (petSacMsgs.length) extraParts.push(petSacMsgs.join(''));
  if (petMsgs.length) extraParts.push(petMsgs.join(''));
  const seAll=[...p1SE.messages,...p2SE.messages];
  if (seAll.length) extraParts.push(`🌀 *STATUS:*\n${seAll.join('\n')}`);
  const cinema=PvpExtra.buildCinematicComment(p1,p2,p1s,p2s,r1,r2,p1Takes,p2Takes,turn);
  if (cinema) extraParts.push(cinema);
  if (eventMsg) extraParts.push(eventMsg);
  const specSet=PvpExtra.spectators.get(bKey);
  if (specSet?.size>0) extraParts.push(`👁️ *${specSet.size} spectator(s) watching*`);
  if (extraParts.length > 0) {
    await sock.sendMessage(chatId, { text: extraParts.join('\n'), mentions: [p1Id, p2Id] });
    await sleep(800);
  }

  // MSG 5 — HP bars + desperation hints
  const p1HpPct=p1.stats.hp/p1.stats.maxHp;
  const p2HpPct=p2.stats.hp/p2.stats.maxHp;
  let bars = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  bars += `${getThreatIcon(p1HpPct)} *${p1.name}*\n`;
  bars += `${BarSystem.getHPBar(p1.stats.hp,p1.stats.maxHp)} ${p1.stats.hp}/${p1.stats.maxHp}\n`;
  bars += `⚡${getMomentumBar(p1s.momentum)} 🔶${getStaggerBar(p1s.stagger)} 🟣${getUltiBar(p1s.ultiGauge)}\n`;
  if (p1s.skillCooldowns?.some(cd=>cd>0)) bars+=`🔒 *Skills:* ${getCdBar(p1s.skillCooldowns)}\n`;
  bars += `\n${getThreatIcon(p2HpPct)} *${p2.name}*\n`;
  bars += `${BarSystem.getHPBar(p2.stats.hp,p2.stats.maxHp)} ${p2.stats.hp}/${p2.stats.maxHp}\n`;
  bars += `⚡${getMomentumBar(p2s.momentum)} 🔶${getStaggerBar(p2s.stagger)} 🟣${getUltiBar(p2s.ultiGauge)}\n`;
  if (p2s.skillCooldowns?.some(cd=>cd>0)) bars+=`🔒 *Skills:* ${getCdBar(p2s.skillCooldowns)}\n`;
  bars += `━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  if (p1HpPct<=0.15 && !p1s.desperationUsed) bars+=`\n⚠️ @${p1Id.split('@')[0]} *DESPERATION UNLOCKED!* → /pvp desperation`;
  if (p2HpPct<=0.15 && !p2s.desperationUsed) bars+=`\n⚠️ @${p2Id.split('@')[0]} *DESPERATION UNLOCKED!* → /pvp desperation`;
  await sock.sendMessage(chatId, { text: bars, mentions: [p1Id, p2Id] });

  if (p1.stats.hp<=0||p2.stats.hp<=0) {
    PvpExtra.clearBattleTimer(bKey);
    clearBattleTimer(p1Id, p2Id);

    // ── DRAW: both dead simultaneously ──────────────────────
    if (p1.stats.hp<=0 && p2.stats.hp<=0) {
      // Split gold reward, no ELO change, no win/loss recorded
      const drawGold = 50 + Math.floor((p1.level + p2.level) * 2);
      p1.gold = (p1.gold||0) + drawGold;
      p2.gold = (p2.gold||0) + drawGold;
      p1.stats.hp = Math.floor(p1.stats.maxHp * 0.10);
      p2.stats.hp = Math.floor(p2.stats.maxHp * 0.10);
      // Record draw in match history
      const drawRecord = (opp) => ({ result:'draw', opponent:opp.name, opponentElo:opp.pvpElo||1000, eloChange:'0', turns:turn, timestamp:Date.now() });
      if (!Array.isArray(p1.pvpHistory)) p1.pvpHistory=[];
      if (!Array.isArray(p2.pvpHistory)) p2.pvpHistory=[];
      p1.pvpHistory.unshift(drawRecord(p2)); p2.pvpHistory.unshift(drawRecord(p1));
      if (p1.pvpHistory.length>10) p1.pvpHistory=p1.pvpHistory.slice(0,10);
      if (p2.pvpHistory.length>10) p2.pvpHistory=p2.pvpHistory.slice(0,10);
      p1.pvpBattle = null; p1.statusEffects = []; p1.buffs = [];
      p2.pvpBattle = null; p2.statusEffects = []; p2.buffs = [];
      save();
      PvpExtra.spectators.delete(bKey);
      return sock.sendMessage(chatId, {
        text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💥 *MUTUAL DESTRUCTION!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nBoth fighters struck each other down at the exact same moment!\n\n⚖️ *DRAW!*\n\n🤝 *${p1.name}* vs *${p2.name}*\n   No ELO change for either fighter.\n   💰 Both receive *${drawGold}g* consolation prize.\n\n🩹 Both survive at 10% HP.\n💡 Heal up and challenge again!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        mentions: [p1Id, p2Id]
      });
    }

    const winner=p1.stats.hp>0?p1:p2;
    const loser=p1.stats.hp>0?p2:p1;
    const wId=p1.stats.hp>0?p1Id:p2Id;
    const lId=p1.stats.hp>0?p2Id:p1Id;
    const wStats=(p1.stats.hp>0?p1s:p2s).stats;
    const lStats=(p1.stats.hp>0?p2s:p1s).stats;
    return handleVictory(sock,chatId,winner,loser,wId,lId,db,save,wStats,lStats,turn);
  }

  await PvpExtra.setTurnTimer(sock,chatId,p1,p2,p1Id,p2Id,db,save,bKey);
  return sendTurnPrompt(sock,chatId,p1,p2,p1Id,p2Id,p1Rank,p2Rank);
}

// ═══════════════════════════════════════════════════════════════
// TURN PROMPT
// ═══════════════════════════════════════════════════════════════
async function sendTurnPrompt(sock, chatId, p1, p2, p1Id, p2Id, p1Rank, p2Rank) {
  const p1s=p1.pvpBattle; const p2s=p2.pvpBattle;
  const turn=p1s.turnNumber;
  const p1Cls=getClassName(p1); const p2Cls=getClassName(p2);
  const arena=p1s.arena;

  const p1HpPct=p1.stats.hp/p1.stats.maxHp;
  const p2HpPct=p2.stats.hp/p2.stats.maxHp;

  const tips = (player, state, pClass) => {
    const t = [];
    if ((state.momentum||0)>=3) t.push(`⚡ *Special ready!* → /pvp special`);
    if (state.ultiReady) t.push(`🟣 *ULTIMATE CHARGED!* → /pvp ultimate`);
    if (state.parryReady) t.push(`✨ *PARRY PRIMED!* Use /pvp guard now!`);
    if (state.rageMode) t.push(`🔥 RAGE MODE — +30% ATK!`);
    if (state.conquerorMode>0) t.push(`👑 CONQUEROR: ×3 ATK (${state.conquerorMode}t)`);
    if (player.stats.hp/player.stats.maxHp<=0.15&&!state.desperationUsed) t.push(`💀 *DESPERATION READY!* → /pvp desperation`);
    if (state.skillCooldowns?.some(cd=>cd>0)) t.push(`🔒 CDs: ${getCdBar(state.skillCooldowns)}`);
    // Chain combo hint
    const hist=state.actionHistory||[];
    for(const combo of PvpExtra.CHAIN_COMBOS){
      const seq=combo.sequence;
      if(hist.length>=seq.length-1){
        const partial=hist.slice(-(seq.length-1));
        if(partial.length===seq.length-1&&partial.every((a,i)=>a===seq[i])){
          t.push(`🔗 *COMBO HINT!* Use ${seq[seq.length-1].toUpperCase()} for ${combo.name}!`);
        }
      }
    }
    return t;
  };

  const p1Tips=tips(p1,p1s,p1Cls);
  const p2Tips=tips(p2,p2s,p2Cls);

  let txt=`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  if (arena) txt+=`${arena.emoji} *${arena.name}*\n${arena.desc}\n`;
  txt+=`🎮 *TURN ${turn}* — Choose your action!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  txt+=`@${p1Id.split('@')[0]} ${p1Rank.emoji} [${p1Cls}]\n`;
  txt+=`❤️ ${p1.stats.hp}/${p1.stats.maxHp} | ${p1.energyColor||'💙'} ${p1.stats.energy}/${p1.stats.maxEnergy}\n`;
  txt+=`⚡${getMomentumBar(p1s.momentum)} 🔶${getStaggerBar(p1s.stagger)} 🟣${getUltiBar(p1s.ultiGauge)}\n`;
  if (p1Tips.length) txt+=p1Tips.join('\n')+'\n';

  txt+=`\n@${p2Id.split('@')[0]} ${p2Rank.emoji} [${p2Cls}]\n`;
  txt+=`❤️ ${p2.stats.hp}/${p2.stats.maxHp} | ${p2.energyColor||'💙'} ${p2.stats.energy}/${p2.stats.maxEnergy}\n`;
  txt+=`⚡${getMomentumBar(p2s.momentum)} 🔶${getStaggerBar(p2s.stagger)} 🟣${getUltiBar(p2s.ultiGauge)}\n`;
  if (p2Tips.length) txt+=p2Tips.join('\n')+'\n';

  txt+=`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  txt+=`🎯 *ACTIONS*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  txt+=`/pvp attack        — Basic attack + build combo\n`;
  txt+=`/pvp guard         — Block 65% dmg (2× → PARRY!)\n`;
  txt+=`/pvp taunt         — Force enemy (-30% ATK) + momentum\n`;
  txt+=`/pvp feint         — Fake attack to bait guard\n`;
  txt+=`/pvp skill         — View your skills\n`;
  txt+=`/pvp use [#]       — Use a skill\n`;
  txt+=`/pvp special (3⚡) — Class signature move\n`;
  txt+=`/pvp ultimate (5🟣)— LIMIT BREAK!\n`;
  txt+=`/pvp desperation   — 💀 Last resort (≤15% HP)\n`;
  txt+=`/pvp surrender\n`;
  txt+=`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  txt+=`💡 *MECHANICS:*\n`;
  txt+=`⚡ Momentum (3) → special | 🟣 Ultimate (5) → limit break\n`;
  txt+=`🔶 3 Crits → STAGGER stun | 🛡️ Guard×2 → PARRY\n`;
  txt+=`🎭 Feint → baits guard (free counter!) | 🔗 Action chains → COMBOS\n`;
  txt+=`💀 ≤15% HP → DESPERATION (1×/battle, powerful)`;

  return sock.sendMessage(chatId, { text:txt, mentions:[p1Id,p2Id] });
}

// ═══════════════════════════════════════════════════════════════
// VICTORY
// ═══════════════════════════════════════════════════════════════
async function handleVictory(sock, chatId, winner, loser, wId, lId, db, save, wStats, lStats, totalTurns) {
  const wElo=winner.pvpElo||1000; const lElo=loser.pvpElo||1000;
  const change=calcEloChange(wElo,lElo); const loss=Math.round(change*0.8);

  const rankBefore=getPvpRank(wElo);
  winner.pvpElo=(winner.pvpElo||1000)+change;
  loser.pvpElo=Math.max(100,(loser.pvpElo||1000)-loss);
  const rankAfter=getPvpRank(winner.pvpElo);
  const rankUp=rankAfter.name!==rankBefore.name&&winner.pvpElo>wElo;

  winner.pvpWins=(winner.pvpWins||0)+1;
  loser.pvpLosses=(loser.pvpLosses||0)+1;
  winner.pvpStreak=(winner.pvpStreak||0)+1;
  loser.pvpStreak=0;

  const baseGold=800+Math.floor(loser.level*50)+(winner.pvpStreak>=3?200:0);
  const baseXP=300+(loser.level*20);

  // ── Apply seasonal event bonuses (#3) ──────────────────────
  let finalGold = baseGold;
  let finalXP = baseXP;
  let eventBonusMsg = '';
  try {
    if (SeasonManager) {
      const bonused = SeasonManager.applyBonuses({ gold: baseGold, xp: baseXP });
      finalGold = bonused.gold ?? baseGold;
      finalXP   = bonused.xp   ?? baseXP;
      const event = SeasonManager.getActiveEvent();
      if (event && (finalGold !== baseGold || finalXP !== baseXP)) {
        eventBonusMsg = `\n${event.emoji} *${event.name} BONUS!* Gold ×${event.goldMult||1} XP ×${event.xpMult||1}`;
      }
    }
  } catch(e) {}

  const streakBonus=winner.pvpStreak>=5?`\n🔥 *${winner.pvpStreak}-WIN STREAK!* +50g`:winner.pvpStreak>=3?`\n🔥 Win Streak ×${winner.pvpStreak}! +50g`:'';

  winner.gold=(winner.gold||0)+finalGold;
  winner.xp=(winner.xp||0)+finalXP;
  LevelUpManager.checkAndApplyLevelUps(winner,save,sock,chatId);

  // ── Restore pet passive stats (reverse what was applied at battle start) ──
  const restorePetPassive = (pl) => {
    const b = pl.pvpBattle || {};
    if (b.petPassiveAtk) pl.stats.atk = Math.max(0, (pl.stats.atk||0) - b.petPassiveAtk);
    if (b.petPassiveDef) pl.stats.def = Math.max(0, (pl.stats.def||0) - b.petPassiveDef);
    if (b.petPassiveSpd) pl.stats.speed = Math.max(0, (pl.stats.speed||0) - b.petPassiveSpd);
  };
  restorePetPassive(winner);
  restorePetPassive(loser);

  winner.pvpBattle=null; winner.statusEffects=[]; winner.buffs=[];
  winner.stats.hp=Math.floor(winner.stats.maxHp*0.40);
  winner.stats.energy=winner.stats.maxEnergy;
  loser.pvpBattle=null; loser.statusEffects=[]; loser.buffs=[];
  loser.stats.hp=Math.floor(loser.stats.maxHp*0.15);

  // ── GOLD SINK: 5% death penalty on loser ─────────────────
  const deathTax = Math.floor((loser.gold||0) * 0.05);
  if (deathTax > 0) {
    loser.gold = Math.max(0, (loser.gold||0) - deathTax);
    winner.gold = (winner.gold||0) + Math.floor(deathTax * 0.5); // winner gets half, rest gone
  }
  const deathTaxMsg = deathTax > 0 ? `\n💸 *Death Penalty:* ${lId.split('@')[0]} lost *${deathTax}g* (5%)` : '';

  // Clear inactivity timer — battle is over
  clearBattleTimer(wId, lId);

  // ── Record match history (#12) ───────────────────────────
  const matchRecord = {
    result: 'win',
    opponent: loser.name,
    opponentElo: lElo,
    eloChange: `+${change}`,
    goldEarned: finalGold,
    turns: totalTurns || '?',
    timestamp: Date.now()
  };
  const matchRecordL = {
    result: 'loss',
    opponent: winner.name,
    opponentElo: wElo,
    eloChange: `-${loss}`,
    turns: totalTurns || '?',
    timestamp: Date.now()
  };
  if (!Array.isArray(winner.pvpHistory)) winner.pvpHistory = [];
  if (!Array.isArray(loser.pvpHistory))  loser.pvpHistory  = [];
  winner.pvpHistory.unshift(matchRecord);
  loser.pvpHistory.unshift(matchRecordL);
  if (winner.pvpHistory.length > 10) winner.pvpHistory = winner.pvpHistory.slice(0, 10);
  if (loser.pvpHistory.length  > 10) loser.pvpHistory  = loser.pvpHistory.slice(0, 10);

  try { const pa=AchievementManager.track(winner,'pvp_wins',1); if(pa.length>0){const note=AchievementManager.buildNotification(pa);if(note)try{await sock.sendMessage(wId,{text:note});}catch(e){}} } catch(e){}

  // ── Quest progress tracking (#2) ────────────────────────────
  try {
    if (QuestManager) {
      QuestManager.updateProgress(wId, { type: 'pvp_win', count: 1 });
      QuestManager.updateProgress(wId, { type: 'pvp_participate', count: 1 });
      QuestManager.updateProgress(wId, { type: 'pvp_streak', streak: winner.pvpStreak });
      QuestManager.updateProgress(lId, { type: 'pvp_participate', count: 1 });
    }
  } catch(e) {}

  // ── Battle Pass XP + Daily challenge tracking
  try { BP.addPassXP(winner,'pvp_win'); BP.addPassXP(loser,'pvp_participate'); } catch(e) {}
  try {
    const DC = require('../../rpg/utils/DailyChallenges');
    DC.trackProgress(winner, 'pvp_win', 1);
    try { const WK=require('./weekly'); WK.trackWeeklyProgress(winner,'pvp_win',1); WK.trackWeeklyProgress(winner,'pvp_streak',winner.pvpStreak||0); WK.trackWeeklyProgress(loser,'pvp_win',0); } catch(e) {}
    DC.trackProgress(winner, 'pvp_participate', 1);
    DC.trackProgress(loser,  'pvp_participate', 1);
  } catch(e) {}

  // ── Title check after PvP win ──────────────────────────────
  try { if (TitleSystem) { const nt=TitleSystem.checkAndAwardTitles(winner); if (nt.length && sock && chatId) { const tnames=nt.map(id=>TitleSystem.TITLES[id]?.display||id).join(', '); sock.sendMessage(wId, { text: `🎖️ *NEW TITLE UNLOCKED!*\n${tnames}\n\n/title to equip it!` }); } } } catch(e) {}

  // ── Guild War points for PvP win (#3) ───────────────────────
  try {
    if (GuildWar) {
      GuildWar.addWarPoints(db, wId, 5, save);   // +5 WP for winner
      GuildWar.addWarPoints(db, lId, 1, null);   // +1 WP for participating
    }
  } catch(e) {}

  // ── XP level progress for victory message ───────────────────
  const xpNeeded = Math.floor(200 * Math.pow(winner.level, 1.8));
  const xpPct = Math.min(100, Math.floor((winner.xp / xpNeeded) * 100));
  const xpProgressMsg = `\n✨ XP: +${finalXP} (Lv.${winner.level} — ${xpPct}% to next)`;

  save();

  const rankUpMsg=rankUp?`\n\n🎊 *RANK UP!*\n${rankBefore.emoji} ${rankBefore.name} → ${rankAfter.emoji} ${rankAfter.name}!`:'';
  const wClass=typeof winner.class==='object'?winner.class.name:(winner.class||'Warrior');
  const finisher=PvpExtra.getKillFinisher(wClass);
  const wTitleDisplay = TitleSystem ? TitleSystem.getTitleDisplay(winner) : '';
  const lTitleDisplay = TitleSystem ? TitleSystem.getTitleDisplay(loser) : '';

  const bKey=PvpExtra.battleKey(wId,lId);
  const betPool=PvpExtra.activeBets.get(bKey);
  let betMsg='';
  if (betPool?.bets?.length) {
    let payouts='';
    for (const bet of betPool.bets) {
      const betPlayer=db.users[bet.userId];
      if (!betPlayer) continue;
      if (bet.on===wId) { const gain=Math.floor(bet.amount*1.8); betPlayer.gold=(betPlayer.gold||0)+gain; payouts+=`💰 ${betPlayer.name} bet on winner → +${gain}g!\n`; }
      else { payouts+=`💸 ${betPlayer.name} bet on loser → lost ${bet.amount}g\n`; }
    }
    if (payouts) betMsg=`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎲 *BET RESULTS*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${payouts}`;
    PvpExtra.activeBets.delete(bKey); save();
  }

  PvpExtra.spectators.delete(bKey);

  // Persist rematches to db so they survive bot restart
  const rematchData = {opponentId:lId, chatId, timestamp:Date.now()};
  const rematchData2 = {opponentId:wId, chatId, timestamp:Date.now()};
  PvpExtra.pendingRematches.set(wId, rematchData);
  PvpExtra.pendingRematches.set(lId, rematchData2);
  if (!db.pendingRematches) db.pendingRematches = {};
  db.pendingRematches[wId] = rematchData;
  db.pendingRematches[lId] = rematchData2;
  save();
  setTimeout(()=>{
    PvpExtra.pendingRematches.delete(wId);
    PvpExtra.pendingRematches.delete(lId);
    if (db.pendingRematches) { delete db.pendingRematches[wId]; delete db.pendingRematches[lId]; }
    save();
  }, 120_000);

  const statsBlock=(wStats&&lStats)?'\n'+PvpExtra.buildStatsBlock(winner,loser,wStats,lStats,totalTurns||'?'):'';

  return sock.sendMessage(chatId,{
    text:`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏆 *BATTLE OVER!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${finisher}\n\n👑 *${winner.name}* WINS!\n💀 *${loser.name}* has been DEFEATED!${streakBonus}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *ELO CHANGES*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${rankAfter.emoji} ${winner.name}: ${wElo} → *${winner.pvpElo}* (+${change})\n${getPvpRank(loser.pvpElo).emoji} ${loser.name}: ${lElo} → *${loser.pvpElo}* (−${loss})\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎁 *REWARDS*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💰 Gold: +${finalGold}${deathTaxMsg}${xpProgressMsg}${eventBonusMsg}${rankUpMsg}${statsBlock}${betMsg}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔁 */pvp rematch* — instant rematch! (2 min)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    mentions:[wId,lId]
  });
}

// ═══════════════════════════════════════════════════════════════
// MAIN COMMAND EXPORT
// ═══════════════════════════════════════════════════════════════
module.exports = {
  name:'pvp',
  description:'⚔️ Full PvP — arenas, skill cooldowns, feints, chain combos, desperation moves & ELO',

  async execute(sock, msg, args, getDatabase, saveDatabase, sender) {
    const chatId=msg.key.remoteJid;
    const db=getDatabase();
    const player=db.users[sender];
    if (!player) return sock.sendMessage(chatId,{text:'❌ Not registered! Use /register first.'},{ quoted:msg });

    const action=args[0]?.toLowerCase();
    const pClass=getClassName(player);
    const pRank=getPvpRank(player.pvpElo);

    // ── HELP ──────────────────────────────────────────────────
    if (!action||action==='help') {
      const sp=CLASS_SPECIALS[pClass];
      const desp=PvpExtra.DESPERATION_MOVES[pClass];
      return sock.sendMessage(chatId,{
        text:`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚔️ *PVP BATTLE SYSTEM v3*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🏟️ *ARENAS:* 8 unique battlegrounds — random each match!\nVolcanic, Shadow Realm, Crystal Temple, Storm Peak...\n\n⚡ *MOMENTUM (3 bars):* Hit to build → /pvp special\n🟣 *ULTIMATE (5 bars):* Deal/take damage → LIMIT BREAK!\n🔶 *STAGGER:* 3 crits → enemy stunned!\n🛡️ *PARRY:* Guard 2× → perfect counter a special!\n🎭 *FEINT:* Fake attack → bait guards → free counter!\n🔗 *CHAIN COMBOS:* Do sequences of actions for BONUSES!\n💀 *DESPERATION:* ≤15% HP → 1-time powerful last resort!\n🔒 *SKILL COOLDOWNS:* Skills have 3-turn cooldowns in PvP!\n\n🌟 *YOUR SPECIAL: ${sp?.name||'Unknown'}*\n${sp?.desc||''}\n\n💀 *YOUR DESPERATION: ${desp?.name||'N/A'}*\n${desp?.desc||''}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📋 *COMMANDS*\n/pvp challenge @user | accept | decline\n/pvp attack | guard | taunt | feint\n/pvp use [#] | skill\n/pvp special (3⚡) | ultimate (5🟣)\n/pvp desperation (≤15% HP, once per battle)\n/pvp status | surrender\n/pvp rematch | watch | bet\n/pvp rank | leaderboard | matchups | arenas\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      },{quoted:msg});
    }

    // ── ARENAS ────────────────────────────────────────────────
    if (action==='arenas'||action==='arena') {
      let txt=`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏟️ *PVP ARENAS*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\nRandom arena selected each match!\n\n`;
      for (const a of PvpExtra.ARENAS) txt+=`${a.emoji} *${a.name}*\n${a.desc}\n\n`;
      return sock.sendMessage(chatId,{text:txt+'━━━━━━━━━━━━━━━━━━━━━━━━━━━'},{quoted:msg});
    }

    // ── COMBOS ────────────────────────────────────────────────
    if (action==='combos'||action==='combo') {
      let txt=`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔗 *CHAIN COMBOS*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\nDo these action sequences for BONUS damage!\n\n`;
      for (const c of PvpExtra.CHAIN_COMBOS) txt+=`*${c.name}*\nSequence: ${c.sequence.map(s=>s.toUpperCase()).join(' → ')}\n${c.desc}\n\n`;
      return sock.sendMessage(chatId,{text:txt+'━━━━━━━━━━━━━━━━━━━━━━━━━━━'},{quoted:msg});
    }

    // ── RANK ──────────────────────────────────────────────────
    if (action==='rank') {
      const elo=player.pvpElo||1000; const rank=getPvpRank(elo);
      const w=player.pvpWins||0; const l=player.pvpLosses||0;
      const wr=w+l>0?Math.floor(w/(w+l)*100):0;
      const idx=PVP_RANKS.findIndex(r=>r.name===rank.name); const nxt=PVP_RANKS[idx+1];
      const sp=CLASS_SPECIALS[pClass]; const desp=PvpExtra.DESPERATION_MOVES[pClass];
      return sock.sendMessage(chatId,{
        text:`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${rank.emoji} *${rank.name}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n👤 ${player.name} [${pClass}]\n⭐ ELO: *${elo}*\n${nxt?`📈 Next: ${nxt.emoji} ${nxt.name} (${nxt.minElo} ELO)\n`:''}\n📊 ${w}W / ${l}L / ${wr}% WR\n🔥 Streak: ${player.pvpStreak||0}\n\n🌟 *Special: ${sp?.name||'N/A'}*\n${sp?.desc||''}\n\n💀 *Desperation: ${desp?.name||'N/A'}*\n${desp?.desc||''}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 /pvp history — your last 10 matches`
      },{quoted:msg});
    }

    // ── HISTORY ───────────────────────────────────────────────
    if (action==='history'||action==='matches') {
      const history = Array.isArray(player.pvpHistory) ? player.pvpHistory : [];
      if (!history.length) return sock.sendMessage(chatId,{text:`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📜 *PVP MATCH HISTORY*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📭 No matches recorded yet.\nChallenge someone: /pvp challenge @user\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`},{quoted:msg});
      let txt=`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📜 *PVP MATCH HISTORY*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 ${player.name} — ${player.pvpWins||0}W/${player.pvpLosses||0}L\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      history.forEach((m,i) => {
        const icon = m.result === 'win' ? '✅' : '❌';
        const date = new Date(m.timestamp);
        const dateStr = `${date.getDate()}/${date.getMonth()+1} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
        txt += `${i+1}. ${icon} *${m.result.toUpperCase()}* vs ${m.opponent}\n`;
        txt += `   ELO: ${m.eloChange} | Turns: ${m.turns}${m.goldEarned?` | +${m.goldEarned}g`:''}\n`;
        txt += `   _${dateStr}_\n\n`;
      });
      txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      return sock.sendMessage(chatId,{text:txt},{quoted:msg});
    }

    // ── LEADERBOARD ───────────────────────────────────────────
    if (action==='leaderboard'||action==='lb') {
      const players=Object.values(db.users).filter(p=>p.pvpWins>0).sort((a,b)=>(b.pvpElo||1000)-(a.pvpElo||1000)).slice(0,10);
      let txt=`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏆 *PVP LEADERBOARD*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      players.forEach((p,i)=>{const r=getPvpRank(p.pvpElo);const cl=getClassName(p);txt+=`${i+1}. ${r.emoji} *${p.name}* [${cl}]\n   ⭐${p.pvpElo||1000} | ✅${p.pvpWins||0} ❌${p.pvpLosses||0} 🔥${p.pvpStreak||0}\n`;});
      if (!players.length) txt+='No ranked players yet!\n';
      return sock.sendMessage(chatId,{text:txt+'━━━━━━━━━━━━━━━━━━━━━━━━━━━'},{quoted:msg});
    }

    // ── MATCHUPS ──────────────────────────────────────────────
    if (action==='matchups'||action==='matchup') {
      const m=CLASS_MATCHUPS[pClass]; const sp=CLASS_SPECIALS[pClass];
      if (!m) return sock.sendMessage(chatId,{text:`No matchup data for ${pClass}.`},{quoted:msg});
      return sock.sendMessage(chatId,{
        text:`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚔️ *${pClass}* — CLASS MATCHUPS\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n✅ *Strong vs (+15%):*\n${m.strongVs.join(', ')}\n\n❌ *Weak vs (−12%):*\n${m.weakVs.join(', ')}\n\n🌟 *SPECIAL: ${sp?.name||'N/A'}*\n${sp?.desc||''}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      },{quoted:msg});
    }

    // ── CHALLENGE ─────────────────────────────────────────────
    if (action==='challenge') {
      // Load any persisted challenges from db on first use
      _loadChallengesFromDb(db);
      const mentioned=msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (!mentioned) return sock.sendMessage(chatId,{text:'❌ Tag someone!\n/pvp challenge @user'},{quoted:msg});
      if (mentioned===sender) return sock.sendMessage(chatId,{text:'❌ Cannot challenge yourself!'},{quoted:msg});
      const opp=db.users[mentioned];
      if (!opp) return sock.sendMessage(chatId,{text:'❌ That player is not registered!'},{quoted:msg});
      if (player.pvpBattle) return sock.sendMessage(chatId,{text:'❌ Already in a PVP battle!'},{quoted:msg});
      if (opp.pvpBattle) return sock.sendMessage(chatId,{text:'❌ That player is already in a battle!'},{quoted:msg});
      if (player.stats.hp<player.stats.maxHp*0.5) return sock.sendMessage(chatId,{text:'❌ Need 50%+ HP! Use /heal first.'},{quoted:msg});
      if (opp.stats.hp<opp.stats.maxHp*0.5) return sock.sendMessage(chatId,{text:'❌ Opponent needs to heal first!'},{quoted:msg});

      const oClass=getClassName(opp); const oRank=getPvpRank(opp.pvpElo);
      const mySp=CLASS_SPECIALS[pClass]; const opSp=CLASS_SPECIALS[oClass];
      const myDesp=PvpExtra.DESPERATION_MOVES[pClass]; const opDesp=PvpExtra.DESPERATION_MOVES[oClass];
      const adv=getMatchup(pClass,oClass);
      const previewArena=PvpExtra.rollArena();

      const challengeData = {challengerId:sender,chatId,timestamp:Date.now()};
      pendingChallenges.set(mentioned, challengeData);
      _saveChallenge(db, mentioned, challengeData, saveDatabase);

      setTimeout(async ()=>{
        if(pendingChallenges.has(mentioned)){
          _deleteChallenge(db, mentioned, saveDatabase);
          const challenger=db.users[sender];
          await sock.sendMessage(chatId,{
            text:`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⏰ *CHALLENGE EXPIRED*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n@${mentioned.split('@')[0]} did not respond in time.\n❌ *${challenger?.name||'Challenger'}*'s challenge has been cancelled.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            mentions:[mentioned,sender]
          });
        }
      },60000);

      return sock.sendMessage(chatId,{
        text:`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚔️ *PVP CHALLENGE!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${pRank.emoji} *${player.name}* [${pClass} Lv.${player.level}]\n🌟 Special: *${mySp?.name||'?'}*\n💀 Desperation: *${myDesp?.name||'?'}*\n\n         ⚔️ VS ⚔️\n\n${oRank.emoji} *${opp.name}* [${oClass} Lv.${opp.level}]\n🌟 Special: *${opSp?.name||'?'}*\n💀 Desperation: *${opDesp?.name||'?'}*\n\n${adv.mult>1?`⚡ ${player.name} has *CLASS ADVANTAGE!*\n`:adv.mult<1?`⚠️ ${player.name} has class disadvantage\n`:''}\n${previewArena.emoji} *Arena Preview: ${previewArena.name}*\n${previewArena.desc}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n@${mentioned.split('@')[0]} — *60 seconds!*\n✅ /pvp accept  ❌ /pvp decline\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        mentions:[mentioned]
      },{quoted:msg});
    }

    // ── ACCEPT ────────────────────────────────────────────────
    if (action==='accept') {
      _loadChallengesFromDb(db);
      const challenge=pendingChallenges.get(sender);
      if (!challenge) return sock.sendMessage(chatId,{text:'❌ No pending challenges!'},{quoted:msg});
      const challenger=db.users[challenge.challengerId];
      if (!challenger) { _deleteChallenge(db, sender, saveDatabase); return sock.sendMessage(chatId,{text:'❌ Challenger not found!'},{quoted:msg}); }
      _deleteChallenge(db, sender, saveDatabase);

      if (!player.statusEffects) player.statusEffects=[];
      if (!challenger.statusEffects) challenger.statusEffects=[];
      if (!player.buffs) player.buffs=[];
      if (!challenger.buffs) challenger.buffs=[];

      // Roll arena for this battle
      const arena=PvpExtra.rollArena();

      player.pvpBattle=initBattleState(challenge.challengerId,chatId);
      challenger.pvpBattle=initBattleState(sender,chatId);

      // Assign arena to both
      player.pvpBattle.arena=arena;
      challenger.pvpBattle.arena=arena;

      // Init skill cooldowns
      player.pvpBattle.skillCooldowns=PvpExtra.initSkillCooldowns(player);
      challenger.pvpBattle.skillCooldowns=PvpExtra.initSkillCooldowns(challenger);

      // ── Apply pet passive stat bonuses ──────────────────────
      // These are stored on pvpBattle so they can be removed when battle ends
      const applyPetPassive = (pl, plId) => {
        try {
          const pb = PetManager.getPetBattleBonus(plId);
          if (pb?.bonuses) {
            pl.pvpBattle.petPassiveAtk = pb.bonuses.atk || 0;
            pl.pvpBattle.petPassiveDef = pb.bonuses.def || 0;
            pl.pvpBattle.petPassiveSpd = pb.bonuses.spd || 0;
            // Apply to live stats for this battle
            if (pb.bonuses.atk) pl.stats.atk = (pl.stats.atk||0) + pb.bonuses.atk;
            if (pb.bonuses.def) pl.stats.def = (pl.stats.def||0) + pb.bonuses.def;
            if (pb.bonuses.spd) pl.stats.speed = (pl.stats.speed||0) + pb.bonuses.spd;
            pl.pvpBattle.petName = pb.pet ? `${pb.pet.emoji} ${pb.pet.nickname||pb.pet.name}` : null;
          }
        } catch(e) {}
      };
      applyPetPassive(player, sender);
      applyPetPassive(challenger, challenge.challengerId);

      saveDatabase();

      // Start inactivity timer for this battle
      setBattleInactivityTimer(sock, db, saveDatabase, sender, challenge.challengerId, chatId);

      const cClass=getClassName(challenger); const cRank=getPvpRank(challenger.pvpElo);
      const cSp=CLASS_SPECIALS[cClass]; const mySp=CLASS_SPECIALS[pClass];
      const cDesp=PvpExtra.DESPERATION_MOVES[cClass]; const myDesp=PvpExtra.DESPERATION_MOVES[pClass];
      const adv1=getMatchup(pClass,cClass); const adv2=getMatchup(cClass,pClass);

      const cPetInfo = challenger.pvpBattle.petName ? `\n🐾 Pet: *${challenger.pvpBattle.petName}* (+${challenger.pvpBattle.petPassiveAtk||0}ATK/+${challenger.pvpBattle.petPassiveDef||0}DEF)` : '';
      const pPetInfo = player.pvpBattle.petName ? `\n🐾 Pet: *${player.pvpBattle.petName}* (+${player.pvpBattle.petPassiveAtk||0}ATK/+${player.pvpBattle.petPassiveDef||0}DEF)` : '';
      const cTitleInfo = challenger.equippedTitle && TitleSystem ? `\n🎖️ *${TitleSystem.TITLES[challenger.equippedTitle]?.display||''}*` : '';
      const pTitleInfo = player.equippedTitle && TitleSystem ? `\n🎖️ *${TitleSystem.TITLES[player.equippedTitle]?.display||''}*` : '';

      return sock.sendMessage(chatId,{
        text:`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚔️ *BATTLE START!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${arena.emoji} *ARENA: ${arena.name}*\n${arena.desc}\n"${arena.flavor}"\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${cRank.emoji} *${challenger.name}* [${cClass} Lv.${challenger.level}]\n⭐ ELO: ${challenger.pvpElo||1000}\n❤️ ${challenger.stats.hp}/${challenger.stats.maxHp}${cPetInfo}${cTitleInfo}\n🌟 *${cSp?.name||'?'}* — ${cSp?.desc||''}\n💀 *${cDesp?.name||'?'}* — ${cDesp?.desc||''}\n${adv2.mult>1?'⚡ '+adv2.msg:adv2.mult<1?'⚠️ '+adv2.msg:''}\n\n         ⚔️ VS ⚔️\n\n${pRank.emoji} *${player.name}* [${pClass} Lv.${player.level}]\n⭐ ELO: ${player.pvpElo||1000}\n❤️ ${player.stats.hp}/${player.stats.maxHp}${pPetInfo}${pTitleInfo}\n🌟 *${mySp?.name||'?'}* — ${mySp?.desc||''}\n💀 *${myDesp?.name||'?'}* — ${myDesp?.desc||''}\n${adv1.mult>1?'⚡ '+adv1.msg:adv1.mult<1?'⚠️ '+adv1.msg:''}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 *NEW! This battle:*\n⚡ Build 3 Momentum → /pvp special\n🟣 Build 5 Ultimate → /pvp ultimate\n🎭 /pvp feint — bait guards for free counters!\n💀 At ≤15% HP → /pvp desperation\n🔗 Chain actions for COMBO bonuses!\n🔒 Skills have 3-turn cooldowns!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎮 *TURN 1* — Both choose!\n@${challenge.challengerId.split('@')[0]} ← pick!\n@${sender.split('@')[0]} ← pick!\n\n/pvp attack | guard | taunt | feint\n/pvp use [#] | skill | special | ultimate`,
        mentions:[challenge.challengerId,sender]
      },{quoted:msg});
    }

    // ── DECLINE ───────────────────────────────────────────────
    if (action==='decline') {
      _loadChallengesFromDb(db);
      const challenge=pendingChallenges.get(sender);
      if (!challenge) return sock.sendMessage(chatId,{text:'❌ No pending challenges!'},{quoted:msg});
      _deleteChallenge(db, sender, saveDatabase);
      return sock.sendMessage(chatId,{text:`❌ *${player.name}* declined the challenge.`},{quoted:msg});
    }

    // ── STATUS ────────────────────────────────────────────────
    if (action==='status') {
      if (!player.pvpBattle) return sock.sendMessage(chatId,{text:'❌ Not in a PVP battle!'},{quoted:msg});
      const opp=db.users[player.pvpBattle.opponentId];
      if (!opp) return sock.sendMessage(chatId,{text:'❌ Opponent not found!'},{quoted:msg});
      const oClass=getClassName(opp); const ps=player.pvpBattle; const os=opp.pvpBattle;
      const arena=ps.arena;
      return sock.sendMessage(chatId,{
        text:`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${arena?arena.emoji+' '+arena.name+'\n':''}TURN ${ps.turnNumber} | ${ps.pendingAction?'✅ Action locked':'⏳ Awaiting'}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${getThreatIcon(player.stats.hp/player.stats.maxHp)} *${player.name}* [${pClass}]\n${BarSystem.getHPBar(player.stats.hp,player.stats.maxHp)}\n❤️ ${player.stats.hp}/${player.stats.maxHp}\n⚡${getMomentumBar(ps.momentum)} 🔶${getStaggerBar(ps.stagger)} 🟣${getUltiBar(ps.ultiGauge)}\n${ps.skillCooldowns?.some(cd=>cd>0)?`🔒 Skills: ${getCdBar(ps.skillCooldowns)}\n`:''}${ps.rageMode?'🔥 RAGE MODE\n':''}${player.stats.hp/player.stats.maxHp<=0.15&&!ps.desperationUsed?'💀 DESPERATION READY!\n':''}\n${getThreatIcon(opp.stats.hp/opp.stats.maxHp)} *${opp.name}* [${oClass}]\n${BarSystem.getHPBar(opp.stats.hp,opp.stats.maxHp)}\n❤️ ${opp.stats.hp}/${opp.stats.maxHp}\n⚡${getMomentumBar(os?.momentum)} 🔶${getStaggerBar(os?.stagger)} 🟣${getUltiBar(os?.ultiGauge)}\n${os?.rageMode?'🔥 RAGE MODE\n':''}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      },{quoted:msg});
    }

    // ── SKILLS MENU ───────────────────────────────────────────
    if (action==='skill'||action==='skills') {
      if (!player.pvpBattle) return sock.sendMessage(chatId,{text:'❌ Not in a PVP battle!'},{quoted:msg});
      const ps=player.pvpBattle;
      let txt=`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚡ *YOUR SKILLS*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${player.energyColor||'💙'} ${player.stats.energy}/${player.stats.maxEnergy}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      if (!player.skills?.active?.length) txt+='No active skills!\n';
      else player.skills.active.forEach((s,i)=>{
        const ready=PvpExtra.isSkillReady(ps.skillCooldowns||[],i);
        const cdLeft=(ps.skillCooldowns||[])[i]||0;
        const enOk=player.stats.energy>=(s.energyCost||20);
        const icon=!ready?`🔒${cdLeft}t`:enOk?'✅':'❌';
        txt+=`${i+1}. ${icon} *${s.name}* [Lv.${s.level||1}]\n   💥 ${s.damage} dmg | ${s.energyCost||20} ${player.energyType||'Energy'}\n   ${s.effect||''}\n\n`;
      });
      const sp=CLASS_SPECIALS[pClass]; const desp=PvpExtra.DESPERATION_MOVES[pClass];
      const canS=(ps.momentum||0)>=3; const canU=ps.ultiReady;
      const canDesp=player.stats.hp/player.stats.maxHp<=0.15&&!ps.desperationUsed;
      txt+=`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🌟 *SPECIAL: ${sp?.name||'N/A'}*\n${sp?.desc||''}\n${canS?'✅ Ready! /pvp special':`⚡ Need 3 momentum (${getMomentumBar(ps.momentum)})`}\n\n🟣 *ULTIMATE*\n${canU?'✅ CHARGED! /pvp ultimate':`🟣 Need 5 bars (${getUltiBar(ps.ultiGauge)})`}\n\n💀 *DESPERATION: ${desp?.name||'N/A'}*\n${desp?.desc||''}\n${canDesp?'✅ UNLOCKED! /pvp desperation':player.stats.hp/player.stats.maxHp>0.15?'🔒 Unlock at ≤15% HP':'❌ Already used'}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      return sock.sendMessage(chatId,{text:txt},{quoted:msg});
    }

    // ── IN-BATTLE ACTIONS ─────────────────────────────────────
    const battleActions=['attack','guard','taunt','feint','use','special','ultimate','desperation','surrender'];
    if (battleActions.includes(action)) {
      if (!player.pvpBattle) return sock.sendMessage(chatId,{text:'❌ Not in a PVP battle!'},{quoted:msg});
      const battle=player.pvpBattle;
      if (battle.pendingAction) return sock.sendMessage(chatId,{text:`✅ Action locked in!\n⏳ Waiting for ${db.users[battle.opponentId]?.name||'opponent'}...`},{quoted:msg});
      const opp=db.users[battle.opponentId];
      if (!opp) { player.pvpBattle=null; saveDatabase(); return sock.sendMessage(chatId,{text:'❌ Opponent disconnected.'},{quoted:msg}); }

      if (action==='surrender') {
        clearBattleTimer(sender, battle.opponentId);
        const eloChange=Math.floor(calcEloChange(opp.pvpElo||1000,player.pvpElo||1000)*0.6);
        opp.pvpElo=(opp.pvpElo||1000)+eloChange; opp.pvpWins=(opp.pvpWins||0)+1;
        opp.gold=(opp.gold||0)+80; opp.pvpBattle=null; opp.statusEffects=[]; opp.buffs=[];
        player.pvpBattle=null; player.pvpLosses=(player.pvpLosses||0)+1; player.pvpStreak=0;
        player.pvpElo=Math.max(100,(player.pvpElo||1000)-Math.floor(eloChange*0.8));
        player.stats.hp=Math.floor(player.stats.maxHp*0.3); player.statusEffects=[]; player.buffs=[];
        saveDatabase();
        // Notify the loser privately about their low HP
        try { await sock.sendMessage(sender, { text: `🏳️ You surrendered to *${opp.name}*.\n\n⚠️ Your HP is at *${player.stats.hp}/${player.stats.maxHp}* (30%).\n💊 Use */heal* before challenging again!` }); } catch(e) {}
        return sock.sendMessage(chatId,{text:`🏳️ *${player.name}* surrenders!\n🏆 *${opp.name}* wins by forfeit!\n\n💡 @${sender.split('@')[0]} — your HP is low! Use */heal* to recover.`,mentions:[sender]},{quoted:msg});
      }

      if (action==='use') {
        const idx=parseInt(args[1])-1;
        if (isNaN(idx)||idx<0) return sock.sendMessage(chatId,{text:'❌ Specify skill number!\n/pvp use 1'},{quoted:msg});
        const skill=player.skills?.active?.[idx];
        if (!skill) return sock.sendMessage(chatId,{text:`❌ No skill #${idx+1}.`},{quoted:msg});
        // Cooldown check at command level
        if (battle.skillCooldowns && !PvpExtra.isSkillReady(battle.skillCooldowns,idx)) {
          const cdLeft=battle.skillCooldowns[idx];
          return sock.sendMessage(chatId,{text:`🔒 *${skill.name}* is on cooldown for *${cdLeft} more turns!*\nUse /pvp skill to view all cooldowns.`},{quoted:msg});
        }
        if (player.stats.energy<(skill.energyCost||20)) return sock.sendMessage(chatId,{text:`❌ Not enough ${player.energyType||'Energy'}!`},{quoted:msg});
        battle.pendingAction={type:'skill',skillIndex:idx};

      } else if (action==='special') {
        if ((battle.momentum||0)<3) return sock.sendMessage(chatId,{text:`⚡ Need 3 Momentum!\nCurrent: ${getMomentumBar(battle.momentum)}`},{quoted:msg});
        battle.momentum-=3;
        battle.pendingAction={type:'special'};

      } else if (action==='ultimate') {
        if (!battle.ultiReady) return sock.sendMessage(chatId,{text:`🟣 Ultimate not ready!\n${getUltiBar(battle.ultiGauge)}`},{quoted:msg});
        battle.pendingAction={type:'special',_isUltimate:true};

      } else if (action==='desperation') {
        const hpPct=player.stats.hp/player.stats.maxHp;
        if (hpPct>0.15) return sock.sendMessage(chatId,{text:`💀 Desperation unlocks at ≤15% HP!\nYour HP: ${Math.floor(hpPct*100)}%`},{quoted:msg});
        if (battle.desperationUsed) return sock.sendMessage(chatId,{text:'❌ Desperation already used this battle!'},{quoted:msg});
        battle.pendingAction={type:'desperation'};

      } else {
        battle.pendingAction={type:action};
      }

      saveDatabase();

      // Reset inactivity timer — a player just acted, give the opponent time to respond
      setBattleInactivityTimer(sock, db, saveDatabase, sender, battle.opponentId, chatId);

      if (opp.pvpBattle?.pendingAction) {
        // Both acted — clear timer, let executeBothActions handle the turn
        clearBattleTimer(sender, battle.opponentId);
        return executeBothActions(sock,chatId,player,opp,db,saveDatabase,sender);
      }

      const icons={attack:'⚔️',guard:'🛡️',taunt:'😤',feint:'🎭',special:'🌟',ultimate:'🟣',desperation:'💀'};
      return sock.sendMessage(chatId,{
        text:`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${icons[action]||'✅'} *${action.toUpperCase()} LOCKED IN!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⏳ Waiting for *${opp.name}*...\n\n💡 /pvp status — check board\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      },{quoted:msg});
    }

    // ── BET ───────────────────────────────────────────────────
    if (action==='bet') {
      const amount=parseInt(args[1]); const targetName=args[2]?.toLowerCase();
      if (isNaN(amount)||amount<10) return sock.sendMessage(chatId,{text:'❌ Usage: /pvp bet [amount] [name]\nMin: 10g'},{quoted:msg});
      if ((player.gold||0)<amount) return sock.sendMessage(chatId,{text:`❌ Not enough gold!`},{quoted:msg});
      if (!targetName) return sock.sendMessage(chatId,{text:'❌ Specify who to bet on!'},{quoted:msg});

      const allBattles=Object.entries(db.users).filter(([id,p])=>p.pvpBattle).map(([id,p])=>({id,p}));
      let betTarget=null,betBattleKey=null;
      for (const {id,p} of allBattles) {
        if ((p.name||'').toLowerCase().includes(targetName)) {
          betTarget=id; betBattleKey=PvpExtra.battleKey(id,p.pvpBattle.opponentId); break;
        }
      }
      if (!betTarget) return sock.sendMessage(chatId,{text:`❌ No active battle for "${args[2]}"!`},{quoted:msg});
      if (betTarget===sender) return sock.sendMessage(chatId,{text:'❌ Cannot bet on yourself!'},{quoted:msg});

      if (!PvpExtra.activeBets.has(betBattleKey)) PvpExtra.activeBets.set(betBattleKey,{bets:[]});
      const pool=PvpExtra.activeBets.get(betBattleKey);
      if (pool.bets.find(b=>b.userId===sender)) return sock.sendMessage(chatId,{text:'❌ Already bet on this fight!'},{quoted:msg});

      player.gold=(player.gold||0)-amount;
      pool.bets.push({userId:sender,amount,on:betTarget});
      saveDatabase();
      return sock.sendMessage(chatId,{text:`🎲 *BET PLACED!*\n💰 ${amount}g on *${db.users[betTarget]?.name||targetName}*\nPays ×1.8 if they win!`},{quoted:msg});
    }

    // ── REMATCH ───────────────────────────────────────────────
    if (action==='rematch') {
      if (player.pvpBattle) return sock.sendMessage(chatId,{text:'❌ Already in a battle!'},{quoted:msg});
      // Load from db if not in memory (survived restart)
      let rm = PvpExtra.pendingRematches.get(sender);
      if (!rm && db.pendingRematches?.[sender]) {
        rm = db.pendingRematches[sender];
        // Validate it's still within 2 min window
        if (Date.now() - rm.timestamp > 120_000) { rm = null; delete db.pendingRematches[sender]; saveDatabase(); }
        else PvpExtra.pendingRematches.set(sender, rm);
      }
      if (!rm) return sock.sendMessage(chatId,{text:'❌ No rematch available! (expires 2 min after battle)'},{quoted:msg});
      const opp=db.users[rm.opponentId];
      if (!opp||opp.pvpBattle) return sock.sendMessage(chatId,{text:'❌ Opponent unavailable!'},{quoted:msg});
      if (player.stats.hp<player.stats.maxHp*0.3) return sock.sendMessage(chatId,{text:'❌ Need 30%+ HP! Use /heal.'},{quoted:msg});

      PvpExtra.pendingRematches.delete(sender); PvpExtra.pendingRematches.delete(rm.opponentId);
      if (db.pendingRematches) { delete db.pendingRematches[sender]; delete db.pendingRematches[rm.opponentId]; }
      if (!player.statusEffects) player.statusEffects=[]; if (!opp.statusEffects) opp.statusEffects=[];
      if (!player.buffs) player.buffs=[]; if (!opp.buffs) opp.buffs=[];

      const arena=PvpExtra.rollArena();
      player.pvpBattle=initBattleState(rm.opponentId,chatId); opp.pvpBattle=initBattleState(sender,chatId);
      player.pvpBattle.arena=arena; opp.pvpBattle.arena=arena;
      player.pvpBattle.skillCooldowns=PvpExtra.initSkillCooldowns(player);
      opp.pvpBattle.skillCooldowns=PvpExtra.initSkillCooldowns(opp);
      saveDatabase();

      const oClass=getClassName(opp); const oRank=getPvpRank(opp.pvpElo);
      return sock.sendMessage(chatId,{
        text:`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔁 *REMATCH!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${arena.emoji} *Arena: ${arena.name}*\n${arena.desc}\n\n${pRank.emoji} *${player.name}* [${pClass}] vs ${oRank.emoji} *${opp.name}* [${oClass}]\n\n🎮 *TURN 1!*\n@${sender.split('@')[0]} & @${rm.opponentId.split('@')[0]}\n\n/pvp attack | guard | taunt | feint\n/pvp use [#] | skill | special | ultimate`,
        mentions:[sender,rm.opponentId]
      },{quoted:msg});
    }

    // ── WATCH ─────────────────────────────────────────────────
    if (action==='watch') {
      if (player.pvpBattle) return sock.sendMessage(chatId,{text:'❌ Cannot spectate while in battle!'},{quoted:msg});
      const activeFights=Object.entries(db.users).filter(([id,p])=>p.pvpBattle&&p.pvpBattle.opponentId>id).slice(0,5);
      if (!activeFights.length) return sock.sendMessage(chatId,{text:'👁️ No active battles!\nChallenge someone: /pvp challenge @user'},{quoted:msg});

      const targetName=args[1]?.toLowerCase();
      let watchId=null,watchOppId=null;
      if (targetName) {
        for (const [id,p] of Object.entries(db.users)) {
          if (p.pvpBattle&&(p.name||'').toLowerCase().includes(targetName)){watchId=id;watchOppId=p.pvpBattle.opponentId;break;}
        }
        if (!watchId) return sock.sendMessage(chatId,{text:`❌ No battle found for "${args[1]}"`},{quoted:msg});
      } else {
        watchId=activeFights[0][0]; watchOppId=activeFights[0][1].pvpBattle.opponentId;
      }

      const wKey=PvpExtra.battleKey(watchId,watchOppId);
      if (!PvpExtra.spectators.has(wKey)) PvpExtra.spectators.set(wKey,new Set());
      PvpExtra.spectators.get(wKey).add(sender);

      const p1w=db.users[watchId]; const p2w=db.users[watchOppId];
      const arena=p1w.pvpBattle?.arena;
      let listTxt=`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👁️ *SPECTATING*\n${arena?arena.emoji+' '+arena.name+'\n':''}━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      listTxt+=`${getThreatIcon(p1w.stats.hp/p1w.stats.maxHp)} *${p1w.name}* [${getClassName(p1w)}] Turn ${p1w.pvpBattle?.turnNumber||1}\n${BarSystem.getHPBar(p1w.stats.hp,p1w.stats.maxHp)} ${p1w.stats.hp}/${p1w.stats.maxHp}\n\n`;
      listTxt+=`${getThreatIcon(p2w.stats.hp/p2w.stats.maxHp)} *${p2w.name}* [${getClassName(p2w)}]\n${BarSystem.getHPBar(p2w.stats.hp,p2w.stats.maxHp)} ${p2w.stats.hp}/${p2w.stats.maxHp}\n\n`;
      listTxt+=`💡 You'll see updates as they happen!\n🎲 /pvp bet [amount] ${p1w.name} — bet on them!\n`;
      return sock.sendMessage(chatId,{text:listTxt+'━━━━━━━━━━━━━━━━━━━━━━━━━━━'},{quoted:msg});
    }

    return sock.sendMessage(chatId,{text:'❌ Unknown PVP command.\nUse /pvp help.'},{quoted:msg});
  }
};
