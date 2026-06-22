import "dotenv/config";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import {
  buildCharterIntro,
  buildCharterOutro,
  buildSectionBody,
  charterSections
} from "./charter.js";
import {
  exportLogsCsv,
  getRoleSnapshot,
  readRoleSnapshots,
  readAcceptanceLogs,
  upsertAcceptanceLog,
  upsertRoleSnapshot
} from "./storage.js";

const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID || "1157250991490609223",
  referenceChannelId: process.env.REFERENCE_CHANNEL_ID || "1158357016570503208",
  charterCategoryId: process.env.CHARTER_CATEGORY_ID || null,
  charterChannelName: process.env.CHARTER_CHANNEL_NAME || "ข้อตกลงและเงื่อนไข",
  charterVersion: process.env.CHARTER_VERSION || "ninjamap-community-charter-2026",
  testMode: (process.env.TEST_MODE ?? "true").toLowerCase() === "true",
  coachRoleId: process.env.COACH_ROLE_ID || null,
  coachRoleName: process.env.COACH_ROLE_NAME || "Coach",
  logChannelId: process.env.LOG_CHANNEL_ID || null,
  managedRoleNames: (process.env.MANAGED_ROLE_NAMES || "user,Membership,นักเรียน,Member,Free")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
  protectedRoleNames: (process.env.PROTECTED_ROLE_NAMES || "Admin,Staff,Bot")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
  memberScanEnabled: (process.env.ENABLE_MEMBER_SCAN || "false").toLowerCase() === "true",
  reverifyBatchSize: Number.parseInt(process.env.REVERIFY_BATCH_SIZE || "25", 10),
  reverifyBatchDelayMs: Number.parseInt(process.env.REVERIFY_BATCH_DELAY_MS || "1500", 10)
};

if (!config.token) {
  throw new Error("Missing DISCORD_TOKEN in .env");
}

if (!config.clientId) {
  throw new Error("Missing CLIENT_ID in .env");
}

const clientIntents = [GatewayIntentBits.Guilds];
if (config.memberScanEnabled) {
  clientIntents.push(GatewayIntentBits.GuildMembers);
}

const client = new Client({ intents: clientIntents });

const userProgress = new Map();
let reverifyAllJob = null;

