const SkillDescriptions = require('../../rpg/utils/SkillDescriptions');
const SkillManager = require('../../rpg/utils/SkillManager');

// ═══════════════════════════════════════════════════════════════
// SKILL SLOT SYSTEM
// - Up to 5 equipped (7 for Scholars)
// - All unlocked skills stored in "library" (player.availableSkills)
// - /skills swap [equipped#] [library#] — instant hotswap
// - /skills upgrade [#] — spend gold to level a skill (max Lv 5)
// - /skills info [name or #] — full details
// - Skill level visually shown: ⬜⬜⬜⬜⬜ → 🟦🟦🟦⬜⬜ etc
// ═══════════════════════════════════════════════════════════════

const SLOT_FILLS = ['⬜','🟦','🟩','🟨','🟧','🟥'];

function skillLevelBar(level, maxLevel=5) {
  const filled = SLOT_FILLS[Math.min(level, 5)];
  return filled.repeat(level) + '⬜'.repeat(Math.max(0, maxLevel-level));
}

function skillUpgradeCost(currentLevel) {
  // Cost to upgrade FROM this level to next: lv1→2, lv2→3, lv3→4, lv4→5
  // Balanced — early upgrades affordable, max level is a real grind
  const costs = [15000, 50000, 120000, 300000];
  return costs[currentLevel - 1] ?? null; // null = already max level
}

function applySkillLevelBonus(skill) {
  // Each level: +8% flat damage, -3 energy cost, -1 cooldown (floored)
  const lv = skill.level || 1;
  const dmgMult = 1 + (lv - 1) * 0.08;
  const costReduction = (lv - 1) * 3;
  const cdReduction = Math.floor((lv - 1) * 0.5);
  return {
    damage: Math.floor((skill.damage || 0) * dmgMult),
    energyCost: Math.max(5, (skill.energyCost || 20) - costReduction),
    cooldown: Math.max(0, (skill.cooldown || 0) - cdReduction),
    dmgMult, costReduction, cdReduction
  };
}

function getMaxSlots(player) {
  return player.maxSkillSlots || 5;
}

function fmtSkillLine(skill, idx, player, compact=false) {
  const lv = skill.level || 1;
  const max = skill.maxLevel || 5;
  const bonuses = applySkillLevelBonus(skill);
  const bar = skillLevelBar(lv, max);
  const prefix = idx !== undefined ? `${idx+1}. ` : '';
  if (compact) {
    return `${prefix}*${skill.name}* [Lv${lv}/${max}] ${bar}\n   💥${bonuses.damage} | ${player.energyColor||'💙'}${bonuses.energyCost} | ⏰${bonuses.cooldown}t\n`;
  }
  return `${prefix}*${skill.name}*\nLv ${lv}/${max}: ${bar}\n💥 DMG: ${bonuses.damage} | ${player.energyColor||'💙'} ${bonuses.energyCost} | ⏰ ${bonuses.cooldown}t\n`;
}

