import { z } from "zod";
export const configSchema = z.object({
  BOT_TOKEN: z.string().regex(/^\d+:[\w-]{30,}$/),
  OWNER_TELEGRAM_ID: z.coerce.number().int().positive().safe(),
  TARGET_CHANNEL_ID: z.string().regex(/^-100\d+$/),
  DATABASE_PATH: z.string().min(1).default("./data/bot.sqlite"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});
export function readConfig(env: NodeJS.ProcessEnv) {
  const result = configSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      "Проверьте .env: " +
        result.error.issues.map((i) => i.path.join(".")).join(", "),
    );
  return result.data;
}
