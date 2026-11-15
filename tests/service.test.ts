import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db/database.js";
import { Service } from "../src/service.js";
import { compose } from "../src/content.js";
import { readConfig } from "../src/config.js";
import * as t from "../src/db/schema.js";
import { grantModerator, removeModerator } from "../src/people.js";
describe("SQLite and business rules", () => {
  let store: ReturnType<typeof openDatabase>, s: Service;
  it("delegates administration without letting heads change protected roles", () => {
    s.touch(4, "Other head");
    s.touch(5, "Candidate");
    expect(() => s.admin(3)).toThrow();
    grantModerator(s, 1, 4);
    s.promoteModerator(1, 3);
    s.promoteModerator(1, 4);
    expect(() => s.admin(3)).not.toThrow();
    grantModerator(s, 3, 5);
    expect(s.isMod(5)).toBe(true);
    expect(() => s.promoteModerator(3, 5)).toThrow();
    for (const protectedId of [1, 3, 4])
      expect(() => removeModerator(s, 3, protectedId)).toThrow();
    removeModerator(s, 3, 5);
    expect(s.isMod(5)).toBe(false);
    removeModerator(s, 1, 3);
    expect(s.isAdmin(3)).toBe(false);
  });
  beforeEach(() => {
    store = openDatabase(":memory:");
    store.migrate();
    s = new Service(store, 1);
    s.touch(1, "Owner");
    s.touch(2, "Author");
    s.touch(3, "Moderator");
    store.db.insert(t.moderators).values({ id: 3 }).run();
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
  it("validates env without leaking token", () => {
    expect(() => readConfig({ BOT_TOKEN: "secret" })).toThrow("BOT_TOKEN");
    expect(() => readConfig({ BOT_TOKEN: "secret" })).not.toThrow("secret");
  });
  it("keeps one draft and persists edits", () => {
    const d = s.draft(2);
    expect(s.draft(2).id).toBe(d.id);
    s.edit(2, d.id, "Текст");
    expect(s.get(d.id).body).toBe("Текст");
  });
  it("prevents access to another author draft", () => {
    const d = s.draft(2);
    s.touch(4, "Other");
    expect(() => s.edit(4, d.id, "hack")).toThrow();
  });
  it("allows exactly one concurrent approval", () => {
    const d = pending();
    s.claim(1, d.id, d.version);
    expect(() => s.claim(3, d.id, d.version)).toThrow();
    expect(s.get(d.id).delivery).toBe("publishing");
  });
  it("invalidates stale approval after edit", () => {
    const d = pending();
    s.edit(2, d.id, "Исправлено");
    expect(() => s.claim(1, d.id, d.version)).toThrow();
  });
  it("requires reason and informs stored state", () => {
    const d = pending();
    expect(() => s.reject(3, d.id, d.version, "")).toThrow();
    s.reject(3, d.id, d.version, "Спам");
    expect(s.get(d.id).reason).toBe("Спам");
  });
  it("recovers uncertain operations without re-sending", () => {
    const d = pending();
    s.claim(1, d.id, d.version);
    s.recover();
    expect(s.get(d.id).delivery).toBe("needs_review");
  });
  it("enforces blocked user", () => {
    store.db
      .update(t.users)
      .set({ blocked: true })
      .where(eq(t.users.id, 2))
      .run();
    expect(() => s.draft(2)).toThrow("заблокирован");
  });
  it("enforces active limit", () => {
    pending();
    vi.advanceTimersByTime(61000);
    s.set("limit", "1");
    const d = s.draft(2);
    s.edit(2, d.id, "Другая");
    vi.advanceTimersByTime(3000);
    expect(() => s.submit(2, d.id, s.get(d.id).version)).toThrow("лимит");
  });
  it("deduplicates album media and rejects invalid mix", () => {
    const d = s.draft(2);
    const file = {
      kind: "photo" as const,
      fileId: "f",
      uniqueId: "u",
      messageId: 10,
      groupId: "g",
    };
    s.addMedia(2, d.id, file);
    s.addMedia(2, d.id, file);
    expect(s.files(d.id)).toHaveLength(1);
    expect(() =>
      s.addMedia(2, d.id, { ...file, kind: "voice", messageId: 11 }),
    ).toThrow();
  });
  it("checks membership on each operation", () => {
    const d = pending();
    store.db.delete(t.moderators).where(eq(t.moderators.id, 3)).run();
    expect(() => s.reject(3, d.id, d.version, "Причина")).toThrow();
  });
  it("does not split oversized caption", () => {
    expect(() =>
      compose("а".repeat(1024), "[]", s.user(2), false, true),
    ).toThrow("Сократите");
  });
  it("retains entities and links author without username", () => {
    const c = compose(
      "Тест",
      '[{"type":"bold","offset":0,"length":4}]',
      s.user(2),
      false,
      false,
    );
    expect(c.entities).toHaveLength(2);
    expect(c.entities[1]).toMatchObject({
      type: "text_link",
      url: "tg://user?id=2",
    });
    expect(compose("Тест", "[]", s.user(2), true, false).text).not.toContain(
      "Author",
    );
  });
});
