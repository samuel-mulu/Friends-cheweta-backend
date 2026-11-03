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
