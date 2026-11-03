import { MatchStatus } from '../generated/prisma/enums';
import {
  COMMITTED_MATCH_STATUSES,
  isCommittedMatchStatus,
  isRecoverableMatchStatus,
  PREMATCH_ORPHAN_STATUSES,
  RECOVERABLE_MATCH_STATUSES,
} from './match-status';

describe('match-status definitions', () => {
  it('classifies recoverable vs committed statuses', () => {
    expect(RECOVERABLE_MATCH_STATUSES).toEqual([
      MatchStatus.READY,
      MatchStatus.PLAYING,
      MatchStatus.FINISHING,
    ]);
    expect(COMMITTED_MATCH_STATUSES).toEqual([
      MatchStatus.CREATED,
      MatchStatus.WAITING,
      MatchStatus.READY,
      MatchStatus.PLAYING,
      MatchStatus.FINISHING,
    ]);
    expect(PREMATCH_ORPHAN_STATUSES).toEqual([MatchStatus.CREATED, MatchStatus.WAITING]);

    expect(isCommittedMatchStatus(MatchStatus.CREATED)).toBe(true);
    expect(isCommittedMatchStatus(MatchStatus.WAITING)).toBe(true);
    expect(isCommittedMatchStatus(MatchStatus.READY)).toBe(true);
    expect(isCommittedMatchStatus(MatchStatus.PLAYING)).toBe(true);
    expect(isCommittedMatchStatus(MatchStatus.FINISHING)).toBe(true);
    expect(isCommittedMatchStatus(MatchStatus.FINISHED)).toBe(false);
    expect(isCommittedMatchStatus(MatchStatus.CANCELLED)).toBe(false);
    expect(isCommittedMatchStatus(MatchStatus.ABORTED)).toBe(false);

    expect(isRecoverableMatchStatus(MatchStatus.READY)).toBe(true);
    expect(isRecoverableMatchStatus(MatchStatus.PLAYING)).toBe(true);
    expect(isRecoverableMatchStatus(MatchStatus.FINISHING)).toBe(true);
    expect(isRecoverableMatchStatus(MatchStatus.CREATED)).toBe(false);
    expect(isRecoverableMatchStatus(MatchStatus.WAITING)).toBe(false);
    expect(isRecoverableMatchStatus(MatchStatus.FINISHED)).toBe(false);
  });
});
