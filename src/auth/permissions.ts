export const PermissionCode = {
  DASHBOARD_VIEW: 'DASHBOARD_VIEW',
  WAKALA_VIEW: 'WAKALA_VIEW',
  WAKALA_CREATE: 'WAKALA_CREATE',
  WAKALA_UPDATE: 'WAKALA_UPDATE',
  WAKALA_BLOCK: 'WAKALA_BLOCK',
  WAKALA_UNBLOCK: 'WAKALA_UNBLOCK',
  MASTER_WAKALA_VIEW: 'MASTER_WAKALA_VIEW',
  MASTER_WAKALA_CREATE: 'MASTER_WAKALA_CREATE',
  MASTER_WAKALA_UPDATE: 'MASTER_WAKALA_UPDATE',
  MASTER_WAKALA_BLOCK: 'MASTER_WAKALA_BLOCK',
  MASTER_WAKALA_UNBLOCK: 'MASTER_WAKALA_UNBLOCK',
  MASTER_WAKALA_PERMISSION_MANAGE: 'MASTER_WAKALA_PERMISSION_MANAGE',
  CONDUCTOR_VIEW: 'CONDUCTOR_VIEW',
  CONDUCTOR_CREATE: 'CONDUCTOR_CREATE',
  CONDUCTOR_UPDATE: 'CONDUCTOR_UPDATE',
  CONDUCTOR_BLOCK: 'CONDUCTOR_BLOCK',
  CONDUCTOR_UNBLOCK: 'CONDUCTOR_UNBLOCK',
  CARD_VIEW: 'CARD_VIEW',
  CARD_REPLACE: 'CARD_REPLACE',
  REPORT_WAKALA_VIEW: 'REPORT_WAKALA_VIEW',
  REPORT_CONDUCTOR_VIEW: 'REPORT_CONDUCTOR_VIEW',
  MOBILE_MONEY_VIEW: 'MOBILE_MONEY_VIEW',
  PAYOUT_VIEW: 'PAYOUT_VIEW',
  FINANCIAL_REVENUE_VIEW: 'FINANCIAL_REVENUE_VIEW',
  FINANCIAL_LEDGER_VIEW: 'FINANCIAL_LEDGER_VIEW',
  FINANCIAL_RECONCILIATION_VIEW: 'FINANCIAL_RECONCILIATION_VIEW',
  FINANCIAL_COMPANY_VIEW: 'FINANCIAL_COMPANY_VIEW',
  FINANCIAL_COMMISSION_VIEW: 'FINANCIAL_COMMISSION_VIEW',
  SMS_VIEW: 'SMS_VIEW',
  SMS_SEND: 'SMS_SEND',
  SYSTEM_SETTINGS_VIEW: 'SYSTEM_SETTINGS_VIEW',
  SYSTEM_SETTINGS_UPDATE: 'SYSTEM_SETTINGS_UPDATE',
  AUDIT_LOG_VIEW: 'AUDIT_LOG_VIEW',
  PERMISSION_MANAGE: 'PERMISSION_MANAGE',
} as const;

export type PermissionCode =
  (typeof PermissionCode)[keyof typeof PermissionCode];

export type PermissionDefinition = {
  code: PermissionCode;
  group: string;
  label: string;
  sensitive: boolean;
  /** Held by ADMIN automatically. Never stored on a MASTER_AGENT. */
  adminOnly: boolean;
};

