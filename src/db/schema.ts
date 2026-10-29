// Drizzle 表定义
// user、session、account、verification 由 Better Auth CLI 生成（npx auth@1.7.12 generate）
// 唯一手改：所有 timestamp 加了 { withTimezone: true }（tech-stack 第 2 节用 timestamptz）
// 以后重跑 CLI 会覆盖掉，记得加回来
import { relations, sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  unique,
  check,
  uuid,
  integer,
  smallint,
  varchar,
  char,
  date,
  jsonb,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_userId_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('account_userId_idx').on(table.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

// ============================================================
// 业务表（schema.md 第 1、3 节）
// ============================================================

// ---------- 1. 枚举 ----------

export const memberKind = pgEnum('member_kind', ['person', 'shared', 'child']);
export const bank = pgEnum('bank', ['anz', 'anz_plus', 'cba', 'cash', 'other']);
export const accountType = pgEnum('account_type', [
  'everyday',
  'savings',
  'credit_card',
  'joint',
  'cash',
]);
export const categoryKind = pgEnum('category_kind', ['expense', 'income', 'system']);
export const systemCategoryKey = pgEnum('system_category_key', [
  'internal_transfer',
  'cash_withdrawal',
  'bank_fee',
  'uncategorized',
]);
export const transactionStatus = pgEnum('transaction_status', ['pending', 'confirmed']);
export const transactionSource = pgEnum('transaction_source', ['csv', 'manual', 'receipt']);
export const transferStatus = pgEnum('transfer_status', ['none', 'auto', 'suggested', 'confirmed']);
export const ruleMatchType = pgEnum('rule_match_type', ['contains', 'starts_with']);

// ---------- 通用列 ----------

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();
const householdId = () =>
  uuid('household_id')
    .notNull()
    .references(() => household.id);

// ---------- 3. 业务表 ----------

export const household = pgTable('household', {
  id: id(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const householdUser = pgTable('household_user', {
  id: id(),
  householdId: householdId(),
  userId: text('user_id')
    .notNull()
    .unique()
    .references(() => user.id),
  memberId: uuid('member_id').references(() => member.id),
  createdAt: createdAt(),
});

export const member = pgTable(
  'member',
  {
    id: id(),
    householdId: householdId(),
    name: text('name').notNull(),
    kind: memberKind('kind').notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    isArchived: boolean('is_archived').default(false).notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('member_household_id_name_unique').on(t.householdId, t.name)],
);

export const financialAccount = pgTable(
  'financial_account',
  {
    id: id(),
    householdId: householdId(),
    name: text('name').notNull(),
    bank: bank('bank').notNull(),
    type: accountType('type').notNull(),
    defaultMemberId: uuid('default_member_id')
      .notNull()
      .references(() => member.id),
    // 账号尾号 4-6 位，不存完整账号和 BSB
    numberSuffix: varchar('number_suffix', { length: 6 }),
    isArchived: boolean('is_archived').default(false).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('financial_account_household_id_name_unique').on(t.householdId, t.name),
    check('financial_account_number_suffix_check', sql`${t.numberSuffix} ~ '^[0-9]{4,6}$'`),
  ],
);

export const card = pgTable(
  'card',
  {
    id: id(),
    householdId: householdId(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => financialAccount.id),
    last4: char('last4', { length: 4 }).notNull(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id),
    label: text('label'),
  },
  (t) => [unique('card_account_id_last4_unique').on(t.accountId, t.last4)],
);

export const category = pgTable(
  'category',
  {
    id: id(),
    householdId: householdId(),
    parentId: uuid('parent_id').references((): AnyPgColumn => category.id),
    nameZh: text('name_zh'),
    nameEn: text('name_en').notNull(),
    kind: categoryKind('kind').notNull(),
    systemKey: systemCategoryKey('system_key'),
    defaultMemberId: uuid('default_member_id').references(() => member.id),
    isPreTaxDefault: boolean('is_pre_tax_default').default(false).notNull(),
    isOther: boolean('is_other').default(false).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    isArchived: boolean('is_archived').default(false).notNull(),
  },
  (t) => [
    // NULLS NOT DISTINCT：一级分类 parent_id 为空，不加的话同名一级分类拦不住
    unique('category_household_id_parent_id_name_en_unique')
      .on(t.householdId, t.parentId, t.nameEn)
      .nullsNotDistinct(),
    uniqueIndex('category_household_id_system_key_unique')
      .on(t.householdId, t.systemKey)
      .where(sql`${t.systemKey} is not null`),
  ],
);

export const categoryRule = pgTable(
  'category_rule',
  {
    id: id(),
    householdId: householdId(),
    keyword: text('keyword').notNull(), // 存大写
    matchType: ruleMatchType('match_type').default('contains').notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id),
    priority: integer('priority').default(0).notNull(),
    isSystem: boolean('is_system').default(false).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('category_rule_household_id_keyword_match_type_unique').on(
      t.householdId,
      t.keyword,
      t.matchType,
    ),
  ],
);

// 不保存上传的原始文件
export const importBatch = pgTable(
  'import_batch',
  {
    id: id(),
    householdId: householdId(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => financialAccount.id),
    fileName: text('file_name').notNull(),
    // csv / pdf（ANZ 对账单，R1C）。R12.2 找上一份对账单用
    source: text('source').notNull().default('csv'),
    dateFrom: date('date_from', { mode: 'string' }).notNull(),
    dateTo: date('date_to', { mode: 'string' }).notNull(),
    rowCount: integer('row_count').notNull(),
    insertedCount: integer('inserted_count').notNull(),
    duplicateCount: integer('duplicate_count').notNull(),
    matchedPendingCount: integer('matched_pending_count').notNull(),
    openingBalanceCents: integer('opening_balance_cents'),
    closingBalanceCents: integer('closing_balance_cents'),
    reconciled: boolean('reconciled'),
    warnings: jsonb('warnings'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [check('import_batch_source_check', sql`${t.source} in ('csv', 'pdf')`)],
);

export const transaction = pgTable(
  'transaction',
  {
    id: id(),
    householdId: householdId(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => financialAccount.id),
    // YYYY-MM-DD 字符串，不转 JS Date
    date: date('date', { mode: 'string' }).notNull(),
    amountCents: integer('amount_cents').notNull(),
    rawDescription: text('raw_description').notNull(), // 脱敏后（R2.3）
    merchant: text('merchant').notNull(),
    cardLast4: char('card_last4', { length: 4 }),
    balanceCents: integer('balance_cents'),
    status: transactionStatus('status').notNull(),
    source: transactionSource('source').notNull(),
    transferStatus: transferStatus('transfer_status').default('none').notNull(),
    transferPairId: uuid('transfer_pair_id').references((): AnyPgColumn => transaction.id),
    dedupeKey: text('dedupe_key'),
    importBatchId: uuid('import_batch_id').references(() => importBatch.id),
    note: text('note'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('transaction_account_id_dedupe_key_unique')
      .on(t.accountId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    index('transaction_household_id_date_idx').on(t.householdId, t.date),
    index('transaction_account_id_date_idx').on(t.accountId, t.date),
    index('transaction_household_id_status_idx').on(t.householdId, t.status),
    index('transaction_household_id_merchant_idx').on(t.householdId, t.merchant),
    check('transaction_amount_cents_nonzero', sql`${t.amountCents} <> 0`),
  ],
);

// 分类和归属人在这里，不在 transaction 上
export const transactionSplit = pgTable(
  'transaction_split',
  {
    id: id(),
    householdId: householdId(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transaction.id, { onDelete: 'cascade' }),
    amountCents: integer('amount_cents').notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id),
    categorySource: text('category_source').notNull(), // rule | manual | system
    isPrimary: boolean('is_primary').default(false).notNull(),
    memberSource: text('member_source').notNull(), // manual | category | card | account（R5.1）
    isPreTax: boolean('is_pre_tax').default(false).notNull(),
    note: text('note'),
  },
  (t) => [
    index('transaction_split_household_id_category_id_idx').on(t.householdId, t.categoryId),
    index('transaction_split_household_id_member_id_idx').on(t.householdId, t.memberId),
    index('transaction_split_transaction_id_idx').on(t.transactionId),
    uniqueIndex('transaction_split_transaction_id_primary_unique')
      .on(t.transactionId)
      .where(sql`${t.isPrimary}`),
    check('transaction_split_amount_cents_nonzero', sql`${t.amountCents} <> 0`),
  ],
);

// 小票识别结果（R20）。不存图片
export const receipt = pgTable(
  'receipt',
  {
    id: id(),
    householdId: householdId(),
    // 为空 = 没挂上（撤销导入、删了交易以后，R20.7）
    transactionId: uuid('transaction_id').references(() => transaction.id, {
      onDelete: 'set null',
    }),
    merchant: text('merchant').notNull(), // R20.2 整理后（脱敏，最长 100）
    receiptDate: date('receipt_date', { mode: 'string' }).notNull(),
    totalCents: integer('total_cents').notNull(),
    // { items, discounts, payment }，用户核对后的版本。不含卡号、人名
    parsedJson: jsonb('parsed_json').notNull(),
    reader: text('reader').notNull(), // llm:<模型名> | text | manual（R20.1）
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('receipt_transaction_id_unique')
      .on(t.transactionId)
      .where(sql`${t.transactionId} is not null`),
    index('receipt_household_id_receipt_date_idx').on(t.householdId, t.receiptDate),
    check('receipt_total_cents_positive', sql`${t.totalCents} > 0`),
  ],
);

export const budget = pgTable(
  'budget',
  {
    id: id(),
    householdId: householdId(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id),
    monthlyLimitCents: integer('monthly_limit_cents').notNull(),
    warnAtPercent: integer('warn_at_percent').default(80).notNull(),
    isPinned: boolean('is_pinned').default(false).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('budget_household_id_category_id_unique').on(t.householdId, t.categoryId),
    check('budget_monthly_limit_cents_positive', sql`${t.monthlyLimitCents} > 0`),
  ],
);

// 税率表不进数据库，见 src/lib/tax/rates.ts
export const taxProfile = pgTable(
  'tax_profile',
  {
    id: id(),
    householdId: householdId(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id), // 只能是 kind = person（应用层保证）
    financialYear: smallint('financial_year').notNull(), // 2026 = 2026-27 财年
    paygGrossCents: integer('payg_gross_cents').default(0).notNull(),
    paygWithheldCents: integer('payg_withheld_cents').default(0).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('tax_profile_member_id_financial_year_unique').on(t.memberId, t.financialYear)],
);
