/** Indian digit grouping (12,34,567.89) without relying on Intl support. */
export function groupIndian(intPart: string): string {
  if (intPart.length <= 3) return intPart;
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

export function formatNumber(n: number, decimals = 2): string {
  const sign = n < 0 ? '-' : '';
  const [i, f] = Math.abs(n).toFixed(decimals).split('.');
  return sign + groupIndian(i) + (f ? `.${f}` : '');
}

export const formatINR = (n: number, decimals = 2) => (n < 0 ? '-₹' : '₹') + formatNumber(Math.abs(n), decimals);

export const formatSigned = (n: number, decimals = 2) => (n > 0 ? '+' : '') + formatNumber(n, decimals);

export const formatPct = (n: number) => `${formatSigned(n)}%`;
