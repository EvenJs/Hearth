import type { MetadataRoute } from 'next';

// 装到手机主屏（M7.8-1）。只管能安装，不写 service worker，打开时照常联网
// 颜色从 globals.css 浅色模式换算成 hex（manifest 不认 oklch）：
// - background_color：--background oklch(0.985 0.008 60) → #fef9f5
// - theme_color：--primary oklch(0.553 0.195 38.4) → #ca3500
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Hearth',
    short_name: 'Hearth',
    description: '家庭记账',
    start_url: '/',
    display: 'standalone',
    background_color: '#fef9f5',
    theme_color: '#ca3500',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
