import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXPORT_PREFIX = 'export ';

/**
 * 去掉未加引号的尾随注释。
 *
 * 只有位于引号之外的 `#` 才算注释起始，且必须处于行首或紧跟空白。
 * 这样 `user:pa#ss` 这类含 `#` 的值不会被误截断——dotenv 会把它截成 `user:pa`，
 * 在代理凭据、Cookie 等场景下属于静默出错。
 */
function stripTrailingComment(raw: string): string {
  let quote: string | null = null;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (quote !== null) {
      if (char === quote) { quote = null; }
    } else if (char === '"' || char === '\'') {
      quote = char;
    } else if (char === '#' && (index === 0 || /\s/.test(raw[index - 1] ?? ''))) {
      return raw.slice(0, index).trim();
    }
  }
  return raw;
}

/** 去注释后去掉成对引号，使值里可以包含空格、`#` 等字符。 */
function normalizeValue(raw: string): string {
  const value = stripTrailingComment(raw).trim();
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === '\'') && value[value.length - 1] === first) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 本地调试用的最小 .env 加载器。
 *
 * 只用于开发环境，读取项目根目录的 .env 并填充 process.env。
 * 规则：
 * - 不覆盖已经存在的环境变量，进程内显式设置的值优先。
 * - 支持 `KEY=value`、`export KEY=value`、`#` 注释行与行尾注释，值可用成对引号包裹。
 * - 不做变量插值、不支持跨行值，避免引入隐式行为。
 * - 文件缺失或读取失败不报错，本地调试可以只依赖真实环境变量。
 */
export function loadDotEnv(fileName = '.env'): void {
  // 相对路径按调用方模块解析，使 cwd 与项目根不一致时（例如从上层目录启动）仍能找到 .env。
  const filePath = resolve(__dirname, '..', fileName);
  if (!existsSync(filePath)) { return; }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) { continue; }

    // 兼容 shell 风格的 `export KEY=value`（.env 常从脚本片段复制而来）。
    const assignment = line.startsWith(EXPORT_PREFIX)
      ? line.slice(EXPORT_PREFIX.length).trim()
      : line;

    const separator = assignment.indexOf('=');
    if (separator <= 0) { continue; }

    const key = assignment.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) { continue; }

    if (process.env[key] === undefined) {
      process.env[key] = normalizeValue(assignment.slice(separator + 1));
    }
  }
}
