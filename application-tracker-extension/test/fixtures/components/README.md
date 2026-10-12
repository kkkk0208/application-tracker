# 离线组件验收页

这些页面直接运行本地依赖的真实 Ant Design 3、Ant Design 5 和 Element UI 2 组件。所有示例选项和数据都是虚构的，测试服务器只允许本地请求。

安装开发依赖后执行 `npm.cmd run test:components`。组件测试也包含在 `test:browser` 中。使用 `BROWSER_EXECUTABLE` 可以指定 Chromium 浏览器路径。

每个真实组件页面包含普通下拉、搜索下拉、三级级联、日期、月份、日期范围、单选、多选。测试同时核对页面读数和框架持有的值，避免只改 DOM 的假成功。My97 页面仅模拟输入接口及 `dateFmt`，不宣称覆盖 My97 弹出日历。

依赖由 `package-lock.json` 固定，页面只读取 `/node_modules/` 下的 UMD 脚本与样式，不使用 CDN。
