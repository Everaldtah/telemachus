#!/usr/bin/env node
/**
 * Telemachus entry point. Loads config (env / .env), validates required secrets,
 * and starts the Telegram bot. All secrets come from the environment — nothing is
 * hardcoded or committed.
 */
import { loadConfig, validateConfig } from "./config";
import { TelegramClient } from "./telegram";
import { TelemachusBot } from "./bot";

async function main(): Promise<void> {
  const config = loadConfig();
  const missing = validateConfig(config);
  if (missing.length) {
    console.error("Missing required config: " + missing.join(", "));
    console.error("Set them in your environment or a .env file (see .env.example).");
    process.exit(1);
  }
  const tg = new TelegramClient(config.telegramToken);
  const bot = new TelemachusBot(config, tg);
  await bot.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
