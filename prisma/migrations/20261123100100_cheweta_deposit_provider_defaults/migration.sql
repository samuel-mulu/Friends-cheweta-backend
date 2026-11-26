INSERT INTO "DepositProviderConfig" ("channel", "enabled", "approvalMode", "updatedAt")
VALUES
  ('CBE', true, 'MANUAL', CURRENT_TIMESTAMP),
  ('TELEBIRR', true, 'MANUAL', CURRENT_TIMESTAMP),
  ('AWASH', false, 'MANUAL', CURRENT_TIMESTAMP),
  ('BOA', false, 'MANUAL', CURRENT_TIMESTAMP)
ON CONFLICT ("channel") DO NOTHING;
