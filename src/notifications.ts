import { GrammyError, type Api } from "grammy";
import { and, eq, lt, lte } from "drizzle-orm";
import type { Store } from "./db/database.js";
import { notifications } from "./db/schema.js";
export function enqueue(
  store: Store,
  userId: number,
  body: string,
  button?: { text: string; callback: string },
) {
  store.db
    .insert(notifications)
    .values({
      userId,
      body,
      nextAt: Date.now(),
      buttonText: button?.text,
      buttonCallback: button?.callback,
    })
    .run();
}
export async function flushNotifications(store: Store, api: Api) {
  const rows = store.db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.status, "pending"),
        lt(notifications.tries, 5),
        lte(notifications.nextAt, Date.now()),
      ),
    )
    .limit(10)
    .all();
  for (const row of rows) {
    const claimed = store.db
      .update(notifications)
      .set({ status: "sending", tries: row.tries + 1 })
      .where(
        and(eq(notifications.id, row.id), eq(notifications.status, "pending")),
      )
      .run();
    if (!claimed.changes) continue;
    try {
      await api.sendMessage(
        row.userId,
        row.body,
        row.buttonText && row.buttonCallback
          ? {
              reply_markup: {
                inline_keyboard: [
                  [{ text: row.buttonText, callback_data: row.buttonCallback }],
                ],
              },
            }
          : {},
      );
      store.db
        .update(notifications)
        .set({ status: "sent" })
        .where(eq(notifications.id, row.id))
        .run();
    } catch (error) {
      const retry = error instanceof GrammyError && error.error_code === 429;
      store.db
        .update(notifications)
        .set({
          status: retry
            ? "pending"
            : error instanceof GrammyError
              ? "failed"
              : "needs_review",
          nextAt:
            Date.now() +
            1000 * (retry ? (error.parameters.retry_after ?? 60) : 60),
        })
        .where(eq(notifications.id, row.id))
        .run();
    }
  }
}
