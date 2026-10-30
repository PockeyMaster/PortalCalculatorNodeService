import type { EggAppInfo } from 'egg';
import { loadDotEnv } from './envLoader';
import { listenPort, readerConfiguration } from './reader';

export default (appInfo: EggAppInfo) => {
  if (appInfo.env === 'local' || appInfo.env === 'unittest') { loadDotEnv(); }
  return {
    keys: process.env.APP_KEYS || `${appInfo.name}_local_development_key`,
    cluster: { listen: { port: listenPort(), hostname: '0.0.0.0' } },
    calculatorReader: readerConfiguration(),
  };
};
