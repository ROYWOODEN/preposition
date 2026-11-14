import type { Api } from "grammy";
import { UserError } from "./errors.js";
export async function isSubscriber(api: Api, channel: string, id: number) {
  try {
    const member = await api.getChatMember(channel, id);
    return (
      member.status === "creator" ||
      member.status === "administrator" ||
      member.status === "member" ||
      (member.status === "restricted" && member.is_member)
    );
  } catch {
    throw new UserError(
      "Не удалось проверить подписку. Попробуйте ещё раз через несколько секунд. Если ошибка повторяется, сообщите владельцу.",
    );
  }
}
