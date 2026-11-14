import { UserError } from "./errors.js";
import type { Api } from "grammy";
import type { InputMediaPhoto, InputMediaVideo } from "grammy/types";
import { GrammyError } from "grammy";
import { eq } from "drizzle-orm";
import type { Service } from "./service.js";
import * as t from "./db/schema.js";
import { enqueue } from "./notifications.js";
import { template } from "./templates.js";
export async function sendContent(
  api: Api,
  chat: number | string,
  content: ReturnType<Service["content"]>,
) {
  const { text, entities, files } = content;
  if (files.length > 1) {
    const album: (InputMediaPhoto | InputMediaVideo)[] = files.map((f, i) => {
      if (f.kind !== "photo" && f.kind !== "video")
        throw new UserError("Несовместимый альбом.");
      return {
        type: f.kind,
        media: f.fileId,
        ...(i === 0 ? { caption: text, caption_entities: entities } : {}),
      };
    });
    return (await api.sendMediaGroup(chat, album)).map((m) => m.message_id);
  }
  const file = files[0];
  if (!file)
    return [(await api.sendMessage(chat, text, { entities })).message_id];
  const options = { caption: text, caption_entities: entities };
  const methods = {
    photo: api.sendPhoto.bind(api),
    video: api.sendVideo.bind(api),
    document: api.sendDocument.bind(api),
    animation: api.sendAnimation.bind(api),
    audio: api.sendAudio.bind(api),
    voice: api.sendVoice.bind(api),
  };
  return [(await methods[file.kind](chat, file.fileId, options)).message_id];
}
export async function publish(
  service: Service,
  api: Api,
  channel: string,
  actor: number,
  id: number,
  version: number,
) {
  const content = service.content(id);
  const attempt = service.claim(actor, id, version);
  try {
    const ids = await sendContent(api, channel, content);
    service.store.sqlite.transaction(() => {
      service.store.db
        .update(t.attempts)
        .set({ result: "published", messageIds: JSON.stringify(ids) })
        .where(eq(t.attempts.id, attempt.id))
        .run();
      service.store.db
        .update(t.submissions)
        .set({ delivery: "published", publishedAt: Date.now() })
        .where(eq(t.submissions.id, id))
        .run();
      enqueue(
        service.store,
        service.get(id).authorId,
        template(service.store, "published", {
          submission_id: String(service.localNumber(id)),
        }),
        { text: "📋 Открыть мою заявку", callback: `view:${id}` },
      );
    })();
  } catch (error) {
    const result =
      error instanceof GrammyError && [400, 403, 429].includes(error.error_code)
        ? "failed"
        : "needs_review";
    service.store.db
      .update(t.attempts)
      .set({ result })
      .where(eq(t.attempts.id, attempt.id))
      .run();
    service.store.db
      .update(t.submissions)
      .set({ delivery: result })
      .where(eq(t.submissions.id, id))
      .run();
    throw new UserError(
      result === "failed"
        ? "Telegram отклонил публикацию. Владелец может проверить и вернуть заявку в очередь."
        : "Результат отправки неизвестен. Проверьте канал вручную; автоматического повтора не будет.",
    );
  }
}
