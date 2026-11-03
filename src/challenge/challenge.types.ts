export type ChallengeStatus = 'PENDING' | 'ACCEPTING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';

export type ChallengeRecord = {
  id: string;
  gameModeId: string;
  challengerId: string;
  opponentId: string;
  status: ChallengeStatus;
  createdAt: string;
  expiresAt: string;
  match?: unknown;
};

export type ChallengeView = ChallengeRecord & {
  challengerName?: string;
  opponentName?: string;
};
