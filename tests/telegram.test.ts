import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Api } from "grammy";
import { openDatabase } from "../src/db/database.js";
import { Service } from "../src/service.js";
import { publish, sendContent } from "../src/telegram.js";
import { saveTemplate, template } from "../src/templates.js";
import { enqueue, flushNotifications } from "../src/notifications.js";
import { notifications } from "../src/db/schema.js";
let store: ReturnType<typeof openDatabase>, s: Service;
beforeEach(() => {
  store = openDatabase(":memory:");
  store.migrate();
  s = new Service(store, 1);
  s.touch(1, "Owner");
  s.touch(2, "Author");
});
afterEach(() => {
  store.sqlite.close();
  vi.useRealTimers();
});
function pending() {
  vi.useFakeTimers();
  const d = s.draft(2);
  s.edit(2, d.id, "Новость");
  vi.advanceTimersByTime(3000);
  s.submit(2, d.id, s.get(d.id).version);
  return s.get(d.id);
}
function api(mode: "ok" | "timeout" | "forbidden" | "flood" = "ok") {
  const client = new Api("123456:fake_token_used_only_with_mock_transport", {
    fetch: async (input: unknown) => {
      if (mode === "timeout") throw new Error("timeout");
      if (mode === "forbidden")
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 403,
            description: "Forbidden",
          }),
        );
      if (mode === "flood")
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 30 },
          }),
        );
      const message = {
        message_id: 123,
        date: 1,
        chat: { id: -100123, type: "channel" as const, title: "Test" },
      };
      return new Response(
        JSON.stringify({
          ok: true,
          result: String(input).endsWith("sendMediaGroup")
            ? [message, { ...message, message_id: 124 }]
            : message,
        }),
      );
    },
  });
  return client;
}
it("publishes once and persists message IDs", async () => {
  const d = pending();
  await publish(s, api(), "-100123", 1, d.id, d.version);
  expect(s.get(d.id).delivery).toBe("published");
  await expect(
    publish(s, api(), "-100123", 1, d.id, d.version),
  ).rejects.toThrow();
});
it("does not automatically retry an unknown outcome", async () => {
  const d = pending();
  await expect(
    publish(s, api("timeout"), "-100123", 1, d.id, d.version),
  ).rejects.toThrow("неизвестен");
  expect(s.get(d.id).delivery).toBe("needs_review");
});
it("records explicit Telegram failure separately", async () => {
  const d = pending();
  await expect(
    publish(s, api("forbidden"), "-100123", 1, d.id, d.version),
  ).rejects.toThrow("отклонил");
  expect(s.get(d.id).delivery).toBe("failed");
});
it("sends photos as one media group", async () => {
  const d = s.draft(2);
  for (let i = 1; i <= 2; i++)
    s.addMedia(2, d.id, {
      kind: "photo",
      fileId: "f" + i,
      uniqueId: "u" + i,
      messageId: i,
      groupId: "g",
    });
  expect(await sendContent(api(), 2, s.content(d.id))).toEqual([123, 124]);
});
it("validates template variables and renders without evaluation", () => {
  saveTemplate(store, "rejected", "#{submission_id}: {reason}");
  expect(
    template(store, "rejected", { submission_id: "1", reason: "Причина" }),
  ).toBe("#1: Причина");
  expect(() => saveTemplate(store, "rejected", "{secret}")).toThrow();
});
it("persists successful notification", async () => {
  enqueue(store, 2, "Hello");
  await flushNotifications(store, api());
  expect(store.db.select().from(notifications).get()?.status).toBe("sent");
});
it("honors retry_after and keeps uncertain notification for review", async () => {
  enqueue(store, 2, "Hello");
  await flushNotifications(store, api("flood"));
  const row = store.db.select().from(notifications).get();
  expect(row?.status).toBe("pending");
  expect(row?.nextAt).toBeGreaterThan(Date.now() + 29000);
});
