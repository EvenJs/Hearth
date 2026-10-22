import type { ComponentProps } from 'react';

// 房子 + 火苗。颜色跟随 currentColor
export function HearthLogo(props: ComponentProps<'svg'>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M3.5 10 12 3l8.5 7v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1Z" />
      <path d="M12 11.5c-1.2 1.4-1.8 2.5-1.8 3.4a1.8 1.8 0 0 0 3.6 0c0-.9-.6-2-1.8-3.4Z" />
    </svg>
  );
}
