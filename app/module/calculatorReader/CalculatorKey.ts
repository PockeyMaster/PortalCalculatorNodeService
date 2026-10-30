import type { ReaderChannel, ReaderLanguage } from './types';

function namespace(channel: ReaderChannel): 'gray' | 'v4' {
  return channel === 'prod' ? 'v4' : 'gray';
}
function assertPart(name: string, value: string): void {
  if (!value || /[:\s]/.test(value)) { throw new TypeError(`Invalid Redis key ${name}: ${value}`); }
}

/** 独立读取模块沿用现网 Key 协议；不依赖管理面的发布模块。 */
export const CalculatorKey = {
  manifest(channel: ReaderChannel): string { return `PortalCalculatorNodeService:${namespace(channel)}:manifest`; },
  productInfo(input: { channel: ReaderChannel; service: string; tag: string; region: string; tab: string }): string {
    for (const [ name, value ] of Object.entries(input)) { assertPart(name, value); }
    return `PortalCalculatorNodeService:${namespace(input.channel)}:productInfo:${input.service}_${input.tag}_${input.region}_${input.tab}`;
  },
  config(input: { channel: ReaderChannel; service: string; language: ReaderLanguage }): string {
    assertPart('service', input.service);
    return `PortalCalculatorNodeService:${namespace(input.channel)}:config:${input.service}_${input.language}`;
  },
  menuInfo(input: { channel: ReaderChannel; sign: 'common' | 'cpq'; language: ReaderLanguage }): string {
    assertPart('sign', input.sign);
    return `PortalCalculatorNodeService:${namespace(input.channel)}:menuInfo:${input.sign}_${input.language}`;
  },
  language(input: { channel: ReaderChannel; language: ReaderLanguage }): string {
    return `PortalCalculatorNodeService:${namespace(input.channel)}:language:language_${input.language}`;
  },
};
