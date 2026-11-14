import { UserError } from "./errors.js";
import { z } from "zod";
import type { MessageEntity } from "grammy/types";
const entitySchema = z.object({
  type: z.enum([
    "mention",
    "hashtag",
    "cashtag",
    "bot_command",
    "url",
    "email",
    "phone_number",
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "spoiler",
    "blockquote",
    "expandable_blockquote",
    "code",
    "pre",
    "text_link",
    "text_mention",
    "custom_emoji",
  ]),
  offset: z.number().int(),
  length: z.number().int(),
  url: z.string().optional(),
  language: z.string().optional(),
  custom_emoji_id: z.string().optional(),
  user: z
    .object({
      id: z.number(),
      is_bot: z.boolean(),
      first_name: z.string(),
      last_name: z.string().optional(),
      username: z.string().optional(),
    })
    .optional(),
});
export function parseEntities(json: string): MessageEntity[] {
  return z
    .array(entitySchema)
    .parse(JSON.parse(json))
    .map((entity): MessageEntity => {
      const base = { offset: entity.offset, length: entity.length };
      switch (entity.type) {
        case "text_link":
          return {
            ...base,
            type: entity.type,
            url: z.string().parse(entity.url),
          };
        case "text_mention":
          if (!entity.user)
            throw new UserError("Отсутствует пользователь в форматировании.");
          return { ...base, type: entity.type, user: entity.user };
        case "custom_emoji":
          return {
            ...base,
            type: entity.type,
            custom_emoji_id: z.string().parse(entity.custom_emoji_id),
          };
        case "pre":
          return { ...base, type: entity.type, language: entity.language };
        default:
          return { ...base, type: entity.type };
      }
    });
}
export function compose(
  body: string,
  entities: string,
  author: { id: number; name: string; username: string | null },
  anonymous: boolean,
  hasMedia: boolean,
) {
  const suffix = anonymous
    ? "Автор поста: Анонимно"
    : `Автор поста: ${author.username ? "@" + author.username : author.name}`;
  const text = body + (body ? "\n\n" : "") + suffix;
  if (text.length > (hasMedia ? 1024 : 4096))
    throw new UserError(
      `Сократите текст: вместе с подписью допускается ${hasMedia ? 1024 : 4096} символов.`,
    );
  const result = parseEntities(entities);
  if (!anonymous && !author.username)
    result.push({
      type: "text_link",
      offset: text.length - author.name.length,
      length: author.name.length,
      url: `tg://user?id=${author.id}`,
    });
  return { text, entities: result };
}