async function registerGuildCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("export-acceptance-logs")
      .setDescription("Export Ninjamap Community Charter acceptance logs.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("reverify-lock-test")
      .setDescription("Dry-run or apply role lock to one selected test member.")
      .addUserOption((option) =>
        option
          .setName("member")
          .setDescription("Coach/test member to lock.")
          .setRequired(true)
      )
      .addBooleanOption((option) =>
        option
          .setName("apply")
          .setDescription("Set true to actually remove the managed roles. False/missing is dry-run.")
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("reverify-rollback-test")
      .setDescription("Restore managed roles to one selected test member from saved snapshot.")
      .addUserOption((option) =>
        option
          .setName("member")
          .setDescription("Test member to restore.")
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("reverify-status")
      .setDescription("Show one member's charter acceptance and role restore status.")
      .addUserOption((option) =>
        option
          .setName("member")
          .setDescription("Member to inspect.")
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("reverify-dry-run-all")
      .setDescription("Count members who would be locked by the Community Charter reverify.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("reverify-start-all")
      .setDescription("Start locking unaccepted members in small background batches.")
      .addIntegerOption((option) =>
        option
          .setName("batch_size")
          .setDescription("How many members to lock per batch. Default comes from Railway.")
          .setMinValue(1)
          .setMaxValue(100)
      )
      .addIntegerOption((option) =>
        option
          .setName("delay_ms")
          .setDescription("Delay between each member. Default comes from Railway.")
          .setMinValue(500)
          .setMaxValue(10000)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("reverify-stop-all")
      .setDescription("Stop the currently running background reverify lock job.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("reverify-summary")
      .setDescription("Show Community Charter reverify progress summary.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON()
  ];

  const rest = new REST({ version: "10" }).setToken(config.token);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
}

function acceptAllButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("charter_accept_all")
      .setLabel("ยอมรับ Community Charter")
      .setStyle(ButtonStyle.Success)
  );
}

function getAcceptedSectionsForUser(userId) {
  const current = userProgress.get(userId);
  return current ? new Set(current) : new Set();
}

function setAcceptedSectionsForUser(userId, acceptedSections) {
  userProgress.set(userId, [...acceptedSections]);
}

async function hydrateProgressFromLogs() {
  const logs = await readAcceptanceLogs();
  const validSectionIds = new Set(charterSections.map((section) => section.id));
  for (const log of logs) {
    if (log.charterVersion === config.charterVersion) {
      const acceptedSectionIds = (log.acceptedSectionIds || []).filter((sectionId) => validSectionIds.has(sectionId));
      userProgress.set(log.userId, acceptedSectionIds);
    }
  }
}

async function getTargetParentId(guild) {
  if (config.charterCategoryId) return config.charterCategoryId;

  const referenceChannel = await guild.channels.fetch(config.referenceChannelId);
  if (!referenceChannel) {
    throw new Error(`Reference channel ${config.referenceChannelId} was not found.`);
  }

  return referenceChannel.parentId;
}

async function ensureCharterChannel(guild) {
  const parentId = await getTargetParentId(guild);
  const coachRole = await resolveCoachRole(guild);
  const botUserId = client.user.id;
  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.name === config.charterChannelName &&
      channel.parentId === parentId
  );

  if (existing) {
    await ensureTestModeOverwrites(existing, guild, coachRole, botUserId);
    return existing;
  }

  const permissionOverwrites = [];

  if (config.testMode && coachRole) {
    permissionOverwrites.push(
      {
        id: guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: [PermissionFlagsBits.SendMessages]
      },
      {
        id: coachRole.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: [PermissionFlagsBits.SendMessages]
      },
      {
        id: botUserId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      }
    );
  }

  return guild.channels.create({
    name: config.charterChannelName,
    type: ChannelType.GuildText,
    parent: parentId,
    topic: `Ninjamap Community Charter 2026 | ${config.charterVersion}`,
    permissionOverwrites
  });
}

async function ensureTestModeOverwrites(channel, guild, coachRole, botUserId) {
  if (!config.testMode) return;

  await channel.permissionOverwrites.edit(botUserId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true
  });

  if (coachRole) {
    await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
      ViewChannel: true,
      SendMessages: false,
      ReadMessageHistory: true
    });
    await channel.permissionOverwrites.edit(coachRole.id, {
      ViewChannel: true,
      SendMessages: false,
      ReadMessageHistory: true
    });
  }
}

async function postCharterIfNeeded(channel) {
  const messages = await channel.messages.fetch({ limit: 50 });
  const hasChecklistVersion = messages.some(
    (message) =>
      message.author.id === client.user.id &&
      message.content.includes("Checklist mode: item-by-item") &&
      message.content.includes(config.charterVersion)
  );
  const hasSingleButtonVersion = messages.some(
    (message) =>
      message.author.id === client.user.id &&
      message.content.includes("Acceptance mode: single-button") &&
      message.content.includes(config.charterVersion)
  );
  const alreadyPosted = messages.some(
    (message) =>
      message.author.id === client.user.id &&
      message.content.includes("Ninjamap Community Charter 2026") &&
      message.content.includes("Acceptance mode: single-button") &&
      !message.content.includes("Checklist mode: item-by-item") &&
      message.content.includes(config.charterVersion)
  );

  if (alreadyPosted && hasSingleButtonVersion && !hasChecklistVersion) return;

  for (const message of messages.values()) {
    if (message.author.id === client.user.id) {
      await message.delete().catch(() => null);
    }
  }

  await channel.send(buildCharterIntro(config.charterVersion));

  for (const [index, section] of charterSections.entries()) {
    await channel.send({
      content: buildSectionBody(section, index, charterSections.length)
    });
  }

  await channel.send({
    content: buildCharterOutro(),
    components: [acceptAllButton()]
  });
}

async function resolveCoachRole(guild) {
  if (!config.testMode) return null;
  await guild.roles.fetch();
  if (config.coachRoleId) {
    return guild.roles.cache.get(config.coachRoleId) || await guild.roles.fetch(config.coachRoleId).catch(() => null);
  }

  return guild.roles.cache.find((role) => role.name === config.coachRoleName) || null;
}

function memberCanTest(member) {
  if (!config.testMode) return true;
  if (config.coachRoleId) return member.roles.cache.has(config.coachRoleId);
  return member.roles.cache.some((role) => role.name === config.coachRoleName);
}