export const PERMISSION_CATALOG: PermissionDefinition[] = [
  { code: PermissionCode.DASHBOARD_VIEW, group: 'Dashboard', label: 'Dashboard', sensitive: false, adminOnly: false },
  { code: PermissionCode.WAKALA_VIEW, group: 'Wakala', label: 'View Wakala', sensitive: false, adminOnly: false },
  { code: PermissionCode.WAKALA_CREATE, group: 'Wakala', label: 'Create Wakala', sensitive: false, adminOnly: false },
  { code: PermissionCode.WAKALA_UPDATE, group: 'Wakala', label: 'Update Wakala', sensitive: false, adminOnly: false },
  { code: PermissionCode.WAKALA_BLOCK, group: 'Wakala', label: 'Block Wakala', sensitive: false, adminOnly: false },
  { code: PermissionCode.WAKALA_UNBLOCK, group: 'Wakala', label: 'Unblock Wakala', sensitive: false, adminOnly: false },
  { code: PermissionCode.MASTER_WAKALA_VIEW, group: 'Master Wakala', label: 'View Master Wakala', sensitive: true, adminOnly: true },
  { code: PermissionCode.MASTER_WAKALA_CREATE, group: 'Master Wakala', label: 'Create Master Wakala', sensitive: true, adminOnly: true },
  { code: PermissionCode.MASTER_WAKALA_UPDATE, group: 'Master Wakala', label: 'Update Master Wakala', sensitive: true, adminOnly: true },
  { code: PermissionCode.MASTER_WAKALA_BLOCK, group: 'Master Wakala', label: 'Block Master Wakala', sensitive: true, adminOnly: true },
  { code: PermissionCode.MASTER_WAKALA_UNBLOCK, group: 'Master Wakala', label: 'Unblock Master Wakala', sensitive: true, adminOnly: true },
  { code: PermissionCode.MASTER_WAKALA_PERMISSION_MANAGE, group: 'Master Wakala', label: 'Manage Master Wakala permissions', sensitive: true, adminOnly: true },
  { code: PermissionCode.CONDUCTOR_VIEW, group: 'Conductors', label: 'View Conductors', sensitive: false, adminOnly: false },
  { code: PermissionCode.CONDUCTOR_CREATE, group: 'Conductors', label: 'Create Conductors', sensitive: false, adminOnly: false },
  { code: PermissionCode.CONDUCTOR_UPDATE, group: 'Conductors', label: 'Update Conductors', sensitive: false, adminOnly: false },
  { code: PermissionCode.CONDUCTOR_BLOCK, group: 'Conductors', label: 'Block Conductors', sensitive: false, adminOnly: false },
  { code: PermissionCode.CONDUCTOR_UNBLOCK, group: 'Conductors', label: 'Unblock Conductors', sensitive: false, adminOnly: false },
  { code: PermissionCode.CARD_VIEW, group: 'D-Cards', label: 'View D-Cards', sensitive: false, adminOnly: false },
  { code: PermissionCode.CARD_REPLACE, group: 'D-Cards', label: 'Replace D-Cards', sensitive: true, adminOnly: false },
  { code: PermissionCode.REPORT_WAKALA_VIEW, group: 'Reports', label: 'Wakala Reports', sensitive: false, adminOnly: false },
  { code: PermissionCode.REPORT_CONDUCTOR_VIEW, group: 'Reports', label: 'Conductor Reports', sensitive: false, adminOnly: false },
  { code: PermissionCode.MOBILE_MONEY_VIEW, group: 'Payments', label: 'Mobile Money', sensitive: false, adminOnly: false },
  { code: PermissionCode.PAYOUT_VIEW, group: 'Payments', label: 'Payouts', sensitive: false, adminOnly: false },
  { code: PermissionCode.FINANCIAL_REVENUE_VIEW, group: 'Financial', label: 'Financial Revenue', sensitive: true, adminOnly: false },
  { code: PermissionCode.FINANCIAL_LEDGER_VIEW, group: 'Financial', label: 'Financial Ledger', sensitive: true, adminOnly: false },
  { code: PermissionCode.FINANCIAL_RECONCILIATION_VIEW, group: 'Financial', label: 'Financial Reconciliation', sensitive: true, adminOnly: false },
  { code: PermissionCode.FINANCIAL_COMPANY_VIEW, group: 'Financial', label: 'Company Finance', sensitive: true, adminOnly: false },
  { code: PermissionCode.FINANCIAL_COMMISSION_VIEW, group: 'Financial', label: 'Wakala Commissions', sensitive: true, adminOnly: false },
  { code: PermissionCode.SMS_VIEW, group: 'SMS', label: 'View SMS', sensitive: false, adminOnly: false },
  { code: PermissionCode.SMS_SEND, group: 'SMS', label: 'Send SMS', sensitive: true, adminOnly: false },
  { code: PermissionCode.SYSTEM_SETTINGS_VIEW, group: 'System', label: 'View Settings', sensitive: false, adminOnly: false },
  { code: PermissionCode.SYSTEM_SETTINGS_UPDATE, group: 'System', label: 'Update Settings', sensitive: true, adminOnly: false },
  { code: PermissionCode.AUDIT_LOG_VIEW, group: 'Security', label: 'Audit Logs', sensitive: true, adminOnly: false },
  { code: PermissionCode.PERMISSION_MANAGE, group: 'Security', label: 'Manage Permissions', sensitive: true, adminOnly: true },
];

export const ALL_PERMISSION_CODES: PermissionCode[] = PERMISSION_CATALOG.map(
  (item) => item.code,
);

export const ASSIGNABLE_PERMISSIONS = PERMISSION_CATALOG.filter(
  (item) => !item.adminOnly,
);

const BY_CODE = new Map(PERMISSION_CATALOG.map((item) => [item.code, item]));

export function permissionDefinition(code: string): PermissionDefinition | undefined {
  return BY_CODE.get(code as PermissionCode);
}

export function isAssignablePermission(code: string): boolean {
  const item = permissionDefinition(code);
  return Boolean(item && !item.adminOnly);
}
