import Link from 'next/link';
import { HearthLogo } from '@/components/hearth-logo';

export function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <HearthLogo className="size-11 text-primary" />
      <span className="flex flex-col leading-tight">
        <span className="font-semibold">Hearth</span>
        <span className="text-xs text-muted-foreground">家庭账本</span>
      </span>
    </Link>
  );
}
