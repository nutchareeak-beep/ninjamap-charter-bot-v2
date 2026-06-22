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
    .filter(Boolean)
};

if (!config.token) {
  throw new Error("Missing DISCORD_TOKEN in .env");
}

if (!config.clientId) {
  throw new Error("Missing CLIENT_ID in .env");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const userProgress = new Map();

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
  const now = new Date().toISOString();

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
      await member.roles.remove(role.id, `Ninjamap Charter test lock ${config.charterVersion}`);
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

  await sendAuditLog(interaction.guild, [
    "**Reverify test lock applied**",
    `User: ${member.user.tag} (${member.id})`,
    `Removed: ${removedRoles.map((role) => role.name).join(", ") || "none"}`,
    `Failed: ${failedRoles.map((role) => `${role.name} (${role.reason})`).join(", ") || "none"}`,
    `Charter version: ${config.charterVersion}`
  ]);

  await interaction.reply({
    content: [
      "**Applied: reverify lock test**",
      `User: ${member.user.tag}`,
      `Snapshot saved: ${managedRoles.map((role) => role.name).join(", ") || "none"}`,
      `Removed: ${removedRoles.map((role) => role.name).join(", ") || "none"}`,
      `Failed: ${failedRoles.map((role) => `${role.name} (${role.reason})`).join(", ") || "none"}`,
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
