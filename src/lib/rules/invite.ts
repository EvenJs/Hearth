// 邀请码（docs/rules/R26-invite.md R26.1 到 R26.3）
// 随机数来源和"现在"由调用方传进来
// 纯函数，不 import 数据库和 Next.js

export type InvitePurpose = 'join' | 'new_household';
export type InviteStatus = 'unused' | 'used' | 'expired' | 'revoked';

export type InviteState = {
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
};

// R26.1 去掉 0 O 1 I L，顺序固定
export const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 8;
const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

const CODE_PATTERN = new RegExp(`^[${INVITE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`);

// R26.1 random(max) 返回 [0, max) 的整数，生产传 crypto.randomInt
export function generateInviteCode(random: (max: number) => number): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    const index = random(INVITE_ALPHABET.length);
    if (!Number.isInteger(index) || index < 0 || index >= INVITE_ALPHABET.length) {
      throw new Error(`随机数超出范围: ${index}`);
    }
    code += INVITE_ALPHABET[index];
  }
  return code;
}

// R26.1 显示成 XXXX-XXXX
export function formatInviteCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// R26.1 去空白和横杠、转大写；不是 8 位或有字符集以外的字符返回 null
export function normalizeInviteCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

// R26.1 按绝对时间加 72 小时
export function inviteExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + INVITE_TTL_MS);
}

// R26.3 按顺序：撤销 → 已用 → 过期（刚好到 expires_at 就算）→ 没用
export function inviteStatus(invite: InviteState, now: Date): InviteStatus {
  if (invite.revokedAt) return 'revoked';
  if (invite.usedAt) return 'used';
  if (now.getTime() >= invite.expiresAt.getTime()) return 'expired';
  return 'unused';
}

// R26.2 逗号分开，去首尾空格、转小写，丢掉空的项
export function parseAdminEmails(env: string | undefined): string[] {
  return (env ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
}

// R26.2 join 谁都能发；new_household 只有站长（转小写后完全相等）
export function canIssue(purpose: InvitePurpose, email: string, adminEmails: string[]): boolean {
  if (purpose === 'join') return true;
  return adminEmails.includes(email.trim().toLowerCase());
}
