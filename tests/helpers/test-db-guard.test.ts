import { describe, expect, it } from 'vitest';
import { assertSafeTestDatabaseUrl, databaseHostKey } from './test-db-guard';

// 假连接串，主机名照 Neon 的格式编的
const DEV_POOLED =
  'postgresql://u:secret@ep-dev-123-pooler.ap-southeast-2.aws.neon.tech/neondb?sslmode=require';
const DEV_DIRECT =
  'postgresql://u:secret@ep-dev-123.ap-southeast-2.aws.neon.tech/neondb?sslmode=require';
const TEST_POOLED =
  'postgresql://u:secret@ep-test-456-pooler.ap-southeast-2.aws.neon.tech/neondb?sslmode=require';

describe('M3-2 test database guard', () => {
  it('strips -pooler so pooled and direct hosts of one endpoint match', () => {
    expect(databaseHostKey(DEV_POOLED, 'x')).toBe(databaseHostKey(DEV_DIRECT, 'x'));
  });

  it('rejects the same URL as DATABASE_URL', () => {
    expect(() => assertSafeTestDatabaseUrl(DEV_POOLED, DEV_POOLED)).toThrow(/同一个库/);
  });

  it('rejects the same host even with a different database name or user', () => {
    const other = DEV_POOLED.replace('/neondb', '/otherdb').replace('u:secret', 'v:pw');
    expect(() => assertSafeTestDatabaseUrl(other, DEV_POOLED)).toThrow(/同一个库/);
  });

  it('rejects pooled vs direct host of the same endpoint', () => {
    expect(() => assertSafeTestDatabaseUrl(DEV_DIRECT, DEV_POOLED)).toThrow(/同一个库/);
  });

  it('accepts a different Neon branch endpoint', () => {
    expect(() => assertSafeTestDatabaseUrl(TEST_POOLED, DEV_POOLED)).not.toThrow();
  });

  it('refuses when DATABASE_URL is missing', () => {
    expect(() => assertSafeTestDatabaseUrl(TEST_POOLED, undefined)).toThrow(/DATABASE_URL 没设/);
  });

  it('refuses a malformed URL without echoing it', () => {
    expect(() => assertSafeTestDatabaseUrl('not a url secret', DEV_POOLED)).toThrow(
      /^(?!.*secret).*TEST_DATABASE_URL 不是合法的连接串/,
    );
  });

  it('never puts the password in the error message', () => {
    expect(() => assertSafeTestDatabaseUrl(DEV_POOLED, DEV_POOLED)).toThrow(/^(?!.*secret)/);
  });
});
