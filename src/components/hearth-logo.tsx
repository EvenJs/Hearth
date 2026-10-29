import type { ComponentProps } from 'react';

// 房子 + 火焰 + 柴火
// 房子和外焰跟随 currentColor（用 text-primary 控制）
// 内焰固定浅橙色；柴火跟随前景色，深色模式下会自动变浅
export function HearthLogo(props: ComponentProps<'svg'>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      {/* 房子：屋顶 + 墙和地面 */}
      <g stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.3 10.9 12 3.1l9.7 7.8" />
        <path d="M4.35 9.3v11.5h15.3V9.3" />
      </g>
      {/* 外焰：两个火舌，尖往右卷 */}
      <path
        fill="currentColor"
        d="M11.98 17.35C9.9 17.35 8.45 16.1 8.45 14.2c0-1.6 1.05-2.6 1.9-3.75.65-.9 1.05-1.8.95-2.9 1.6.65 2.6 2.35 2.45 4.55.35-.8.75-1.4 1.3-1.67-.15.95.55 1.85.55 3.15 0 2.2-1.5 3.77-3.62 3.77Z"
      />
      {/* 内焰 */}
      <path
        fill="#FB923C"
        d="M12 17.35c-1.2 0-2.05-.85-2-2 .05-.7.3-1.2.55-1.6.05.6.25 1 .55 1.2-.1-1.4.3-2.4 1.15-2.9-.15 1.1 1.7 2 1.7 3.5 0 1.05-.85 2.05-1.95 2.05Z"
      />
      {/* 柴火 */}
      <rect x="7.3" y="17.75" width="9.4" height="2.3" rx="1" className="fill-foreground" />
    </svg>
  );
}
