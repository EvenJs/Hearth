import { formatAud } from '@/lib/rules/money';

// R23.3：差额带符号显示。formatAud 正数不带 "+"，这里补上：500 → "+$5.00"，-500 → "-$5.00"
export function formatDiff(cents: number): string {
  return cents > 0 ? `+${formatAud(cents)}` : formatAud(cents);
}
