import type { Metadata, Viewport } from 'next';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hearth',
  description: '家庭记账',
  // iOS 添加到主屏幕后全屏打开（M7.8-1）。图标走 app/apple-icon.png 文件约定
  appleWebApp: { capable: true, title: 'Hearth', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // globals.css 浅色模式 --primary oklch(0.553 0.195 38.4) 换算，和 manifest.ts 的 theme_color 一致
  themeColor: '#ca3500',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="zh">
      <body className="min-h-dvh">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
