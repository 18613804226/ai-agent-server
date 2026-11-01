/**
 * lunar-javascript 无自带类型定义，这里补最小可用的模块声明。
 * 只声明本项目用到的 API（Solar / Lunar 的常用字段）。
 */
declare module 'lunar-javascript' {
  export class Solar {
    static fromYmd(y: number, m: number, d: number): Solar;
    static fromDate(date: Date): Solar;
    static fromYmdHms(
      y: number,
      m: number,
      d: number,
      hour: number,
      minute: number,
      second: number,
    ): Solar;
    getLunar(): Lunar;
    next(days: number): Solar;
    getYear(): number;
    getMonth(): number;
    getDay(): number;
    toYmd(): string;
    isBefore(solar: Solar): boolean;
  }

  export class Lunar {
    static fromDate(date: Date): Lunar;
    getFestivals(): string[];
    getJieQi(): string;
    getYear(): number;
    getMonth(): number;
    getDay(): number;
    getYearInChinese(): string;
    getMonthInChinese(): string;
    getDayInChinese(): string;
    getXingZuo(): string;
  }
}