import { loadEnvFile } from "node:process";
import { Api, GrammyError } from "grammy";
import { readConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { users } from "../src/db/schema.js";
try {
  loadEnvFile();
} catch {
  /* Config validation reports field names only. */
}
const config = readConfig(process.env),
  api = new Api(config.BOT_TOKEN),
  store = openDatabase(config.DATABASE_PATH);
try {
  store.assertReady();
  const me = await api.getMe();
  const own = await api.getChatMember(config.TARGET_CHANNEL_ID, me.id);
  const rows = store.db.select().from(users).limit(20).all();
  let privateProfiles = 0,
    channelProfiles = 0,
    currentUsernames = 0;
  for (const user of rows) {
    try {
      const chat = await api.getChat(user.id);
      if (chat.type === "private") {
        privateProfiles++;
        if ((chat.username ?? null) === user.username) currentUsernames++;
      }
    } catch {
      /* Count availability without exposing user data. */
    }
    try {
      const member = await api.getChatMember(config.TARGET_CHANNEL_ID, user.id);
      if (member.user.id === user.id) channelProfiles++;
    } catch {
      /* Report totals only. */
    }
  }
  console.log(
    JSON.stringify({
      schema: "ready",
      botRole: own.status,
      canPublish: own.status === "administrator" && own.can_post_messages,
      knownUsersChecked: rows.length,
      privateProfilesAvailable: privateProfiles,
      channelProfilesAvailable: channelProfiles,
      cachedUsernamesCurrent: currentUsernames,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      check: "failed",
      kind: error instanceof Error ? error.name : "unknown",
      telegramCode: error instanceof GrammyError ? error.error_code : undefined,
    }),
  );
  process.exitCode = 1;
} finally {
  store.sqlite.close();
}