function memberHasProtectedRole(member) {
  if (member.user.bot) return true;
  return member.roles.cache.some((role) => config.protectedRoleNames.includes(role.name));
}

function getManagedRolesFromMember(member) {
  return member.roles.cache
    .filter((role) => config.managedRoleNames.includes(role.name))
    .map((role) => ({ id: role.id, name: role.name }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireMemberScan(interaction) {
  if (config.memberScanEnabled) return false;
  return interaction.reply({
    content: [
      "ยังสแกนสมาชิกทั้งเซิร์ฟเวอร์ไม่ได้ค่ะ",
      "",
      "ต้องเปิด 2 จุดก่อน:",
      "1. Discord Developer Portal > Bot > Privileged Gateway Intents > เปิด Server Members Intent แล้ว Save",
      "2. Railway Variables ตั้ง `ENABLE_MEMBER_SCAN=true` แล้ว Deploy ใหม่",
      "",
      "หลังจากนั้นคำสั่งถอด role ทั้งเซิร์ฟเวอร์จะใช้งานได้ค่ะ"
    ].join("\n"),
    ephemeral: true
  });
}

function isAccepted(logs, userId) {
  return logs.some((log) => log.userId === userId && log.charterVersion === config.charterVersion);
}

function snapshotStatusByUser(snapshots) {
  return new Map(
    snapshots
      .filter((snapshot) => snapshot.charterVersion === config.charterVersion)
      .map((snapshot) => [snapshot.userId, snapshot.status])
  );
}

async function fetchAllGuildMembers(guild) {
  await guild.roles.fetch();
  return guild.members.fetch();
}

async function lockManagedRolesForMember(member, reason) {
  const managedRoles = getManagedRolesFromMember(member);
  const now = new Date().toISOString();

  await upsertRoleSnapshot({
    userId: member.id,
    username: member.user.tag,
    charterVersion: config.charterVersion,
    removedRoles: managedRoles,
    snapshotAt: now,
    removedAt: null,
    restoredAt: null,
    status: "snapshot_saved"
  });

  const removedRoles = [];
  const failedRoles = [];

  for (const role of managedRoles) {
    try {
      await member.roles.remove(role.id, reason);
      removedRoles.push(role);
    } catch (error) {
      failedRoles.push({ ...role, reason: error.message });
    }
  }

  await upsertRoleSnapshot({
    userId: member.id,
    username: member.user.tag,
    charterVersion: config.charterVersion,
    removedRoles: managedRoles,
    actuallyRemovedRoles: removedRoles,
    failedRemovedRoles: failedRoles,
    snapshotAt: now,
    removedAt: new Date().toISOString(),
    restoredAt: null,
    status: failedRoles.length ? "partial_lock_failed" : "locked"
  });

  return { managedRoles, removedRoles, failedRoles };
}

async function buildReverifySummary(guild) {
  const [members, acceptanceLogs, snapshots] = await Promise.all([
    fetchAllGuildMembers(guild),
    readAcceptanceLogs(),
    readRoleSnapshots()
  ]);
  const snapshotStatus = snapshotStatusByUser(snapshots);

  const summary = {
    totalMembers: members.size,
    botsOrProtected: 0,
    accepted: 0,
    currentlyLocked: 0,
    wouldLock: 0,
    noManagedRoles: 0,
    failedOrPartial: 0
  };

  for (const member of members.values()) {
    if (memberHasProtectedRole(member)) {
      summary.botsOrProtected += 1;
      continue;
    }

    if (isAccepted(acceptanceLogs, member.id)) {
      summary.accepted += 1;
      continue;
    }

    const status = snapshotStatus.get(member.id);
    if (status === "locked") {
      summary.currentlyLocked += 1;
      continue;
    }

    if (status === "partial_lock_failed") {
      summary.failedOrPartial += 1;
    }

    const managedRoles = getManagedRolesFromMember(member);
    if (managedRoles.length > 0) {
      summary.wouldLock += 1;
    } else {
      summary.noManagedRoles += 1;
    }
  }

  return summary;
}

async function getTargetMember(interaction) {
  const user = interaction.options.getUser("member", true);
  return interaction.guild.members.fetch(user.id);
}

async function sendAuditLog(guild, lines) {
  if (!config.logChannelId) return;
  const logChannel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (logChannel?.isTextBased()) {
    await logChannel.send(lines.join("\n"));
  }
}

async function restoreManagedRolesFromSnapshot(member, reason) {
  const snapshot = await getRoleSnapshot(member.id, config.charterVersion);
  if (!snapshot?.removedRoles?.length) {
    return { status: "no_snapshot", restoredRoles: [], failedRoles: [] };
  }

  const restoredRoles = [];
  const failedRoles = [];

  for (const savedRole of snapshot.removedRoles) {
    const role = member.guild.roles.cache.get(savedRole.id) || await member.guild.roles.fetch(savedRole.id).catch(() => null);

    if (!role) {
      failedRoles.push({ ...savedRole, reason: "role_not_found" });
      continue;
    }

    if (member.roles.cache.has(role.id)) {
      restoredRoles.push({ id: role.id, name: role.name, alreadyHadRole: true });
      continue;
    }

    try {
      await member.roles.add(role, reason);
      restoredRoles.push({ id: role.id, name: role.name });
    } catch (error) {
      failedRoles.push({ id: role.id, name: role.name, reason: error.message });
    }
  }

  await upsertRoleSnapshot({
    ...snapshot,
    restoredRoles,
    failedRestoredRoles: failedRoles,
    restoredAt: new Date().toISOString(),
    status: failedRoles.length ? "partial_restore_failed" : "restored"
  });

  await sendAuditLog(member.guild, [
    "**Reverify roles restored**",
    `User: ${member.user.tag} (${member.id})`,
    `Restored: ${restoredRoles.map((role) => role.name).join(", ") || "none"}`,
    `Failed: ${failedRoles.map((role) => `${role.name} (${role.reason})`).join(", ") || "none"}`,
    `Charter version: ${config.charterVersion}`
  ]);

  return {
    status: failedRoles.length ? "partial_restore_failed" : "restored",
    restoredRoles,
    failedRoles
  };
}

async function logAcceptance(interaction, acceptedSectionIds) {
  const acceptedSections = charterSections
    .filter((section) => acceptedSectionIds.includes(section.id))
    .map((section) => section.label);
  const entry = await upsertAcceptanceLog({
    userId: interaction.user.id,
    username: interaction.user.tag,
    acceptedSections,
    acceptedSectionIds,
    acceptedAt: new Date().toISOString(),
    charterVersion: config.charterVersion
  });

  if (config.logChannelId) {
    const logChannel = await interaction.guild.channels.fetch(config.logChannelId).catch(() => null);
    if (logChannel?.isTextBased()) {
      await logChannel.send([
        "**Community Charter accepted**",
        `User: ${entry.username} (${entry.userId})`,
        `Charter version: ${entry.charterVersion}`,
        `Accepted at: ${entry.acceptedAt}`,
        `Sections: ${entry.acceptedSections.join(", ")}`
      ].join("\n"));
    }
  }
}

async function handleReverifyLockTest(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "คำสั่งนี้ใช้ได้เฉพาะแอดมินค่ะ", ephemeral: true });
    return;
  }

  const apply = interaction.options.getBoolean("apply") === true;
  const member = await getTargetMember(interaction);

  if (memberHasProtectedRole(member)) {
    await interaction.reply({
      content: [
        "ไม่ทำรายการค่ะ เพราะ user นี้มี protected role หรือเป็น bot",
        "ระบบจะไม่แตะ Admin, Staff, Bot หรือ protected roles"
      ].join("\n"),
      ephemeral: true
    });
    return;
  }

  const managedRoles = getManagedRolesFromMember(member);

  if (!apply) {
    await interaction.reply({
      content: [
        "**Dry-run: reverify lock test**",
        `User: ${member.user.tag} (${member.id})`,
        `จะ snapshot/remove เฉพาะ role: ${config.managedRoleNames.join(", ")}`,
        `พบ role ที่ user มี: ${managedRoles.map((role) => role.name).join(", ") || "none"}`,
        "",
        "ยังไม่ได้ถอด role ใด ๆ",
        "ถ้าต้องการทดสอบจริง ให้ใช้คำสั่งเดิมและตั้ง `apply` เป็น `True`"
      ].join("\n"),
      ephemeral: true
    });
    return;
  }

  const result = await lockManagedRolesForMember(
    member,
    `Ninjamap Charter test lock ${config.charterVersion}`
  );

  await sendAuditLog(interaction.guild, [
    "**Reverify test lock applied**",
    `User: ${member.user.tag} (${member.id})`,
    `Removed: ${result.removedRoles.map((role) => role.name).join(", ") || "none"}`,
    `Failed: ${result.failedRoles.map((role) => `${role.name} (${role.reason})`).join(", ") || "none"}`,
    `Charter version: ${config.charterVersion}`
  ]);

  await interaction.reply({
    content: [
      "**Applied: reverify lock test**",
      `User: ${member.user.tag}`,
      `Snapshot saved: ${managedRoles.map((role) => role.name).join(", ") || "none"}`,
      `Removed: ${result.removedRoles.map((role) => role.name).join(", ") || "none"}`,
      `Failed: ${result.failedRoles.map((role) => `${role.name} (${role.reason})`).join(", ") || "none"}`,
      "",
      "ยังไม่แตะ role อื่น และยังไม่ล็อกทั้ง server ค่ะ"
    ].join("\n"),
    ephemeral: true
  });
}

