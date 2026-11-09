// 发邮件（tech-stack 4，R26.7、R26.8）：nodemailer 走 Gmail SMTP。换服务只改 sendEmail
// SMTP_USER、SMTP_PASS 没配时不报错，返回失败，其他功能照常
// 正文里有验证、重置链接：收件人、正文都不打日志
// scripts/ 用 node 直接跑 src/lib/auth.ts 会带上这个文件，所以只能 import 包，不能用 @/ 别名
import nodemailer from 'nodemailer';

export type SendEmailResult = { ok: true } | { ok: false };

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;
  transporter ??= nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
    // 默认等 2 分钟，Vercel 函数先超时了。超时当发不出去（R26.5）
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
): Promise<SendEmailResult> {
  const t = getTransporter();
  if (!t) {
    console.error('发邮件失败：没配 SMTP_USER、SMTP_PASS');
    return { ok: false };
  }
  try {
    await t.sendMail({ from: `Hearth <${process.env.SMTP_USER}>`, to, subject, html });
    return { ok: true };
  } catch (error) {
    // 只记错误类型（EAUTH 密码错、ETIMEDOUT 超时、5xx 超额），不记收件人和正文
    const { code, responseCode } = (error ?? {}) as { code?: string; responseCode?: number };
    console.error('发邮件失败', { code, responseCode });
    return { ok: false };
  }
}

// ---------- 邮件正文：中文、纯文字加一个链接，不放图片 ----------

export type EmailContent = { subject: string; html: string };

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// intro、outro 是写死的文字，name、url 要转义
function render(name: string, intro: string, url: string, outro: string): string {
  const link = escapeHtml(url);
  return [
    `<p>${escapeHtml(name)}，你好：</p>`,
    `<p>${intro}</p>`,
    `<p><a href="${link}">${link}</a></p>`,
    `<p>${outro}</p>`,
  ].join('\n');
}

// R26.7 验证链接 24 小时过期
export function verificationEmail(name: string, url: string): EmailContent {
  return {
    subject: 'Hearth：验证你的邮箱',
    html: render(
      name,
      '点下面的链接验证邮箱，验证完就能登录 Hearth。链接 24 小时内有效。',
      url,
      '如果不是你注册的，不用管这封邮件。',
    ),
  };
}

// R26.8 重置链接 1 小时过期，只能用一次
export function resetPasswordEmail(name: string, url: string): EmailContent {
  return {
    subject: 'Hearth：重设密码',
    html: render(
      name,
      '点下面的链接重设密码。链接 1 小时内有效，只能用一次。',
      url,
      '如果不是你申请的，不用管这封邮件，密码不会变。',
    ),
  };
}
