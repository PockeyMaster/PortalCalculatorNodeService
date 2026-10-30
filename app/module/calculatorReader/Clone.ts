import { deserialize, serialize } from 'node:v8';

/** Node 16 没有全局 structuredClone；仅复制来自 Mongo/JSON 的数据，不执行配置代码。 */
export function cloneValue<T>(value: T): T {
  return deserialize(serialize(value)) as T;
}
