export const colors = {
  bg: '#0B0F14',
  card: '#141A22',
  cardAlt: '#1B2330',
  border: '#232C3A',
  text: '#E6EDF3',
  muted: '#8B98A9',
  up: '#22C55E',
  down: '#EF4444',
  accent: '#3B82F6',
  warn: '#F59E0B',
};

export const pnlColor = (n: number) => (n > 0 ? colors.up : n < 0 ? colors.down : colors.muted);
