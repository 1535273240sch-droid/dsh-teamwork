# Changelog

## 0.7.1 — 2026-10-17

- 折叠态从细长竖条改为**圆形悬浮按钮**（机器人头像 + 呼吸光 + 进度角标），一眼可见。
- 战役从无到有时**自动展开**面板；战役结束（`.teamwork` 消失）后自动收起为悬浮按钮。
- 战役进行中手动收起后不会被轮询强行展开。

## 0.7.0 — 2026-10-17

- 新增实时 2D 角色看板：`shell.overlay` 客户端面板，11 个机器人、发光连线、状态光晕、进度与事件 ticker。
- 新增只读投影接口 `GET /api/teamwork/live?cwd=<workspace>`：从 `.teamwork` 推导角色状态，无战役时返回 idle，不伪造工作。
- 面板默认展开、启动即显示；无战役时保留待命呼吸/眨眼/连线流动，有战役时 1.5s 内切换真实状态。
- 新增 `live.js`、`client.js`，`package.json` 增加 `dsh.client` 与 `./client` 导出。
- 新增 `docs/` 预览图与动态 WebP。

## 0.6.0 — 2026-10-17

- 首个 DeepSeek Harness 移植版：7 个 ZCode 钩子、32 动作 `teamwork` 工具、3 个斜杠命令、2 个技能、11 个角色、看板、看门狗。
- 上游 `vendor/teamwork` 43 个文件字节级保留。
- 修复上游阶段名 `execution` → `executing`、PowerShell 写拦截、subagent 归属身份、Stop 通道映射。
