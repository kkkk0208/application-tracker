# Application Tracker

Chrome 求职投递记录与网申填写助手。此仓库为 2026-10-12 当前项目源码快照，方便代码审查。

## 给 Claude 看项目

先阅读 [审查入口](review/00_START_HERE.txt)，再按模块阅读 review/ 中的 TXT（带原始路径和行号）或 application-tracker-extension/src/ 中的原始源码。[审查提示词](review/PROMPT_FOR_CLAUDE.txt) 可复制到普通聊天窗口。

## 当前进度

manifest.json 和 package.json 仍标记 0.4.0，源码已推进目标 0.5.0 的部分改进，阶段 2 尚未完成全部验收。参见 [执行记录](application-tracker-extension/docs/2026-09-28-execution.md)、[更新记录](application-tracker-extension/CHANGELOG.md) 和 [改进方案](docs/2026-09-28-improvement-plan.md)。

## 安装和开发

Chrome 加载已解压扩展时，选择 application-tracker-extension/ 文件夹。[原项目使用说明](application-tracker-extension/README.md)。单元测试在该目录执行 npm test；浏览器检查另需 Playwright 与 Chrome，见各测试脚本。

## 上传范围

源码、测试、相关文档和聊天审查文本。排除依赖、旧发布包、浏览器存储、实际 API Key、个人资料导出、历史备份、开发日志、截图和招聘网页 HTML 快照。vendor/xlsx.full.min.js 是现有运行依赖。三份 real-pages/*.html 被省略，因此 test:real-pages 不能仅凭此快照运行。

发布本仓库未重新执行功能测试；文档中的历史检查不代表当前全部测试通过。
