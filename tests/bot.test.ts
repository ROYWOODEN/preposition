import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { Service } from "../src/service.js";
import { createBot } from "../src/bot.js";
import type { Update } from "grammy/types";
let store: ReturnType<typeof openDatabase>,
  service: Service,
  bot: ReturnType<typeof createBot>;
let sequence = 0;
beforeEach(async () => {
  store = openDatabase(":memory:");
  store.migrate();
  service = new Service(store, 1);
  bot = createBot(
    "123456:mock_token",
    "-100123",
    service,
    () => {},
    async (input) => {
      const method = String(input).split("/").at(-1);
      const result =
        method === "getMe"
          ? { id: 100, is_bot: true, first_name: "Bot", username: "test_bot" }
          : method === "getChatMember"
            ? {
                status: "member",
                user: { id: 2, is_bot: false, first_name: "Author" },
              }
            : method === "answerCallbackQuery"
              ? true
              : {
                  message_id: 999,
                  date: 1,
                  chat: { id: 2, type: "private", first_name: "Author" },
                  text: "x",
                };
      return new Response(JSON.stringify({ ok: true, result }));
    },
  );
  await bot.init();
});
afterEach(() => {
  store.sqlite.close();
  vi.useRealTimers();
});
function message(text: string, id = 2): Update {
  return {
    update_id: ++sequence,
    message: {
      message_id: sequence,
      date: 1,
      chat: { id, type: "private", first_name: "Author" },
      from: { id, is_bot: false, first_name: "Author" },
      text,
      ...(text.startsWith("/")
        ? {
            entities: [
              { type: "bot_command" as const, offset: 0, length: text.length },
            ],
          }
        : {}),
    },
  };
}
function callback(data: string, id = 2): Update {
  return {
    update_id: ++sequence,
    callback_query: {
      id: String(sequence),
      from: { id, is_bot: false, first_name: "Author" },
      chat_instance: "test",
      data,
      message: {
        message_id: 999,
        date: 1,
        chat: { id, type: "private", first_name: "Author" },
        text: "card",
      },
    },
  };
}
it("runs draft, preview and submission through Telegram handlers", async () => {
  vi.useFakeTimers();
  await bot.handleUpdate(message("/start"));
  await bot.handleUpdate(message("📝 Предложить пост"));
  await bot.handleUpdate(message("Текст новости"));
  vi.advanceTimersByTime(3000);
  const d = service.draft(2);
  await bot.handleUpdate(callback(`view:${d.id}`));
  vi.advanceTimersByTime(1000);
  await bot.handleUpdate(callback(`submit:${d.id}:${d.version}`));
  expect(service.get(d.id).status).toBe("pending");
});
it("ignores redelivered source messages", async () => {
  await bot.handleUpdate(message("📝 Предложить пост"));
  const update = message("Текст");
  await bot.handleUpdate(update);
  const version = service.draft(2).version;
  await bot.handleUpdate(update);
  expect(service.draft(2).version).toBe(version);
});
it("rejects forged owner callbacks", async () => {
  await bot.handleUpdate(callback("setting:accepting"));
  expect(service.setting("accepting", "true")).toBe("true");
});
