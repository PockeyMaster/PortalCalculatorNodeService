# Calculator 数据读取和后台缓存刷新

HTTP 接口从 Redis 读取固定 Key；未命中、超时或读取失败时回退 MongoDB 当前数据。
请求本身不写缓存，不下载静态资产、不同步源产品、不执行管理面聚合，也不创建索引或视图。

config/language/menuInfo 使用 `compiled_current_documents` 当前视图。
productInfo 通过 `aggregate_current_states` 的当前指针，读取该版本 `aggregated_skus`，恢复产品 JSON。
调用方只传业务参数，不传 buildId。站点和 channel 由部署配置确定。

## 后台任务

配置 Redis 后默认启用，在 Egg `didReady` 后每 60000 毫秒检查一次，首次检查在一个周期后执行。
`CALCULATOR_REFRESH_INTERVAL_MS` 可修改间隔；`CALCULATOR_REFRESH_ENABLED=false` 可关闭。修改后重启服务。
不配置 `REDIS_HOST` 时跳过后台任务，HTTP 仍可以回退 Mongo。
启动和健康检查不等待数据库/Redis；关闭时停止定时器，等待正在执行的刷新退出后再断开连接。

1. 获取同站点、同 channel 的 Redis 租约；其他实例持有时跳过。
2. 从 Mongo 主节点投影当前产品指针和配置/菜单/语言版本元数据，不下载所有配置正文或源产品。
3. 比较 Redis 保存的版本和 Key 存在性。版本未变化且当前 Key 都存在则跳过。
4. 有变化时直接读取 Mongo 指定的当前版本，重建 productInfo 或读取编译后的配置、菜单、语言正文，覆写对应 Redis Key。
5. 完成该服务或该文档的所有 Key 后，确认 Mongo 指针仍未改变，再记录刷新完成的版本。

productInfo 以服务为一组，config/menuInfo/language 各固定 Key 为一组。
产品 Key 的维度来自 SKU 中的 tag/region/tab 和构建的空镜像目标，必须与已完成构建的 Key 列表一致。
不按下划线拆 Key，避免服务名或 tag 含下划线时解析错误。

## 失败和并发

- 单进程不重入；一轮未完成时后续定时触发复用该轮，不并行扫描。
- 同站点/channel 的多 worker、多副本使用 Redis 30 秒租约，每 10 秒续租。
  写数据、写管理清单和完成版本标记时由 Lua 原子校验持锁令牌，租约失效的旧任务不能覆写新持锁者。
- 数据读取失败或指针变化时不记录该组完成版本，下个周期重试；单组失败不阻断其他组。
- 每个 Key 的写入是原子的，多 Key 刷新不是整组事务。中途失败可能已更新部分 Key，其余保留旧值，下次重试收敛。
  数据库新版本在一轮刷新期间再次改变，也需要下一轮继续同步。
- 本任务曾管理、但当前构建不再包含的产品 Key 会覆写成合法空结果，防止旧规格残留。
  每次成功写入同时保存目标维度，即使该轮后续失败也能追踪并清空这些 Key。
- 首次部署前遗留且没有进入本任务清单的 Redis Key，不扫描、不猜测、不自动删除。
  Mongo 元数据整组消失不视为删除指令；管理面应提交合法空构建来表达服务清空。
- 版本一致时只检查 Key 是否存在，不检测人工覆写但仍存在的缓存内容。HTTP 仍验证缓存格式并按原逻辑回退。

## Redis 内部元数据和权限

业务 Key 协议不变，prod 使用 v4 命名空间，gray 使用 gray；不增加业务缓存 TTL。
任务另外使用以下内部 Key（不依赖历史 manifest）：

```text
PortalCalculatorNodeService:{v4|gray}:internal:refresh:{zh-CN|zh-HK}:lock
PortalCalculatorNodeService:{v4|gray}:internal:refresh:{zh-CN|zh-HK}:versions
PortalCalculatorNodeService:{v4|gray}:internal:refresh:{zh-CN|zh-HK}:inventory:{groupId的SHA256}
```

versions 保存完成版本和当前 Key 列表；inventory 保存曾管理的 Key 及业务维度，跨重启保留。
Mongo 只需当前视图/集合的读取权限。Redis 需允许 GET/SET、EXISTS、HGET/HSET/HVALS、EVAL、PEXPIRE、DEL。
此实现使用独立 Redis 实例，多 Key Lua 不适用于 Redis Cluster 跨槽部署。
相同站点/channel 的所有副本必须使用同一组权威 Mongo 和 Redis。

日志前缀 `[cache-refresh]` 包含任务间隔、服务/文档组、更新数量、失败数量、租约状态和耗时。
不打印原始数据、连接凭据或驱动异常文本；出错时先结合 Mongo/Redis 的运维日志排查连接与权限。
单元测试模拟数据库和缓存；上线时仍需验证真实 Mongo 视图权限、Redis Lua 权限和管理面更新后的刷新结果。