async function handleReverifyRollbackTest(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "คำสั่งนี้ใช้ได้เฉพาะแอดมินค่ะ", ephemeral: true });
    return;
  }

  const member = await getTargetMember(interaction);
  const result = await restoreManagedRolesFromSnapshot(
    member,
    `Ninjamap Charter test rollback ${config.charterVersion}`
  );

  await interaction.reply({
    content: [
      "**Rollback test completed**",
      `User: ${member.user.tag}`,
      `Status: ${result.status}`,
      `Restored: ${result.restoredRoles.map((role) => role.name).join(", ") || "none"}`,
      `Failed: ${result.failedRoles.map((role) => `${role.name} (${role.reason})`).join(", ") || "none"}`
    ].join("\n"),
    ephemeral: true
  });
}

async function handleReverifyStatus(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "คำสั่งนี้ใช้ได้เฉพาะแอดมินค่ะ", ephemeral: true });
    return;
  }

  const member = await getTargetMember(interaction);
  const snapshot = await getRoleSnapshot(member.id, config.charterVersion);
  const acceptanceLogs = await readAcceptanceLogs();
  const acceptance = acceptanceLogs.find(
    (log) => log.userId === member.id && log.charterVersion === config.charterVersion
  );
  const currentManagedRoles = getManagedRolesFromMember(member);

  await interaction.reply({
    content: [
      "**Reverification status**",
      `User: ${member.user.tag} (${member.id})`,
      `Charter version: ${config.charterVersion}`,
      "",
      `Accepted: ${acceptance ? "yes" : "no"}`,
      `Accepted at: ${acceptance?.acceptedAt || "none"}`,
      `Accepted sections: ${acceptance?.acceptedSections?.join(", ") || "none"}`,
      "",
      `Snapshot status: ${snapshot?.status || "none"}`,
      `Snapshot roles: ${snapshot?.removedRoles?.map((role) => role.name).join(", ") || "none"}`,
      `Removed roles: ${snapshot?.actuallyRemovedRoles?.map((role) => role.name).join(", ") || "none"}`,
      `Restored roles: ${snapshot?.restoredRoles?.map((role) => role.name).join(", ") || "none"}`,
      `Failed removed: ${snapshot?.failedRemovedRoles?.map((role) => `${role.name} (${role.reason})`).join(", ") || "none"}`,
      `Failed restored: ${snapshot?.failedRestoredRoles?.map((role) => `${role.name} (${role.reason})`).join(", ") || "none"}`,
      "",
      `Current managed roles: ${currentManagedRoles.map((role) => role.name).join(", ") || "none"}`
    ].join("\n"),
    ephemeral: true
  });
}

