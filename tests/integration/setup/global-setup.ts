// 整组开跑前检查一次：连接串指向 dev 时打印原因并直接退出（exit 1），一个测试都不跑
// 自己打印再 exit：vitest 打印 globalSetup 抛出的错误时会崩，看不到原因
import { prepareTestDbEnv } from './test-db-env';

export default function setup() {
  let enabled: boolean;
  try {
    ({ enabled } = prepareTestDbEnv());
  } catch (error) {
    console.error(`\n[test:db] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  if (!enabled) {
    console.warn('[test:db] 没设 TEST_DATABASE_URL，tests/integration 整组跳过');
  }
}
