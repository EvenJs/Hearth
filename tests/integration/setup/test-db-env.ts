// M3-2：集成测试的环境变量。globalSetup（主进程）和 setupFiles（每个测试文件之前）都调用
// 有 TEST_DATABASE_URL：先做安全检查，再把 DATABASE_URL 换成它，src/db 和 src/server 不用改就连到 test 库
// 没有：把 DATABASE_URL 换成 .invalid 假地址，测试整组跳过，就算误 import @/db 也连不到 dev
import { existsSync } from 'node:fs';
import { assertSafeTestDatabaseUrl } from '../../helpers/test-db-guard';

const SKIP_URL = 'postgresql://skip:skip@integration-skipped.invalid/skip';

export function prepareTestDbEnv(): { enabled: boolean } {
  // 不覆盖已有的环境变量（和 node --env-file 一样）
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');

  const env = process.env;
  // 第一次调用时记下原始的 dev 串。之后 DATABASE_URL 已经被换掉，比较时用这个
  if (env.HEARTH_DEV_DATABASE_URL === undefined) {
    env.HEARTH_DEV_DATABASE_URL = env.DATABASE_URL ?? '';
  }

  const testUrl = env.TEST_DATABASE_URL;
  if (!testUrl) {
    env.DATABASE_URL = SKIP_URL;
    return { enabled: false };
  }

  assertSafeTestDatabaseUrl(testUrl, env.HEARTH_DEV_DATABASE_URL || undefined);
  env.DATABASE_URL = testUrl;
  return { enabled: true };
}
