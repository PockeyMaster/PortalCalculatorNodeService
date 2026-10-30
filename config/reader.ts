import type { CalculatorReaderConfig } from '../app/module/calculatorReader/types';
import type { CalculatorReaderConnections } from '../app/module/calculatorReader/CalculatorReaderRuntime';

function positiveInteger(name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const text = process.env[name]?.trim() || String(fallback);
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive integer not greater than ${maximum}`);
  }
  return value;
}

function refreshEnabled(): boolean {
  const value = process.env.CALCULATOR_REFRESH_ENABLED?.trim().toLowerCase() || 'true';
  if (value !== 'true' && value !== 'false') { throw new TypeError('CALCULATOR_REFRESH_ENABLED must be true or false'); }
  return value === 'true';
}

export function readerConfiguration(): { settings: CalculatorReaderConfig; connections: CalculatorReaderConnections } {
  const site = process.env.CALCULATOR_READER_SITE?.trim() || 'zh-CN';
  const channel = process.env.CALCULATOR_READER_CHANNEL?.trim() || 'gray';
  if (site !== 'zh-CN' && site !== 'zh-HK') { throw new TypeError('CALCULATOR_READER_SITE must be zh-CN or zh-HK'); }
  if (channel !== 'gray' && channel !== 'prod') { throw new TypeError('CALCULATOR_READER_CHANNEL must be gray or prod'); }
  const mongoUri = process.env.MONGO_URI?.trim() || '';
  if (!/^mongodb(?:\+srv)?:\/\/[^/?#]+/.test(mongoUri) || /^mongodb(?:\+srv)?:\/\/[^/?#]*@/.test(mongoUri)) {
    throw new TypeError('MONGO_URI must be a MongoDB URI without credentials');
  }
  const username = process.env.MONGO_USERNAME || '';
  const password = process.env.MONGO_PASSWORD || '';
  if (Boolean(username) !== Boolean(password)) { throw new TypeError('MONGO_USERNAME and MONGO_PASSWORD must be configured together'); }
  const host = process.env.REDIS_HOST?.trim();
  const redisPassword = process.env.REDIS_PASSWORD;
  return {
    settings: { site, channel,
      redisTimeoutMs: positiveInteger('CALCULATOR_READER_REDIS_TIMEOUT_MS', 1000, 2147483647),
      mongoTimeoutMs: positiveInteger('CALCULATOR_READER_MONGO_TIMEOUT_MS', 5000, 2147483647),
      refresh: { enabled: refreshEnabled(), intervalMs: positiveInteger('CALCULATOR_REFRESH_INTERVAL_MS', 60000, 2147483647) } },
    connections: { mongoUri, mongoDb: process.env.MONGO_DB?.trim() || 'pep_calculator',
      ...(username ? { mongoOptions: { auth: { username, password } } } : {}),
      ...(host ? { redis: { host, port: positiveInteger('REDIS_PORT', 6379, 65535),
        ...(redisPassword ? { password: redisPassword } : {}) } } : {}) },
  };
}

export function listenPort(): number { return positiveInteger('PORT', 7001, 65535); }
