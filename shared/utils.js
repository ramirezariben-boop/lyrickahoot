export function getSpeedBonus(ms) {
  if (ms < 3000) return 500;
  if (ms < 8000) return 350;
  if (ms < 30000) return 100;
  return 0;
}