module.exports = {
  name: 'skills',
  description: '⚔️ Manage your skill loadout — view, swap, upgrade, and level skills',

  async execute(sock, msg, args, getDatabase, saveDatabase, sender) {
    const chatId = msg.key.remoteJid;
    const db = getDatabase();
    const player = db.users[sender];
    if (!player) return sock.sendMessage(chatId, { text: '❌ Not registered!' }, { quoted: msg });

    const action = args[0]?.toLowerCase();
    const className = typeof player.class==='object' ? player.class.name : player.class;
    const maxSlots = getMaxSlots(player);
    const equipped = player.skills?.active || [];
    const library  = player.availableSkills || [];

    // ── MAIN MENU ─────────────────────────────────────────────
    if (!action) {
      let txt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚔️ SKILL LOADOUT
━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 ${player.name} [${className} Lv.${player.level}]
${player.energyColor||'💙'} ${player.stats.energy}/${player.stats.maxEnergy} ${player.energyType||'Energy'}
🎯 Slots: ${equipped.length}/${maxSlots}${player.origin==='scholar'?' (Scholar +2)':''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔮 EQUIPPED SKILLS
━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      if (!equipped.length) {
        txt += '(None equipped)\n';
      } else {
        equipped.forEach((s, i) => { txt += fmtSkillLine(s, i, player, false) + '\n'; });
      }

      if (library.length) {
        txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📚 SKILL LIBRARY (${library.length})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        library.forEach((s, i) => { txt += fmtSkillLine(s, i, player, true); });
      }

      const nextUnlock = Math.ceil((player.level + 1) / 5) * 5;
      txt += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 COMMANDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━
/skills swap [slot#] [library#] — Hotswap skill
/skills equip [library#] — Add to empty slot
/skills remove [slot#] — Unequip to library
/skills upgrade [slot#] — Level up a skill (gold)
/skills info [slot# or name] — Full skill details
/skills passives — View passive abilities
━━━━━━━━━━━━━━━━━━━━━━━━━━━
${nextUnlock<=90?`💡 Next skill unlocks at Lv *${nextUnlock}*`:''}\n${player.pendingSkillChoice?'🌟 SKILL CHOICE PENDING! Use /choose':''}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
    }

    // ── PASSIVES ──────────────────────────────────────────────
    if (action === 'passives') {
      const passives = player.skills?.passive || [];
      let txt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚡ PASSIVE ABILITIES\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      if (!passives.length) txt += '(None yet)\n';
      else passives.forEach(p => { txt += `${p.isOrigin?'🌟':'⚡'} *${p.name}*\n   ${p.effect}\n\n`; });
      txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\nPassives are ALWAYS active.`;
      return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
    }

    // ── INFO ──────────────────────────────────────────────────
    if (action === 'info') {
      const query = args.slice(1).join(' ');
      const idx = parseInt(query) - 1;
      let skill = null;
      if (!isNaN(idx) && idx >= 0) {
        skill = equipped[idx] || library[idx - equipped.length];
      } else {
        skill = [...equipped, ...library].find(s => s.name.toLowerCase().includes(query.toLowerCase()));
      }
      if (!skill) return sock.sendMessage(chatId, { text: `❌ Skill not found!\nUse /skills to see your skills.` }, { quoted: msg });
      const info = SkillDescriptions.getSkillDescription(className, skill.name);
      const bonuses = applySkillLevelBonus(skill);
      const lv = skill.level || 1;
      const max = skill.maxLevel || 5;
      const bar = skillLevelBar(lv, max);
      const upgradeCost = lv < max ? skillUpgradeCost(lv) : null;
      let txt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔮 *${skill.name}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      txt += `${info?.description || 'A powerful skill.'}\n\n`;
      txt += `📊 STATS (Level ${lv}/${max})\n${bar}\n`;
      txt += `💥 Damage: ${bonuses.damage}\n`;
      txt += `${player.energyColor||'💙'} Cost: ${bonuses.energyCost} ${player.energyType||'Energy'}\n`;
      txt += `⏰ Cooldown: ${bonuses.cooldown}t\n`;
      if (lv > 1) txt += `⬆️ Level bonus: +${Math.round((bonuses.dmgMult-1)*100)}% DMG, -${bonuses.costReduction} cost\n`;
      if (info?.effect) txt += `\n💡 EFFECTS:\n${info.effect}\n`;
      if (info?.animation) txt += `\n🎬 ANIMATION:\n${info.animation.split('\n')[0]}\n`;
      if (upgradeCost) txt += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⬆️ Upgrade to Lv ${lv+1}: 💰 ${upgradeCost.toLocaleString()} gold\n/skills upgrade [slot#]\n`;
      txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
    }

    // ── UPGRADE (Level up a skill) ─────────────────────────────
    if (action === 'upgrade') {
      const idx = parseInt(args[1]) - 1;
      if (isNaN(idx) || idx < 0) return sock.sendMessage(chatId, { text: `❌ Specify slot number!\n/skills upgrade [#]` }, { quoted: msg });
      const skill = equipped[idx];
      if (!skill) return sock.sendMessage(chatId, { text: `❌ No skill in slot ${idx+1}!` }, { quoted: msg });
      const lv = skill.level || 1;
      const max = skill.maxLevel || 5;
      if (lv >= max) return sock.sendMessage(chatId, { text: `❌ *${skill.name}* is already max level (${max})!` }, { quoted: msg });
      const cost = skillUpgradeCost(lv);
      if ((player.gold||0) < cost) return sock.sendMessage(chatId, { text: `❌ Not enough gold!\nNeed: 💰 ${cost.toLocaleString()}\nHave: 💰 ${(player.gold||0).toLocaleString()}` }, { quoted: msg });
      player.gold -= cost;
      skill.level = lv + 1;
      const newBonuses = applySkillLevelBonus(skill);
      const bar = skillLevelBar(skill.level, max);
      saveDatabase();
      return sock.sendMessage(chatId, {
        text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⬆️ SKILL UPGRADED!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🔮 *${skill.name}*\nLevel ${lv} → *${skill.level}/${max}*\n${bar}\n\n💥 DMG: +${Math.round((newBonuses.dmgMult-1)*100)}% boost\n${player.energyColor||'💙'} Cost: -${newBonuses.costReduction}\n💰 Spent: ${cost.toLocaleString()} gold\n💰 Remaining: ${player.gold.toLocaleString()}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      }, { quoted: msg });
    }

    // ── SWAP (Equipped ↔ Library hotswap) ─────────────────────
    if (action === 'swap') {
      const slotIdx = parseInt(args[1]) - 1;
      const libIdx  = parseInt(args[2]) - 1;
      if (isNaN(slotIdx) || isNaN(libIdx)) {
        return sock.sendMessage(chatId, { text: `❌ Usage: /skills swap [equipped#] [library#]\nExample: /skills swap 1 3` }, { quoted: msg });
      }
      if (slotIdx < 0 || slotIdx >= equipped.length) return sock.sendMessage(chatId, { text: `❌ Invalid equipped slot! You have ${equipped.length} skills.` }, { quoted: msg });
      if (libIdx < 0 || libIdx >= library.length) return sock.sendMessage(chatId, { text: `❌ Invalid library slot! You have ${library.length} skills in library.` }, { quoted: msg });
      const oldSkill = equipped[slotIdx];
      const newSkill = library[libIdx];
      equipped[slotIdx] = newSkill;
      library[libIdx] = oldSkill;
      player.skills.active = equipped;
      player.availableSkills = library;
      saveDatabase();
      return sock.sendMessage(chatId, {
        text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔄 SKILL SWAPPED!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n❌ Unequipped: *${oldSkill.name}* → library\n✅ Equipped: *${newSkill.name}* (slot ${slotIdx+1})\n\nUse /skills to view your loadout.`
      }, { quoted: msg });
    }

    // ── EQUIP (Library → Empty slot) ──────────────────────────
    if (action === 'equip' || action === 'learn') {
      const libIdx = parseInt(args[1]) - 1;
      if (isNaN(libIdx) || libIdx < 0) return sock.sendMessage(chatId, { text: `❌ Usage: /skills equip [library#]` }, { quoted: msg });
      if (libIdx >= library.length) return sock.sendMessage(chatId, { text: `❌ Invalid library slot! You have ${library.length} skills.` }, { quoted: msg });
      if (equipped.length >= maxSlots) {
        return sock.sendMessage(chatId, { text: `❌ All ${maxSlots} slots full!\nUse /skills swap [slot#] [library#] to swap.\nOr /skills remove [slot#] to unequip one first.` }, { quoted: msg });
      }
      const skill = library.splice(libIdx, 1)[0];
      equipped.push(skill);
      player.skills.active = equipped;
      player.availableSkills = library;
      saveDatabase();
      const bonuses = applySkillLevelBonus(skill);
      return sock.sendMessage(chatId, {
        text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ SKILL EQUIPPED!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🔮 *${skill.name}* → Slot ${equipped.length}/${maxSlots}\n💥 DMG: ${bonuses.damage} | ${player.energyColor||'💙'} ${bonuses.energyCost} | ⏰ ${bonuses.cooldown}t\n\nUse /skills to view your loadout.`
      }, { quoted: msg });
    }

    // ── REMOVE (Equipped → Library) ───────────────────────────
    if (action === 'remove' || action === 'forget' || action === 'unequip') {
      const idx = parseInt(args[1]) - 1;
      if (isNaN(idx) || idx < 0) return sock.sendMessage(chatId, { text: `❌ Usage: /skills remove [slot#]\nExample: /skills remove 2` }, { quoted: msg });
      if (idx >= equipped.length) return sock.sendMessage(chatId, { text: `❌ No skill in slot ${idx+1}!` }, { quoted: msg });
      const skill = equipped.splice(idx, 1)[0];
      library.push(skill);
      player.skills.active = equipped;
      player.availableSkills = library;
      saveDatabase();
      return sock.sendMessage(chatId, {
        text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📚 MOVED TO LIBRARY\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n*${skill.name}* → Library slot ${library.length}\n\nSlots: ${equipped.length}/${maxSlots} used\nUse /skills to view your loadout.`
      }, { quoted: msg });
    }

    // ── LIBRARY SHORTHAND ─────────────────────────────────────
    if (action === 'library') {
      if (!library.length) return sock.sendMessage(chatId, { text: `📚 Your skill library is empty!\nUnlock skills by leveling up.` }, { quoted: msg });
      let txt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📚 SKILL LIBRARY (${library.length})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      library.forEach((s, i) => { txt += fmtSkillLine(s, i, player, false) + '\n'; });
      txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n/skills equip [#] — Add to loadout\n/skills swap [slot#] [lib#] — Swap`;
      return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
    }

    // ── LOADOUT SHORTHAND ─────────────────────────────────────
    if (action === 'loadout') {
      if (!equipped.length) return sock.sendMessage(chatId, { text: `No skills equipped!\nUse /skills equip [#] to add them.` }, { quoted: msg });
      let txt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔮 ACTIVE LOADOUT (${equipped.length}/${maxSlots})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      equipped.forEach((s, i) => { txt += fmtSkillLine(s, i, player, false) + '\n'; });
      txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
    }

    return sock.sendMessage(chatId, {
      text: `❌ Unknown command!\n\n/skills — View loadout\n/skills swap [slot#] [lib#]\n/skills equip [lib#]\n/skills remove [slot#]\n/skills upgrade [slot#]\n/skills info [# or name]\n/skills library\n/skills passives`
    }, { quoted: msg });
  }
};