async function handleReverifyDryRunAll(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "คำสั่งนี้ใช้ได้เฉพาะแอดมินค่ะ", ephemeral: true });
    return;
  }

  if (!config.memberScanEnabled) {
    await requireMemberScan(interaction);
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const summary = await buildReverifySummary(interaction.guild);

  await interaction.editReply({
    content: [
      "**Dry-run: reverify all**",
      "ยังไม่ได้ถอด role ใด ๆ ค่ะ",
      "",
      `สมาชิกทั้งหมดที่บอทเห็น: ${summary.totalMembers}`,
      `ข้าม bot/protected roles: ${summary.botsOrProtected}`,
      `กดยอมรับแล้ว: ${summary.accepted}`,
      `ถูกล็อกอยู่แล้ว: ${summary.currentlyLocked}`,
      `จะถูกถอด role หากเริ่มจริง: ${summary.wouldLock}`,
      `ไม่มี role 5 ตัวให้ถอด: ${summary.noManagedRoles}`,
      `เคยมีรายการ partial/failed: ${summary.failedOrPartial}`,
      "",
      `Role ที่จัดการ: ${config.managedRoleNames.join(", ")}`,
      "ถ้าตัวเลขถูกต้อง ให้ใช้ `/reverify-start-all` เพื่อเริ่มถอดทีละชุดค่ะ"
    ].join("\n")
  });
}

