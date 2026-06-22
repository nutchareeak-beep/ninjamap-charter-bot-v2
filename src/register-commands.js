import "dotenv/config";
import { PermissionFlagsBits, REST, Routes, SlashCommandBuilder } from "discord.js";

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error("Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env");
}

const commands = [
  new SlashCommandBuilder()
    .setName("export-acceptance-logs")
    .setDescription("Export Ninjamap Community Charter acceptance logs.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("reverify-rollback-test")
    .setDescription("Restore managed roles to one selected test member from saved snapshot.")
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("Test member to restore.")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("reverify-status")
    .setDescription("Show one member's charter acceptance and role restore status.")
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("Member to inspect.")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("reverify-dry-run-all")
    .setDescription("Count members who would be locked by the Community Charter reverify.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("reverify-stop-all")
    .setDescription("Stop the currently running background reverify lock job.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("reverify-summary")
    .setDescription("Show Community Charter reverify progress summary.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
console.log("Registered guild slash commands.");
