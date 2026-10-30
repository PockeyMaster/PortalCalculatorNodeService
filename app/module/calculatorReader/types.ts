export type ReaderSite = 'zh-CN' | 'zh-HK';
export type ReaderChannel = 'gray' | 'prod';
export type ReaderLanguage = 'zh-cn' | 'en-us' | 'es-us';
export type ReaderTab = 'calc' | 'detail' | 'listCalc';
export type ReaderDocumentType = 'config' | 'productInfo' | 'menuInfo' | 'language';
export type ReaderObject = Record<string, unknown>;

export interface CalculatorReaderConfig {
  site: ReaderSite;
  channel: ReaderChannel;
  redisTimeoutMs: number;
  mongoTimeoutMs: number;
  refresh?: { enabled: boolean; intervalMs: number };
}
export interface CalculatorLookup {
  type: ReaderDocumentType;
  site: ReaderSite;
  channel: ReaderChannel;
  stableKey: string;
  service?: string;
  tag?: string;
  region?: string;
  tab?: ReaderTab;
}
export interface RedisReader {
  get(key: string): Promise<string | null>;
}
export interface CurrentReader {
  /** 返回与 Redis 相同的序列化内容；null 仅表示没有当前数据，不表示数据库故障。 */
  read(lookup: CalculatorLookup): Promise<string | null>;
}
export interface ReaderLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
export interface ReaderContent {
  product: Record<string, ReaderObject[]>;
  period: Record<string, ReaderObject[][]>;
}
export interface ReaderProductDocument extends ReaderContent {
  urlPath: string;
  tag: string;
  region: string;
  tab: ReaderTab;
}
export class CalculatorInputError extends Error {}
export class CalculatorNotFoundError extends Error {}
export class CalculatorDataUnavailableError extends Error {}
