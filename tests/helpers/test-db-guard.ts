// M3-2 集成测试的安全检查：TEST_DATABASE_URL 绝不能指向 dev（DATABASE_URL）
// 纯函数，不读环境变量、不连库。报错信息只带主机名，不打印带密码的连接串

// Neon 同一个 endpoint 有两个主机名：ep-xxx.region.aws.neon.tech（直连）和 ep-xxx-pooler.region...（连接池）
// 比较前去掉 -pooler，否则 dev 的 pooled 串和 direct 串会被当成两个库
export function databaseHostKey(url: string, label: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`${label} 不是合法的连接串`);
  }
  if (!host) throw new Error(`${label} 里没有主机名`);
  return host.replace(/^([^.]+)-pooler\./, '$1.');
}

export function assertSafeTestDatabaseUrl(testUrl: string, devUrl: string | undefined): void {
  if (!devUrl) {
    // 没有 dev 的串就没法比，宁可不跑
    throw new Error('拒绝运行集成测试：DATABASE_URL 没设，没法确认 TEST_DATABASE_URL 不是 dev');
  }
  const testHost = databaseHostKey(testUrl, 'TEST_DATABASE_URL');
  const devHost = databaseHostKey(devUrl, 'DATABASE_URL');
  if (testHost === devHost) {
    throw new Error(
      `拒绝运行集成测试：TEST_DATABASE_URL 和 DATABASE_URL 是同一个库（${testHost}）。` +
        '测试会清空业务表，只能连 Neon 的 test branch',
    );
  }
}
