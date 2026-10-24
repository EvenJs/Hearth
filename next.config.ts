import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // Server Action 默认请求体上限 1 MB；CSV 上限 1 MB（M3-7），加上表单字段要留余量
    serverActions: { bodySizeLimit: '2mb' },
  },
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
