# 机场订阅自动更新功能修复说明

## 问题诊断

经过代码分析，发现项目中已经实现了完整的自动更新功能，但由于**缺少关键的导出函数**，导致定时任务无法正常触发。

### 已存在的功能组件

1. ✅ **定时任务函数** (`handleCronTrigger`)
   - 位置：`functions/[[path]].js` 第358-430行
   - 功能：
     - 自动获取所有已启用订阅的最新流量信息
     - 自动更新节点数量
     - 检测流量使用率和到期时间
     - 触发 Telegram 通知（如已配置）

2. ✅ **Cron 配置**
   - 位置：`wrangler.toml` 第25-29行
   - 当前配置：`crons = ["0 */6 * * *"]`（每6小时执行一次）
   - 可自定义调整频率

### 问题原因

❌ **缺少 Cloudflare Pages Functions 的 `onScheduled` 导出函数**

Cloudflare Pages Functions 与 Workers 的 Cron Triggers 实现方式不同：
- **Workers**：通过检查 `request.headers.get("cf-cron")` 触发
- **Pages Functions**：需要显式导出 `onScheduled(context)` 函数

原代码只实现了 Workers 方式，导致 Pages 部署时定时任务不生效。

## 修复内容

### 新增导出函数

在 `functions/[[path]].js` 文件末尾添加了 `onScheduled` 函数：

```javascript
export async function onScheduled(context) {
    const { env, cron } = context;
    console.log(`[MiSub Cron] Triggered by schedule: ${cron}`);
    
    try {
        const response = await handleCronTrigger(env);
        console.log('[MiSub Cron] Execution completed successfully');
        return response;
    } catch (error) {
        console.error('[MiSub Cron] Execution failed:', error);
        return new Response(`Cron job failed: ${error.message}`, { status: 500 });
    }
}
```

## 自动更新功能说明

### 执行频率

- **默认**：每6小时执行一次（`0 */6 * * *`）
- **可调整**：编辑 `wrangler.toml` 中的 `crons` 配置

#### 常用 Cron 表达式示例

```toml
# 每30分钟
crons = ["*/30 * * * *"]

# 每小时
crons = ["0 * * * *"]

# 每2小时
crons = ["0 */2 * * *"]

# 每6小时（当前配置）
crons = ["0 */6 * * *"]

# 每12小时
crons = ["0 */12 * * *"]

# 每天凌晨3点
crons = ["0 3 * * *"]
```

### 更新内容

每次定时任务执行时会：

1. **遍历所有启用的订阅**（`enabled: true`）
2. **并行请求**获取：
   - 流量使用信息（upload、download、total）
   - 到期时间（expire）
   - 节点数量统计
3. **更新本地数据**：将最新信息保存到存储
4. **触发通知**（如已配置 Telegram Bot）：
   - 流量使用超过阈值（默认90%）
   - 距离到期不足阈值天数（默认3天）

### 通知配置

如需启用 Telegram 通知，需在 Cloudflare Pages 环境变量中配置：

- `BotToken`：Telegram Bot Token
- `ChatID`：接收通知的 Chat ID
- `NotifyThresholdDays`：到期提醒天数阈值（默认3天）
- `NotifyThresholdPercent`：流量使用率阈值（默认90%）

## 部署后验证

### 1. 检查日志

部署后可在 Cloudflare Pages 控制台查看日志，确认定时任务是否正常执行：

```
[MiSub Cron] Triggered by schedule: 0 */6 * * *
[MiSub Cron] Execution completed successfully
```

### 2. 手动测试

可以通过 Cloudflare Dashboard 手动触发 Cron Trigger 进行测试。

### 3. 数据验证

在 Dashboard 中查看订阅信息是否定期更新：
- 节点数量是否变化
- 流量信息是否更新
- 更新时间戳

## 注意事项

1. **首次部署后生效**：修改需要重新部署到 Cloudflare Pages 才能生效
2. **环境变量**：确保 `MISUB_KV`、`MISUB_DB` 等绑定已正确配置
3. **日志监控**：建议定期检查日志，确保定时任务正常执行
4. **错误处理**：单个订阅更新失败不会影响其他订阅的更新
5. **防重复通知**：同一个订阅的相同通知在24小时内只会发送一次

## 相关文件

- `functions/[[path]].js`：主要逻辑文件（包含 handleCronTrigger 和新增的 onScheduled）
- `wrangler.toml`：Cron Triggers 配置
- `src/composables/useSubscriptions.js`：前端订阅管理逻辑

## 参考文档

- [Cloudflare Pages Functions - Scheduled Functions](https://developers.cloudflare.com/pages/functions/scheduled-functions/)
- [Cron Trigger Syntax](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
