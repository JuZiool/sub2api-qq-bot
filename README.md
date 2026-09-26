# sub2api-qq-bot

QQ 群机器人：通过 NapCat（OneBot v11）接收 QQ 消息，查询 sub2api 管理数据并回复到群里。

独立项目，不修改 sub2api / orange 后端代码。

## 架构

```
QQ 群消息 → NapCat 容器（OneBot v11 WS）→ bot 容器 → sub2api Admin API → 回复群消息
```

## 部署步骤

### 1. 准备配置

```bash
cp .env.example .env
# 编辑 .env：填写管理员邮箱、密码、允许查询的 QQ 号
```

建议把数据目录放在项目目录之外，避免重新拉取或替换项目代码时丢失 QQ 登录态：

```env
NAPCAT_DATA_DIR=/opt/sub2api-qq-bot-data/napcat
NAPCAT_CONFIG_DIR=/opt/sub2api-qq-bot-data/napcat/config
QQ_DATA_DIR=/opt/sub2api-qq-bot-data/qq
BOT_DATA_DIR=/opt/sub2api-qq-bot-data/bot
```

首次部署前创建目录：

```bash
mkdir -p /opt/sub2api-qq-bot-data/{napcat,qq,bot}
```

这四个挂载路径分别保存 NapCat 运行数据、NapCat 配置、QQNT 登录态和机器人绑定数据。重新部署时不要删除它们。

同时在 `.env` 中设置 `NAPCAT_QQ`（机器人 QQ 号，供 compose 传递给 NapCat）：

```yaml
# docker-compose.yml 中已引用 ${NAPCAT_QQ}，可在 .env 里添加：
NAPCAT_QQ=你的机器人QQ号
```

### 2. 启动

```bash
docker compose up -d --build
```

### 3. 登录 QQ

打开 NapCat WebUI：http://localhost:6099 （首次进入需要在容器日志里找 token），扫码或密码登录机器人 QQ 号。

### 4. 配置 OneBot WebSocket 服务端

登录后在 NapCat WebUI → 网络配置 中添加一个 **WebSocket 服务器**，监听 `0.0.0.0:3001`（与 `.env` 中 `ONEBOT_WS_URL` 一致）。bot 会自动连上并开始响应指令。

## 指令

| 指令 | 权限 | 说明 |
| --- | --- | --- |
| `/帮助` | 所有人 | 查看指令列表 |
| `/状态` | 管理员 | 系统运行概况（用户/账号/今日用量/累计） |

管理员由 `.env` 中 `ADMIN_QQ_LIST`（逗号分隔 QQ 号）控制。

## 数据来源

- `POST /api/v1/auth/login` 登录取 `access_token`（自动缓存、过期重登）
- `GET /api/v1/admin/dashboard/stats` 仪表盘统计

## 本地开发（非 Docker）

```bash
npm install
npm start
```

本地运行时 `.env` 中 `ONEBOT_WS_URL` 指向 `ws://127.0.0.1:3001`，`SUB2API_BASE_URL` 指向 `http://127.0.0.1:8080`。
