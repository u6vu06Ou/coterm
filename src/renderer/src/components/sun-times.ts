// 台北。日出日落用 NOAA 簡式算，誤差一兩分鐘，夠畫一條弧。
const LAT = 25.03;
const LON = 121.56;

/** 回傳當地時間的日出、日落（從午夜起算的分鐘數）。 */
export function sunTimes(date: Date, lat = LAT, lon = LON): { rise: number; set: number } {
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start.getTime()) / 86_400_000);
  const g = (2 * Math.PI / 365) * (dayOfYear - 1);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const rad = Math.PI / 180;
  const cosHa = Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl);
  const ha = Math.acos(Math.min(1, Math.max(-1, cosHa))) / rad;
  const offset = -date.getTimezoneOffset();
  return {
    rise: Math.round(720 - 4 * (lon + ha) - eqTime + offset),
    set: Math.round(720 - 4 * (lon - ha) - eqTime + offset),
  };
}
