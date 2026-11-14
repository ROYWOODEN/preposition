import { eq } from "drizzle-orm";
import type { Service } from "./service.js";
import * as t from "./db/schema.js";
import { defaults, saveTemplate, template } from "./templates.js";
import { UserError } from "./errors.js";
export const isReasonKey = (key: string) => /^reason\d{1,6}$/.test(key);
export function reasons(s: Service) {
  const keys = new Set([
    ...Object.keys(defaults).filter(isReasonKey),
    ...s.store.db
      .select()
      .from(t.templates)
      .all()
      .map((t) => t.key)
      .filter(isReasonKey),
  ]);
  return [...keys]
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
    .filter((key) => s.setting("hidden_" + key, "false") !== "true")
    .map((key) => ({ key, text: template(s.store, key) }));
}
export function reason(s: Service, key: string) {
  const result = reasons(s).find((r) => r.key === key);
  if (!result)
    throw new UserError("Эта причина удалена. Откройте список причин заново.");
  return result.text;
}
export function addReason(s: Service, actor: number, text: string) {
  s.admin(actor);
  if (reasons(s).length >= 20)
    throw new UserError("Можно сохранить до 20 причин. Удалите ненужные.");
  const keys = [
    ...Object.keys(defaults),
    ...s.store.db
      .select()
      .from(t.templates)
      .all()
      .map((t) => t.key),
  ].filter(isReasonKey);
  const key = "reason" + (Math.max(...keys.map((k) => Number(k.slice(6)))) + 1);
  saveTemplate(s.store, key, text);
  s.audit(actor, null, "reason:add");
  return key;
}
export function deleteReason(s: Service, actor: number, key: string) {
  s.admin(actor);
  reason(s, key);
  s.set("hidden_" + key, "true");
  s.audit(actor, null, "reason:delete");
}
export function resetSettings(s: Service, actor: number) {
  s.admin(actor);
  s.store.sqlite.transaction(() => {
    s.store.db.delete(t.settings).run();
    s.store.db.delete(t.templates).run();
    s.audit(actor, null, "settings:reset");
  })();
}
export function resetReason(s: Service, actor: number, key: string) {
  s.admin(actor);
  if (!Object.hasOwn(defaults, key))
    throw new UserError("У этой причины нет стандартного текста.");
  s.store.db.delete(t.templates).where(eq(t.templates.key, key)).run();
}
