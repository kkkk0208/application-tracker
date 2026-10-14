# Application Tracker

Chrome 求职投递记录与网申填写助手。此仓库于 2026-10-14 同步，包含 2026-10-13 已完成验收的最新本地源码与 Claude 审查材料。

## 当前进度

侧栏简化、AI 资料目录配对、用户单题确认草稿、填写后手动记录投递与重复提醒已完成。统一预览确认、只填空字段、条款保护、可信用户修改保护、失败撤销与不自动提交保留。manifest/package 仍为 0.4.0。

最新本地验收共 534 项通过：335 逻辑、123 浏览器、43 助手 UI、12 数据 UI、14 MV3 扩展、7 截图浏览器；另外三份清理网页样本四项指标全部达标。同步时逐文件核对主源码，不重复运行无变化的功能测试。真实 AI 服务与真实招聘账号尚未现场验证。

详见 [最新实施记录](application-tracker-extension/docs/2026-10-13-simplify-execution.md)、[先前缺陷修复](docs/2026-10-13-claude-fixes.md)、[更新记录](application-tracker-extension/CHANGELOG.md)。报告里“GitHub 未更新”描述的是报告日期的状态，此次同步已包含其实现。原改进方案的资料 v2、整页理解与可选网页标记不在本轮交付范围。

## 给普通 Claude Chat 看

先读 [审查入口](review/00_START_HERE.txt)，再读当前源码或 review/ 中带路径、行号和 SHA256 的 TXT。所有 TXT 已从本次上传源码重新生成。[审查提示词](review/PROMPT_FOR_CLAUDE.txt) 可复制到对话中。

## 安装和开发

Chrome 加载已解压扩展时，选择 application-tracker-extension/。[使用说明](application-tracker-extension/README.md)。在该目录安装依赖后运行 npm test；浏览器测试还需要 Playwright 与 Chrome。

## 上传范围

只公开源码、虚构测试、审查文档与 TXT；排除实际 API Key、浏览器存储、个人资料导出、依赖、历史 dist、源码备份、日志、截图和招聘网页 HTML 快照。AI 设置源码默认 apiKey 为空，测试中的凭据为虚构字符串。三份 real-pages/*.html 仍省略，test:real-pages 需要自行提供经复核的清理页面，expected.json 与脚本保留。

SOURCE_MANIFEST.json 列出上传文件哈希；可据此区分相同 0.4.0 版本下的源码变化。
