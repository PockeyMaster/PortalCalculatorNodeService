# Portal Calculator Node Service

Egg.js 3 + TypeScript，保留 Node.js 16.20.2 的模拟用户侧服务。

为避免 Egg 的间接依赖 utility 2.5 引入只支持 Node 18 的 ylru 2，已将 utility 2.x 固定到支持 Node 16 的 2.1.0。
本地安装锁文件不提交（含外部 registry 地址）；部署打包时使用本次安装生成的锁文件。

本项目恢复了管理仓库历史中的 calculatorReader 模块，并与管理面代码完全独立。
Redis 命中直接返回；Key 不存在、超时、连接错误、JSON 损坏或规格维度不匹配时回退 Mongo。
合法空产品是有效结果，不查历史版本。HTTP 读取不写 Redis/Mongo；后台任务负责刷新 Redis。
不建索引/视图，不请求 OBS 或产品上游。

## 启动

切换 Node 16.20.2，执行 `npm install`。将 `.env.example` 复制成 `.env`，至少填好 `MONGO_URI`。
库名 `MONGO_DB` 默认 `pep_calculator`，必须与管理面实际使用的库相同。
账号密码分开填写 `MONGO_USERNAME` / `MONGO_PASSWORD`，无认证时同时留空；密码为平台提供的实际明文。
URI 不嵌入账号密码，按实际实例保留 authSource、replicaSet 和 TLS 参数。

选择 `CALCULATOR_READER_SITE=zh-CN|zh-HK` 和 `CALCULATOR_READER_CHANNEL=gray|prod`，默认中国站 gray。
查询参数不能切换站点/通道。每个部署只配置自己的 Redis：`REDIS_HOST/PORT/PASSWORD`；HOST 留空则直接回退 Mongo。
不引入 XDCM/SCC、Kafka、tegg 或管理面依赖。

`npm run dev` 开发启动。默认端口 7001；如果与管理服务同时运行，请设置 `PORT=7003` 等未占用端口。
首页 `/` 和健康检查 `/health` 保留，健康检查不依赖数据库实际可连接。
本地 local/unittest 自动读取 `.env`，已有进程变量优先；生产环境只使用部署注入变量。

## 只读接口

支持根路径与 `/rest/cbc/portalcalculatornodeservice/v4/api` 前缀两种访问方式。
路径里的 v4 是协议版本；实际存储通道仅由部署环境变量决定，不接受请求跨站点/跨通道读取。

| GET 路径 | 参数 | 返回 |
| --- | --- | --- |
| `/config` | urlPath、language（默认 zh-cn） | 原始 JavaScript 文本，不执行、不再 JSON 包装 |
| `/productInfo` | urlPath、tag、region、tab=calc/detail/listCalc | JSON；不使用 sign 或 language |
| `/menuInfo` | sign=common/cpq、language（均有默认值） | JSON |
| `/language` | language（默认 zh-cn） | 全服务翻译 JSON；兼容传 urlPath=all |

urlPaht 兼容为 urlPath；同时提供且不同返回 400。language 支持 zh-cn/en-us/es-us。
非法输入 400，当前数据不存在 404，Mongo 不可用、坏行或摘要不一致 503。

## MongoDB 读取

- config/menuInfo/language：按固定 stableKey 读取 `calculator_{cn|intl}_compiled_current_documents` 只读视图，验证 SHA-256 和字节数。
- productInfo：读取 `calculator_{cn|intl}_aggregate_current_states` 的 service/channel 当前指针，
  验证对应 aggregate_builds 状态及 SKU 数，按内部 buildId 查询 aggregated_skus 并恢复 periodList/listCalc。
- 不再读取 redis_publish_records，不要求构建已经 published，不读取 aggregate_build_skus 的最新草稿。
- buildId 仅由仓储内部处理，接口调用者不感知。免费镜像、位置属性、additionProduct 和 tab 载荷沿用管理面的存储协议。
- 管理面必须先成功提交正常非 dryRun 更新及对应菜单/语言；历史 ready 快照不会自动成为当前视图内容。

读取账号只需相应集合/视图的读权限；视图和索引必须由管理面创建。首次回退连接 Mongo，不阻塞 Redis 命中路径。
日志前缀 `[calculator-read]` 包含 Key、站点、通道和回退原因，不打印密码或原始数据库错误。

## 后台刷新 Redis

配置 Redis 后默认每 60 秒检查 Mongo 当前版本，发现变化直接从 Mongo 重建并覆写缓存，
覆盖 productInfo、config、menuInfo、language。HTTP 接口仍保持 Redis 优先，不依赖请求流量触发刷新。

```dotenv
CALCULATOR_REFRESH_ENABLED=true
CALCULATOR_REFRESH_INTERVAL_MS=60000
```

首次检查在启动后一个周期执行，不阻塞启动和健康检查；修改配置后重启生效。
未配置 REDIS_HOST 或显式关闭时不启动任务。版本记录保留在 Redis，重启后跳过未变化且 Key 完整的数据。
任务使用同站点/channel 的互斥租约及 Lua 写入校验，避免多实例重复刷新和旧持锁者覆写。
读取失败不推进版本标记，下轮重试；多 Key 不是整组事务，中途失败可能已写入部分新 Key。
本任务管理过的已移除产品 Key 覆写为空结果；首次运行前未知的遗留 Key 不自动删除。
Redis 账号需有 EVAL 及元数据哈希读写权限；本实现面向独立 Redis，暂不支持 Cluster 跨槽 Lua。
详见 [后台检查、失败处理和内部 Key 协议](docs/calculator-reader.md)。

## 测试及部署

`npm run typecheck` 检查源代码与测试；`npm test` 执行类型检查、读取逻辑和后台刷新测试。
`npm run build` 将 app.ts、app/、config/ 编译到 dist，不编译测试。
将 dist 下的 app.js、app/、config/ 与 package.json、安装锁文件部署到独立目录，
安装生产依赖、注入 APP_KEYS 与连接变量后 `npm start`。不要把源码目录的 app/ 与 dist/app/ 混在同一个运行根目录。
测试使用虚构 Redis/Mongo，不会同步产品或写入真实数据库；需在实际环境额外验证 Redis 命中及当前视图/数据可读性。
