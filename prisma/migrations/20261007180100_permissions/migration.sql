CREATE TABLE "Permission" (
    "code" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "UserPermission" (
    "userId" TEXT NOT NULL,
    "permissionCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPermission_pkey" PRIMARY KEY ("userId","permissionCode")
);

CREATE INDEX "UserPermission_permissionCode_idx" ON "UserPermission"("permissionCode");

ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_permissionCode_fkey" FOREIGN KEY ("permissionCode") REFERENCES "Permission"("code") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "User_nida_staff_key";
CREATE UNIQUE INDEX "User_nida_staff_key" ON "User"("nida") WHERE "role" IN ('ADMIN', 'AGENT', 'MASTER_AGENT');

INSERT INTO "Permission" ("code", "group", "label", "sensitive") VALUES
  ('DASHBOARD_VIEW', 'Dashboard', 'Dashboard', false),
  ('WAKALA_VIEW', 'Wakala', 'View Wakala', false),
  ('WAKALA_CREATE', 'Wakala', 'Create Wakala', false),
  ('WAKALA_UPDATE', 'Wakala', 'Update Wakala', false),
  ('WAKALA_BLOCK', 'Wakala', 'Block Wakala', false),
  ('WAKALA_UNBLOCK', 'Wakala', 'Unblock Wakala', false),
  ('MASTER_WAKALA_VIEW', 'Master Wakala', 'View Master Wakala', true),
  ('MASTER_WAKALA_CREATE', 'Master Wakala', 'Create Master Wakala', true),
  ('MASTER_WAKALA_UPDATE', 'Master Wakala', 'Update Master Wakala', true),
  ('MASTER_WAKALA_BLOCK', 'Master Wakala', 'Block Master Wakala', true),
  ('MASTER_WAKALA_UNBLOCK', 'Master Wakala', 'Unblock Master Wakala', true),
  ('MASTER_WAKALA_PERMISSION_MANAGE', 'Master Wakala', 'Manage Master Wakala permissions', true),
  ('CONDUCTOR_VIEW', 'Conductors', 'View Conductors', false),
  ('CONDUCTOR_CREATE', 'Conductors', 'Create Conductors', false),
  ('CONDUCTOR_UPDATE', 'Conductors', 'Update Conductors', false),
  ('CONDUCTOR_BLOCK', 'Conductors', 'Block Conductors', false),
  ('CONDUCTOR_UNBLOCK', 'Conductors', 'Unblock Conductors', false),
  ('CARD_VIEW', 'D-Cards', 'View D-Cards', false),
  ('CARD_REPLACE', 'D-Cards', 'Replace D-Cards', true),
  ('REPORT_WAKALA_VIEW', 'Reports', 'Wakala Reports', false),
  ('REPORT_CONDUCTOR_VIEW', 'Reports', 'Conductor Reports', false),
  ('MOBILE_MONEY_VIEW', 'Payments', 'Mobile Money', false),
  ('PAYOUT_VIEW', 'Payments', 'Payouts', false),
  ('FINANCIAL_REVENUE_VIEW', 'Financial', 'Financial Revenue', true),
  ('FINANCIAL_LEDGER_VIEW', 'Financial', 'Financial Ledger', true),
  ('FINANCIAL_RECONCILIATION_VIEW', 'Financial', 'Financial Reconciliation', true),
  ('FINANCIAL_COMPANY_VIEW', 'Financial', 'Company Finance', true),
  ('FINANCIAL_COMMISSION_VIEW', 'Financial', 'Wakala Commissions', true),
  ('SMS_VIEW', 'SMS', 'View SMS', false),
  ('SMS_SEND', 'SMS', 'Send SMS', true),
  ('SYSTEM_SETTINGS_VIEW', 'System', 'View Settings', false),
  ('SYSTEM_SETTINGS_UPDATE', 'System', 'Update Settings', true),
  ('AUDIT_LOG_VIEW', 'Security', 'Audit Logs', true),
  ('PERMISSION_MANAGE', 'Security', 'Manage Permissions', true)
ON CONFLICT ("code") DO NOTHING;
