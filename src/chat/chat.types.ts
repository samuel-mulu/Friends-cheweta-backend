import { BadRequestException } from '@nestjs/common';

export type ChatScope = 'LOBBY' | 'MATCH';

export type ChatMessage = {
  id: string;
  scope: ChatScope;
  scopeId: string;
  sender: {
    userId: string;
    displayName: string;
  };
  text: string;
  createdAt: string;
};

export const CHAT_MAX_LENGTH = 160;

/** One rule for every chat: trimmed, non-empty, at most 160 characters. */
export function normalizeChatText(value: string): string {
  const text = value.trim();
  if (!text)
    throw new BadRequestException({
      code: 'CHAT_MESSAGE_EMPTY',
      message: 'Message cannot be empty.',
    });
  if ([...text].length > CHAT_MAX_LENGTH) {
    throw new BadRequestException({
      code: 'CHAT_MESSAGE_TOO_LONG',
      message: 'Message is too long.',
    });
  }
  return text;
}
