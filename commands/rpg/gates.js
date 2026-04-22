// ═══════════════════════════════════════════════════════════════
// GATES COMMAND — View, buy, apply, and manage gates in the chat
// Commands:
//   /gates               — list active gates
//   /gates buy [id]      — guild leader buys a gate
//   /gates apply [id]    — player applies to join a raid
//   /gates accept @user [id] — guild leader accepts a raider
//   /gates start [id]    — guild leader starts the raid
//   /gates status [id]   — detailed gate info
// ═══════════════════════════════════════════════════════════════

const { GateManager, GATE_RANKS } = require('../../rpg/dungeons/GateManager');
const { AWAKENING_RANKS } = require('../../rpg/utils/SoloLevelingCore');
const { AuraSystem } = require('../../rpg/utils/AuraSystem');

module.exports = {
  name: 'gates',
  aliases: ['gate'],
  description: 'View and interact with active gates in this chat',

  async execute(sock, msg, args, getDatabase, saveDatabase, sender) {
    const chatId = msg.key?.remoteJid;
    const db = getDatabase();
    const player = db.users[sender];
    if (!player) return sock.sendMessage(chatId, { text: '❌ Register first! Use /register' }, { quoted: msg });

    const sub = args[0]?.toLowerCase();
    const gateId = args[1]?.toUpperCase();

    // Check for broken gates first
    GateManager.checkGateBreaks(chatId, sock);

    // ── LIST ACTIVE GATES ─────────────────────────────────────
    if (!sub || sub === 'list') {
      const active = GateManager.getActiveGatesForChat(chatId);
      if (active.length === 0) {
        return sock.sendMessage(chatId, {
          text: [
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            `「System」 *GATE STATUS*`,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
            ``,
            `No active gates in this area.`,
            `Gates spawn every 25-50 minutes.`,
            `Stay alert, hunter.`,
            ``,
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          ].join('\n')
        }, { quoted: msg });
      }

      const rank = player.awakenRank || 'E';
      const rankData = AWAKENING_RANKS[rank];

      let txt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      txt += `「System」 *ACTIVE GATES*\n`;
      txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      txt += `${rankData.emoji} Your rank: *${rankData.label}*\n`;
      txt += `🚪 Gates you can enter: ${rankData.gateAccess.join(', ')}\n\n`;

      for (const gate of active) {
        txt += GateManager.formatGate(gate) + '\n';
        txt += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      }

      txt += `\n📌 Commands:\n`;
      txt += `/gates apply [GATE-ID] — apply to join\n`;
      txt += `/gates buy [GATE-ID] — guild leader buys gate\n`;
      txt += `/gates status [GATE-ID] — full gate details`;

      return sock.sendMessage(chatId, { text: txt }, { quoted: msg });
    }

    // ── STATUS ────────────────────────────────────────────────
    if (sub === 'status' || sub === 'info') {
      if (!gateId) return sock.sendMessage(chatId, { text: '❌ Usage: /gates status [GATE-ID]' }, { quoted: msg });
      const gate = GateManager.getGate(gateId);
      if (!gate || gate.chatId !== chatId) return sock.sendMessage(chatId, { text: '❌ Gate not found in this chat.' }, { quoted: msg });

      const rd = GATE_RANKS[gate.rank];
      const timeLeft = Math.max(0, gate.breakTime - Date.now());
      const h = Math.floor(timeLeft / 3600000);
      const m = Math.floor((timeLeft % 3600000) / 60000);

      const lines = [
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `${rd.emoji} *${rd.label}*`,
        `ID: ${gate.id}`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ``,
        `⏰ Breaks in: *${h}h ${m}m*`,
        gate.isFree ? `🆓 *FREE GATE* — No purchase required` : ``,
        gate.isDisaster ? `⚠️ *DISASTER CLASS* — All S-Rank hunters must clear this!` : ``,
        ``,
        `🏰 Status: ${gate.owned ? `Owned by *${gate.ownedBy}*` : `Available for purchase`}`,
        !gate.owned && !gate.isFree ? `💰 Purchase price: *${gate.purchasePrice.toLocaleString()} 💎*` : ``,
        ``,
        `🗺️ Floors: ${gate.totalFloors}`,
        `👾 Monsters: ${gate.monsters?.filter(m => !m.defeated).length || 0} remaining`,
        `🏆 Boss: *${gate.boss?.name}* (${gate.boss?.hp?.toLocaleString()}/${gate.boss?.maxHp?.toLocaleString()} HP)`,
        ``,
        `👥 Raiders: ${gate.raiders.length}`,
        gate.raidStarted ? `⚔️ *RAID IN PROGRESS* (Floor ${gate.currentFloor}/${gate.totalFloors})` : `📋 Waiting for raid to start`,
        gate.pendingApplicants?.length > 0 ? `⏳ Pending applications: ${gate.pendingApplicants.length}` : ``,
        ``,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `💎 Reward range: ${rd.crystalReward[0].toLocaleString()} – ${rd.crystalReward[1].toLocaleString()} Mana Stones`,
        `🎁 Loot tier: *${rd.lootTier.toUpperCase()}*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ].filter(l => l !== null && l !== '').join('\n');

      return sock.sendMessage(chatId, { text: lines }, { quoted: msg });
    }

    // ── BUY GATE ──────────────────────────────────────────────
    if (sub === 'buy' || sub === 'purchase') {
      if (!gateId) return sock.sendMessage(chatId, { text: '❌ Usage: /gates buy [GATE-ID]' }, { quoted: msg });

      const guildName = player.guild;
      if (!guildName) return sock.sendMessage(chatId, { text: '❌ You must be in a guild to buy gates.\nJoin or create one with /guild' }, { quoted: msg });

      const guild = db.guilds?.[guildName];
      if (!guild) return sock.sendMessage(chatId, { text: '❌ Guild data missing.' }, { quoted: msg });
      if (guild.leader !== sender) return sock.sendMessage(chatId, { text: `❌ Only the guild leader can purchase gates.\nGuild: *${guildName}*` }, { quoted: msg });

      const gate = GateManager.getGate(gateId);
      if (!gate || gate.chatId !== chatId) return sock.sendMessage(chatId, { text: '❌ Gate not found in this chat.' }, { quoted: msg });

      const result = GateManager.purchaseGate(gateId, guildName, sender, db);
      if (!result.success) return sock.sendMessage(chatId, { text: `❌ ${result.reason}` }, { quoted: msg });

      saveDatabase();

      const rd = GATE_RANKS[gate.rank];
      return sock.sendMessage(chatId, {
        text: [
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `🏰 *GATE PURCHASED!*`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          ``,
          `${rd.emoji} *${rd.label}*`,
          `Guild: *${guildName}*`,
          ``,
          `Guild members can now join automatically.`,
          `External raiders need your approval.`,
          ``,
          `📌 Next steps:`,
          `/gates apply ${gateId} — members join`,
          `/gates accept @user ${gateId} — accept outsiders`,
          `/gates start ${gateId} — begin the raid`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ].join('\n')
      }, { quoted: msg });
    }

    // ── APPLY TO RAID ─────────────────────────────────────────
    if (sub === 'apply' || sub === 'join') {
      if (!gateId) return sock.sendMessage(chatId, { text: '❌ Usage: /gates apply [GATE-ID]' }, { quoted: msg });

      const gate = GateManager.getGate(gateId);
      if (!gate || gate.chatId !== chatId) return sock.sendMessage(chatId, { text: '❌ Gate not found in this chat.' }, { quoted: msg });

      const playerRank = player.awakenRank || 'E';
      const result = GateManager.applyToRaid(gateId, sender, playerRank, db);

      if (!result.success) return sock.sendMessage(chatId, { text: `❌ ${result.reason}` }, { quoted: msg });

      saveDatabase();

      if (result.autoAccepted) {
        return sock.sendMessage(chatId, {
          text: [
            `✅ *Joined Gate!*`,
            ``,
            `${GATE_RANKS[gate.rank].emoji} *${GATE_RANKS[gate.rank].label}* [${gateId}]`,
            gate.raidStarted ? `⚔️ Raid already started — entering now!` : `⏳ Waiting for raid to start.`,
          ].join('\n')
        }, { quoted: msg });
      } else {
        // Notify guild leader via DM
        if (gate.ownedByLeader) {
          const rankData = AWAKENING_RANKS[playerRank];
          sock.sendMessage(gate.ownedByLeader, {
            text: [
              `📩 *NEW GATE APPLICATION*`,
              ``,
              `Hunter: *${player.name}*`,
              `Rank: ${rankData.emoji} *${rankData.label}*`,
              `Gate: ${GATE_RANKS[gate.rank].emoji} *${gate.rank}-Rank* [${gateId}]`,
              ``,
              `To accept: /gates accept @${sender.split('@')[0]} ${gateId}`,
            ].join('\n')
          }).catch(() => {});
        }

        return sock.sendMessage(chatId, {
          text: [
            `📨 *Application Sent!*`,
            ``,
            `Gate: ${GATE_RANKS[gate.rank].emoji} *${gate.rank}-Rank* [${gateId}]`,
            `Guild: *${gate.ownedBy}*`,
            ``,
            `⏳ Waiting for guild leader to accept you.`,
          ].join('\n')
        }, { quoted: msg });
      }
    }

    // ── ACCEPT RAIDER ─────────────────────────────────────────
    if (sub === 'accept') {
      const mentionedId = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      const targetGateId = args[2]?.toUpperCase() || gateId;
      if (!mentionedId || !targetGateId) return sock.sendMessage(chatId, { text: '❌ Usage: /gates accept @user [GATE-ID]' }, { quoted: msg });

      const gate = GateManager.getGate(targetGateId);
      if (!gate || gate.chatId !== chatId) return sock.sendMessage(chatId, { text: '❌ Gate not found.' }, { quoted: msg });

      const result = GateManager.acceptRaider(targetGateId, mentionedId, sender);
      if (!result.success) return sock.sendMessage(chatId, { text: `❌ ${result.reason}` }, { quoted: msg });

      saveDatabase();

      const accepted = db.users[mentionedId];
      return sock.sendMessage(chatId, {
        text: `✅ *${accepted?.name || mentionedId}* has been accepted into the gate raid!\n${GATE_RANKS[gate.rank].emoji} [${targetGateId}]`,
        mentions: [mentionedId],
      }, { quoted: msg });
    }

    // ── START RAID ────────────────────────────────────────────
    if (sub === 'start') {
      if (!gateId) return sock.sendMessage(chatId, { text: '❌ Usage: /gates start [GATE-ID]' }, { quoted: msg });

      const gate = GateManager.getGate(gateId);
      if (!gate || gate.chatId !== chatId) return sock.sendMessage(chatId, { text: '❌ Gate not found.' }, { quoted: msg });

      const result = GateManager.startRaid(gateId, sender);
      if (!result.success) return sock.sendMessage(chatId, { text: `❌ ${result.reason}` }, { quoted: msg });

      saveDatabase();

      const rd = GATE_RANKS[gate.rank];
      const mentions = gate.raiders;
      const raiderNames = gate.raiders.map(j => db.users[j]?.name || j.split('@')[0]).join(', ');

      return sock.sendMessage(chatId, {
        text: [
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `${rd.emoji} *${rd.label} RAID STARTED!*`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          ``,
          `「System」 Gate entry confirmed for ${gate.raiders.length} hunter(s).`,
          `Proceeding to Floor 1...`,
          ``,
          `👥 Raid party: ${raiderNames}`,
          `🗺️ Total floors: ${gate.totalFloors}`,
          `🏆 Boss: *${gate.boss.name}*`,
          ``,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `Use /gateraid [GATE-ID] to fight!`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ].join('\n'),
        mentions,
      }, { quoted: msg });
    }

    // ── SPAWN (ADMIN) ─────────────────────────────────────────
    if (sub === 'spawn') {
      const isAdmin = db.botAdmins?.includes(sender) || db.superAdmins?.includes(sender);
      if (!isAdmin) return sock.sendMessage(chatId, { text: '❌ Admin only.' }, { quoted: msg });

      const forcedRank = args[1]?.toUpperCase();
      const avgRank = db.groupAverageRank?.[chatId] || 'E';
      const gate = GateManager.spawnGate(chatId, forcedRank && GATE_RANKS[forcedRank] ? forcedRank : avgRank);

      if (forcedRank && GATE_RANKS[forcedRank]) gate.rank = forcedRank; // Override rank if specified

      saveDatabase();

      const rd = GATE_RANKS[gate.rank];
      const timeLeft = Math.floor((gate.breakTime - Date.now()) / 60000);

      return sock.sendMessage(chatId, {
        text: [
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          gate.isDisaster ? `⚠️ *DISASTER GATE HAS APPEARED!*` : `${rd.emoji} *GATE HAS APPEARED!*`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          ``,
          `「System」 A ${gate.isDisaster ? 'DISASTER CLASS' : `${gate.rank}-Rank`} gate has opened in this area.`,
          ``,
          `ID: *${gate.id}*`,
          `Type: *${rd.label}*`,
          gate.isFree ? `🆓 *FREE — Anyone can enter*` : `💰 *Purchase: ${gate.purchasePrice.toLocaleString()} 💎*`,
          `⏰ Breaks in: *${timeLeft} minutes*`,
          ``,
          rd.description,
          ``,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          !gate.isFree ? `/gates buy ${gate.id} — Guild leaders can claim` : ``,
          `/gates apply ${gate.id} — Apply to join raid`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ].filter(l => l !== null).join('\n')
      }, { quoted: msg });
    }

    return sock.sendMessage(chatId, {
      text: [
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `🚪 *GATES COMMANDS*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `/gates — list active gates`,
        `/gates status [ID] — gate details`,
        `/gates apply [ID] — apply to raid`,
        `/gates buy [ID] — guild leader buys gate`,
        `/gates accept @user [ID] — accept a raider`,
        `/gates start [ID] — start the raid`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ].join('\n')
    }, { quoted: msg });
  }
};