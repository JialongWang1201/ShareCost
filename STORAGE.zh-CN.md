# 数据库存储占用

Supabase 的 Database size 包括 PostgreSQL 系统表、认证服务的数据和索引、应用表和索引。它与 Storage 文件容量、Egress 流量是不同指标。看到约 25 MB 不能据此推断几笔账单就消耗了 25 MB；应先读取各表的实际大小。

## 查看真实占用

在 [Supabase SQL Editor](https://supabase.com/dashboard/project/tzmgnrgeotahugglvces/sql/new) 执行 [`supabase/maintenance/storage-report.sql`](supabase/maintenance/storage-report.sql)。这是只读查询，不清理任何数据，不返回姓名、备注或金额。

它返回：

- `current_database_size`：当前数据库总大小，和面板口径或统计更新时间可能有差异。
- `sharecost_tables_size`：ShareCost 六张表及其索引的实际分配空间。
- `counts`：账单、分摊和结算的数量。
- `schemas`、`largest_tables`：各 schema 和最大表的占用，区分账本数据、认证数据与系统开销。
- `profile_write_optimization_installed`：下面的优化是否已安装。

## 已有数据库：减少无效写入

执行 [`supabase/migrations/202610280002_avoid_profile_rewrites.sql`](supabase/migrations/202610280002_avoid_profile_rewrites.sql)。它只修改资料同步逻辑：昵称相同时不再写入，昵称真正改变时才更新。

同一次 Run 结束后会返回简要统计：数据库总大小、账本表及索引大小、认证表大小、账单数量。需要更详细的逐表分布时，再运行上面的只读报告即可。

此前普通读取也会 UPSERT 同一份资料，PostgreSQL 会产生旧行版本。修复后，普通同步不再产生这些无效更新。脚本不删除账单、不删认证记录、不删除索引，不更改访问权限，也不修改金额或分摊方式。重复执行安全；若线上函数不符合预期版本，会停止而不是覆盖未知代码。

原始安装脚本保持不变。新项目依次运行 `202610280001_sharecost.sql` 和 `202610280002_avoid_profile_rewrites.sql`。如果重新运行原始安装脚本，也需要再运行优化脚本。

这项修复用于减少今后的无效写入，不保证面板立刻从 25 MB 降低。PostgreSQL 通常会通过 autovacuum 回收旧版本供后续记录复用；标准 VACUUM 一般不会把已分配空间全部返还给操作系统。这里没有运行 VACUUM FULL 或修改 Supabase 管理的系统表。

## 在本地估算账单的增量

```sh
npm ci
npm run measure:storage
# 或指定样本数量，最多 100000：
npm run measure:storage -- 20000
```

脚本只在本机内存中创建 PostgreSQL，生成三人分摊的示例账单，测量表和索引的增量。不会连接或写入真实 Supabase。它包含账单、三份分摊和索引，但不代表你们项目的真实增长速度：实际备注长度、成员人数、认证数据、更新频率和 PostgreSQL 版本都可能影响结果。

2026-10-28 的本地样本：10,000 笔账单、30,000 条分摊，表和索引增量为 6,438,912 字节（约 6.4 MB / 6.14 MiB），平均每笔约 644 字节。样本使用三人分摊和固定长度的中英文备注，不包含 Supabase 的系统及认证开销。这是示例测量，不是线上容量保证。

目前没有测得你们线上六张表的大小，不能承诺压缩比例或剩余可记账笔数。请以只读统计结果和后续增长趋势为准。

参考：[Supabase 数据库容量说明](https://supabase.com/docs/guides/platform/database-size)、[PostgreSQL VACUUM 与旧行版本](https://www.postgresql.org/docs/current/routine-vacuuming.html)。