async function handleReverifySummary(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "คำสั่งนี้ใช้ได้เฉพาะแอดมินค่ะ", ephemeral: true });
    return;
  }

  if (!config.memberScanEnabled) {
    await requireMemberScan(interaction);
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const summary = await buildReverifySummary(interaction.guild);
  const jobStatus = reverifyAllJob
    ? `กำลังทำงาน: processed ${reverifyAllJob.processed}/${reverifyAllJob.total}, locked ${reverifyAllJob.locked}, failed ${reverifyAllJob.failed}`
    : "ไม่มีงาน background ที่กำลังรันอยู่";

  await interaction.editReply({
    content: [
      "**Reverify summary**",
      `สถานะงาน: ${jobStatus}`,
      "",
      `สมาชิกทั้งหมดที่บอทเห็น: ${summary.totalMembers}`,
      `ข้าม bot/protected roles: ${summary.botsOrProtected}`,
      `กดยอมรับแล้ว: ${summary.accepted}`,
      `ถูกล็อกอยู่แล้ว: ${summary.currentlyLocked}`,
      `ยังเหลือที่ต้องถอด role: ${summary.wouldLock}`,
      `ไม่มี role 5 ตัวให้ถอด: ${summary.noManagedRoles}`,
      `partial/failed: ${summary.failedOrPartial}`
    ].join("\n")
  });
}

async function handleReverifyStartAll(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "คำสั่งนี้ใช้ได้เฉพาะแอดมินค่ะ", ephemeral: true });
    return;
  }

  if (!config.memberScanEnabled) {
    await requireMemberScan(interaction);
    return;
  }

  if (reverifyAllJob) {
    await interaction.reply({
      content: "มีงาน reverify all กำลังรันอยู่แล้วค่ะ ใช้ `/reverify-summary` เพื่อดูสถานะ หรือ `/reverify-stop-all` เพื่อหยุด",
      ephemeral: true
    });
    return;
  }

  const batchSize = interaction.options.getInteger("batch_size") || config.reverifyBatchSize;
  const delayMs = interaction.options.getInteger("delay_ms") || config.reverifyBatchDelayMs;

  await interaction.deferReply({ ephemeral: true });
  const [members, acceptanceLogs, snapshots] = await Promise.all([
    fetchAllGuildMembers(interaction.guild),
    readAcceptanceLogs(),
    readRoleSnapshots()
  ]);
  const snapshotStatus = snapshotStatusByUser(snapshots);

  const targets = members
    .filter((member) => {
      if (memberHasProtectedRole(member)) return false;
      if (isAccepted(acceptanceLogs, member.id)) return false;
      if (snapshotStatus.get(member.id) === "locked" && getManagedRolesFromMember(member).length === 0) return false;
      return getManagedRolesFromMember(member).length > 0;
    })
    .map((member) => member.id);

  if (targets.length === 0) {
    await interaction.editReply({
      content: "ไม่มีสมาชิกที่ต้องถอด role เพิ่มแล้วค่ะ ตอนนี้คนที่ยังไม่กดยอมรับและยังมี role 5 ตัว = 0"
    });
    return;
  }

  reverifyAllJob = {
    stopped: false,
    total: targets.length,
    processed: 0,
    locked: 0,
    failed: 0,
    startedAt: new Date().toISOString()
  };

  await interaction.editReply({
    content: [
      "**เริ่ม reverify ทั้งเซิร์ฟเวอร์แล้วค่ะ**",
      `จำนวนที่จะค่อย ๆ ถอด role: ${targets.length} คน`,
      `ทำทีละชุด: ${batchSize} คน`,
      `พักระหว่างแต่ละคน: ${delayMs} ms`,
      "",
      "บอทจะทำงานต่อเองในพื้นหลัง ไม่ต้องเปิดคอมเครื่องนี้ทิ้งไว้ค่ะ",
      "ดูความคืบหน้าได้ด้วย `/reverify-summary`",
      "หยุดงานได้ด้วย `/reverify-stop-all`"
    ].join("\n")
  });

  void runReverifyAllJob(interaction.guild, targets, batchSize, delayMs, interaction.channel).catch((error) => {
    console.error(error);
    reverifyAllJob = null;
  });
}

