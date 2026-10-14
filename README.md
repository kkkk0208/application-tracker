# Application Tracker

Chrome 求职投递记录与网申填写助手。2026-10-14 本轮审查修复后的当前源码，manifest/package 仍为 0.4.0。

## 当前进度

完成侧栏简化、AI 资料目录配对、逐题发送确认、填写后手动记录投递。本轮修复扫描性能、慢 CPU 日期、原生选项组题名、业务同意区分、链接清理、Excel 日期和最近岗位 SPA 路由；按用户选择放宽开放长文记忆配对与长文本草稿，记忆默认不选，发送资料前确认。统一填写确认、只填空字段、条款保护、人工编辑保护、失败撤销与不自动提交保留。

本轮 551 项常规检查通过：344 单元、129 浏览器、45 助手 UI、12 数据 UI、14 真实 MV3、7 截图浏览器；另有 2 项性能、9 项 4 倍慢 CPU 日期，六时区单元和三份清理网页样本达标。真实 AI 服务和真实招聘账户尚未现场验证。

详见 [本轮实施记录](application-tracker-extension/docs/2026-10-14-review-execution.md)、[输入审查](application-tracker-extension/docs/2026-10-14-review-and-fixes.md)、[更新记录](application-tracker-extension/CHANGELOG.md)。历史计划及报告描述当时状态，当前源码与 SOURCE_MANIFEST.json 为准。资料 v2、整页理解和可选网页标记尚未实施。

## 给普通 Claude Chat 看

从 [审查入口](review/00_START_HERE.txt) 开始，按当前源码或 review/ 中带路径、行号与 SHA256 的 TXT 阅读。[审查提示词](review/PROMPT_FOR_CLAUDE.txt) 可复制到对话。TXT 均由本次公开文件重新生成，Excel 运行库保留原文件但不重复放入 TXT。

## 安装和开发

Chrome 加载已解压扩展时选择 application-tracker-extension/，包含 vendor/xlsx.full.min.js。[使用说明](application-tracker-extension/README.md)。在该目录安装依赖后运行 npm test；浏览器检查需要 Playwright 与 Chrome。

## 上传范围

公开源码、运行库、虚构测试和审查材料；排除真实凭据、浏览器存储、个人资料导出、依赖、历史 dist、备份、交付压缩包、日志、截图和招聘网页 HTML。源码默认 apiKey 为空，测试凭据均为虚构。三份 real-pages/*.html 未上传，test:real-pages 及 test:browser 中 job-info 的相关样本检查需要另行提供清理页面；脚本与预期保留，本地本轮已实际运行。

SOURCE_MANIFEST.json 列出公开文件的原始字节 SHA256，Git 使用 .gitattributes 保留这些字节，可区分同为 0.4.0 的不同源码。
