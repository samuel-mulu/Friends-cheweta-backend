import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BroadcastKind, FeedbackCategory, FeedbackStatus } from '../generated/prisma/enums';

const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

export class InboxQuery {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page = 1;
}

export class BroadcastInboxQuery extends InboxQuery {
  @IsOptional()
  @IsUUID()
  spotlightId?: string;
}

export class FeedbackQuery extends InboxQuery {
  @IsOptional()
  @IsEnum(FeedbackStatus)
  status?: FeedbackStatus;

  @IsOptional()
  @IsEnum(FeedbackCategory)
  category?: FeedbackCategory;
}

export class CreateBroadcastDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  body!: string;

  @IsOptional()
  @IsEnum(BroadcastKind)
  category?: BroadcastKind;

  @IsOptional()
  @IsUUID()
  expectedLiveId?: string | null;
}

export class SetBroadcastLiveDto {
  @IsBoolean()
  live!: boolean;

  @IsOptional()
  @IsUUID()
  expectedLiveId?: string | null;
}

export class DismissBroadcastDto {
  @IsInt()
  @Min(1)
  revision!: number;
}

export class SubmitFeedbackDto {
  @IsEnum(FeedbackCategory)
  category!: FeedbackCategory;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  message!: string;

  @IsUUID()
  requestId!: string;
}

export class UpdateFeedbackDto {
  @IsOptional()
  @IsEnum(FeedbackStatus)
  status?: FeedbackStatus;

  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  adminReply?: string;
}

export class StartFeedbackDto {
  @IsUUID()
  userId!: string;

  @IsOptional()
  @IsEnum(FeedbackCategory)
  category?: FeedbackCategory;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  adminReply!: string;
}

export class MarkFeedbackSeenDto {
  @Matches(/^(0|[1-9]\d{0,18})$/)
  seenThrough!: string;
}