async function runReverifyAllJob(guild, targets, batchSize, delayMs, reportChannel) {
  let batchLocked = 0;
  let batchFailed = 0;

  for (const userId of targets) {
    if (!reverifyAllJob || reverifyAllJob.stopped) break;

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || memberHasProtectedRole(member) || getManagedRolesFromMember(member).length === 0) {
      reverifyAllJob.processed += 1;
      continue;
    }

    const acceptanceLogs = await readAcceptanceLogs();
    if (isAccepted(acceptanceLogs, member.id)) {
      reverifyAllJob.processed += 1;
      continue;
    }

    const result = await lockManagedRolesForMember(
      member,
      `Ninjamap Charter batch lock ${config.charterVersion}`
    );

    reverifyAllJob.processed += 1;
    if (result.failedRoles.length) {
      reverifyAllJob.failed += 1;
      batchFailed += 1;
    } else {
      reverifyAllJob.locked += 1;
      batchLocked += 1;
    }

    if (reverifyAllJob.processed % batchSize === 0) {
      await sendAuditLog(guild, [
        "**Reverify batch progress**",
        `Processed: ${reverifyAllJob.processed}/${reverifyAllJob.total}`,
        `Locked: ${reverifyAllJob.locked}`,
        `Failed: ${reverifyAllJob.failed}`,
        `Last batch locked: ${batchLocked}`,
        `Last batch failed: ${batchFailed}`
      ]);
      batchLocked = 0;
      batchFailed = 0;
      await sleep(delayMs * 5);
    } else {
      await sleep(delayMs);
    }
  }

  const finalJob = reverifyAllJob;
  reverifyAllJob = null;

  if (finalJob?.stopped) {
    await sendAuditLog(guild, [
      "**Reverify all stopped**",
      `Processed: ${finalJob.processed}/${finalJob.total}`,
      `Locked: ${finalJob.locked}`,
      `Failed: ${finalJob.failed}`
    ]);
    return;
  }

  await sendAuditLog(guild, [
    "**Reverify all completed**",
    `Processed: ${finalJob?.processed || 0}/${finalJob?.total || 0}`,
    `Locked: ${finalJob?.locked || 0}`,
    `Failed: ${finalJob?.failed || 0}`
  ]);

  if (!config.logChannelId && reportChannel?.isTextBased()) {
    await reportChannel.send([
      "**Reverify all completed**",
      `Processed: ${finalJob?.processed || 0}/${finalJob?.total || 0}`,
      `Locked: ${finalJob?.locked || 0}`,
      `Failed: ${finalJob?.failed || 0}`
    ].join("\n")).catch(() => null);
  }
}

async function handleReverifyStopAll(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "คำสั่งนี้ใช้ได้เฉพาะแอดมินค่ะ", ephemeral: true });
    return;
  }

  if (!reverifyAllJob) {
    await interaction.reply({ content: "ตอนนี้ไม่มีงาน reverify all ที่กำลังรันอยู่ค่ะ", ephemeral: true });
    return;
  }

  reverifyAllJob.stopped = true;
  await interaction.reply({
    content: "สั่งหยุดงานแล้วค่ะ บอทจะหยุดหลังจบรายการคนปัจจุบัน",
    ephemeral: true
  });
}

async function handleCharterButton(interaction) {
  if (!memberCanTest(interaction.member)) {
    await interaction.reply({
      content: "ตอนนี้อยู่ในโหมดทดสอบ เฉพาะผู้ที่มี role Coach เท่านั้นที่สามารถทดลองกดยืนยันได้ค่ะ",
      ephemeral: true
    });
    return;
  }

  const acceptedSectionIds = charterSections.map((section) => section.id);
  setAcceptedSectionsForUser(interaction.user.id, acceptedSectionIds);
  await logAcceptance(interaction, acceptedSectionIds);
  const restoreResult = await restoreManagedRolesFromSnapshot(
    interaction.member,
    `Ninjamap Charter accepted ${config.charterVersion}`
  );

  await interaction.reply({
    content: [
      "ยืนยัน Community Charter เรียบร้อยแล้วค่ะ",
      `บันทึกเวลา: ${new Date().toISOString()}`,
      `Charter version: ${config.charterVersion}`,
      "",
      restoreResult.status === "restored"
        ? `คืน role แล้ว: ${restoreResult.restoredRoles.map((role) => role.name).join(", ") || "none"}`
        : `สถานะการคืน role: ${restoreResult.status}`,
      restoreResult.failedRoles.length
        ? `Role ที่คืนไม่สำเร็จ: ${restoreResult.failedRoles.map((role) => `${role.name} (${role.reason})`).join(", ")}`
        : "Role ที่คืนไม่สำเร็จ: none",
      "",
      restoreResult.status === "no_snapshot"
        ? "ยังไม่พบ snapshot สำหรับ user นี้ หากคุณถูกล็อก role อยู่ กรุณาแจ้งแอดมินให้ใช้ /reverify-rollback-test"
        : "ขอบคุณที่ยืนยัน Community Charter ค่ะ"
    ].join("\n"),
    ephemeral: true
  });
}

async function handleExportLogs(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "คำสั่งนี้ใช้ได้เฉพาะแอดมินค่ะ", ephemeral: true });
    return;
  }

  const csv = await exportLogsCsv();
  const attachment = new AttachmentBuilder(Buffer.from(csv, "utf8"), {
    name: `ninjamap-acceptance-logs-${config.charterVersion}.csv`
  });

  await interaction.reply({
    content: "Export acceptance logs เรียบร้อยค่ะ",
    files: [attachment],
    ephemeral: true
  });
}

client.once(Events.ClientReady, async () => {
  await registerGuildCommands();
  await hydrateProgressFromLogs();
  const guild = await client.guilds.fetch(config.guildId);
  const channel = await ensureCharterChannel(guild);
  await postCharterIfNeeded(channel);

  console.log(`Ready as ${client.user.tag}`);
  console.log(`Charter channel: #${channel.name} (${channel.id})`);
  console.log(`Test mode: ${config.testMode ? "on" : "off"}`);
  if (config.testMode) console.log(`Coach role: ${config.coachRoleId || config.coachRoleName}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId === "charter_accept_all") {
      await handleCharterButton(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("charter_accept:")) {
      await interaction.reply({
        content: "ปุ่มนี้เป็นเวอร์ชันเก่าค่ะ กรุณาใช้ปุ่ม `ยอมรับ Community Charter` ด้านล่างสุดของโพสต์ใหม่",
        ephemeral: true
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("charter_item:")) {
      await interaction.reply({
        content: "ปุ่มนี้เป็นเวอร์ชันเก่าค่ะ กรุณาใช้ปุ่มยอมรับรายหัวข้อในโพสต์ใหม่",
        ephemeral: true
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "export-acceptance-logs") {
      await handleExportLogs(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "reverify-lock-test") {
      await handleReverifyLockTest(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "reverify-rollback-test") {
      await handleReverifyRollbackTest(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "reverify-status") {
      await handleReverifyStatus(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "reverify-dry-run-all") {
      await handleReverifyDryRunAll(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "reverify-start-all") {
      await handleReverifyStartAll(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "reverify-stop-all") {
      await handleReverifyStopAll(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "reverify-summary") {
      await handleReverifySummary(interaction);
    }
  } catch (error) {
    console.error(error);
    const message = "เกิดข้อผิดพลาด กรุณาแจ้งทีมงานค่ะ";
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: message, ephemeral: true });
    } else {
      await interaction.reply({ content: message, ephemeral: true });
    }
  }
});

client.login(config.token);
