# 2026-10-14 审查结果与修改清单

- 基于：`kkkk0208/application-tracker` 的 `c1a57b3`（2026-10-14）
- 附带补丁：`2026-10-14-review-fixes.diff`。在仓库根目录执行 `git apply`；我已在全新克隆的 `c1a57b3` 上确认可以干净应用。
- 测试环境：Linux、Chromium 1194、Playwright 1.56，全部使用虚构数据。请以 Windows Chrome 的结果为准。

> 给执行者（Codex）：
> 1. 先应用补丁，再运行第 5 节的全部命令。
> 2. 补丁已处理第 1～5 项；第 6 项以后按本文修改。
> 3. 规则同前：旧测试因有意改动而失败时，改测试并写进 CHANGELOG；其他失败修代码。
> 4. 不扩大范围：不自动提交、不覆盖已有值、不做资料 v2 和整页理解。

## 1. 测试结果

| 套件 | 原 c1a57b3 | 打补丁后 |
|---|---|---|
| 单元测试 | 335 通过 | 339 通过（新增 4 条）；北京、香港、UTC、纽约、伦敦 5 个时区都通过 |
| browser / choice / 日期格式 / 上下文 / vision | 34、9、5、14、7，全部通过 | 同左 |
| component | 3 次全量中有 1 次失败 2 项 | 连续 2 次 46/46 |
| ui / data-ui / 真实扩展 | 43、12、14，全部通过 | 同左 |
| 新增 scan-scaling-check | 失败（增长 24.8 倍、26.6 倍） | 通过（4.7 倍、6.5 倍） |
| 新增 slow-cpu-date-check（CPU 降速 4 倍） | 失败 | 9/9 通过 |
| job-info、real-pages | 网页 HTML 没上传，无法运行 | 同左 |

## 2. 补丁已处理

### 1. 扫描性能退化（P0）

- **现象**：
  - 300 题时扫描约 5～6 秒，变化检查约 4～5 秒；旧版分别是 0.45 秒和 0.18 秒。
  - 侧栏每 2.5 秒执行一次变化检查（`assistant.js` L714-738），所以大表单在侧栏打开期间会一直卡顿。
  - 用仓库自带的 `scan-performance-check.mjs` 在我这边测，300 题时 changes 中位数为 2256ms。
- **原因**：`blockFor` 新增的 `questionsFor` 对每个字段都把所有同级块的题目重新算一遍，耗时随题数平方增长。CPU 分析中 blockFor 占 76%，questionsFor 占 62%。
- **改动**（`pageBridge.js`）：
  - 只在 scan 和 changes 这两个只读动作里，按节点缓存题目集合、`signatureOf` 的结果以及「是否含控件」。写入动作不使用缓存，始终读取最新的 DOM。
  - 当前块只有 1 道题时直接跳过，因为它不可能是重复段，也就不用再计算同级块。
- **结果**：
  - 两列布局 300 题：scan 448ms，changes 166ms。
  - 仓库自带脚本 300 题：changes 中位数 95ms。
- **门槛**：新增 `scripts/scan-scaling-check.mjs`。题数从 60 增加到 300 时，扫描时间增长超过 12 倍就判为失败。这个标准看增长倍数，不受电脑快慢影响。

### 2. antd5 日期在慢电脑上失败（P1）

- **现象**：CPU 降速 4 倍后，antd5 的日期、月份、范围日期都报「年份超出日期面板可选择范围」；正常速度下能通过。这也是 component 全量测试偶发失败的原因。
- **原因**：`chooseCalendarDate` 点开年份面板、翻十年、选完年份之后，都是立刻读取格子，没有等面板渲染出来。
- **改动**：
  - 加三处等待，每处最长 1.5 秒：等年份格子出现；翻页后等第一格的年份变化；选完年份后等月份格子或月份按钮出现。
  - 等待切换到日期面板的时间，从 600ms 改为 1.5 秒。
- **门槛**：新增 `scripts/slow-cpu-date-check.mjs`，在 CPU 降速 4 倍下检查 antd3、antd5、Element 的日期、月份、范围日期。

### 3. 带冒号的文字来源被拒，旧记录导致备份失败（P1）

- **现象**：
  - 「Referral: Alice」「Email: hr@example.com」「WeChat:abc123」「mailto:…」都被当成错误链接，不能保存。
  - 以前存过的这类记录，会让备份导出直接失败。
- **改动**：`model.js` 的 `portalReferenceError` 只拒绝两类内容：一是 javascript、data、vbscript、file、blob 开头的地址；二是无效的 http(s) 地址。其他内容都当普通文字保存。
- **测试**：`test/reviewFixes.test.js` 覆盖了可保存的文字和必须拒绝的地址，并确认这类旧记录不再阻止备份。

### 4. 投递链接里保存了登录令牌（P2）

- **改动**：
  - `model.js` 新增 `cleanPortalUrl`：去掉 token、ticket、sign、session、utm 等参数，以及网址里的账号和密码；保留 jobId 这类业务参数和 # 路由。
  - 侧栏的记录草稿（`recordDraft.js`）和弹窗（`popup.js`）都改用它。
  - `recordCard.js` 判断草稿是否属于当前页面时，也改用清理后的链接比较，否则带参数的页面每次识别都会重置草稿。
- **有意改动的测试**：`test/recordCard.test.js` 第 60 行。原来断言链接保留 `?token=temporary`，现在断言已去掉。请写进 CHANGELOG。
- **说明**：已经存下的旧记录不改。按链接查重可能匹配不到旧记录，但「公司 + 岗位」查重仍然有效。

### 5. Excel 里改过的日期导入后少一天（P1）

- **现象**（用真实 SheetJS 实测）：在北京或香港时区，Excel 里输入 2026-10-20 的日期单元格，导入后变成 2026-10-19；UTC 和纽约时区正常。
- **原因**：
  - `records.js` L455 读取时开了 `cellDates`。在这两个时区，SheetJS 返回的是前一天 23:54:17，因为它按历史时区偏移 +08:05:43 计算。
  - `excel.js` 的 `importedDate` 再用 `toISOString` 取日期，结果就少了一天。
- **改动**：日期值改为取最近的本地日期。
- **测试**：新增单测覆盖三种输入：本地零点、提前几分钟、UTC 零点。在 5 个时区都通过；原代码在北京时区失败。

## 3. 需要继续改（没有补丁）

### 6. 一些业务题被当成同意条款（P2）

- **实测**：「是否同意外派」「是否同意轮岗」「是否同意参加夜班值守」「Do you agree to work in Hong Kong?」都被标为「请在网站中手动处理」。
- **位置**：`pageBridge.js` 的 descriptor 里，`businessAgreement` 的例外词只有调剂、出差、加班、调动。
- **建议**：
  - 是否算同意条款，只看有没有法律类词语：隐私、条款、声明、承诺、授权、签名、协议。
  - 「是否同意/接受 + 业务内容」、且选项为「是/否」「同意/不同意」「Yes/No」时，按普通题处理。
  - 单个勾选框「我同意……」仍然手动处理。
- **验收**：choice-browser-tests 增加用例：上面 4 题可以填写，隐私条款仍然手动。

### 7. 题目文字写在单选组容器内部时识别不到（P3，旧问题）

- **复现**：外层没有已知的表单 class 时，下面的写法会识别成「未命名问题」：
  ```html
  <div><span>是否接受调剂</span><label><input type="radio" name="a">是</label><label><input type="radio" name="a">否</label></div>
  ```
- **建议**：在 groupBox 内取第一个选项之前的文字（不含控件，不超过 60 字）作为题目候选，来源记为 nearby。
- **验收**：browser-tests 加这个片段。

### 8. 侧栏的小问题

- **标题栏按钮**：「更新」和「重新识别」并排，容易分不清。建议把「重新识别（放弃修改）」放进 ⋯ 菜单；ui-tests 里点击前先打开菜单。
- **实习经历选择框**：写着「自动判断」，但实际不会自动判断。没确定时应显示「请选择是哪段实习」，选项显示公司和岗位名称（这些是本地数据）。
- **填完后的计数**：「不填」把刚填好的题也算了进去。结果状态下，第三个计数改为只算「在网页里处理」和「其他选填」两组。

### 9. AI 功能覆盖面（产品问题，需要你决定）

- **问答记忆配对**：`aiPairing.js` 的 `memoryFits`（L97-105）要求题目完全相同，或者本地规则对两边都有把握，所以换了说法的开放题用不上已存的记忆。
  - 可选做法：长文本类题目允许 AI 配对到记忆，状态设为「请核对」，并且默认不选中。
- **AI 写草稿**：`ai.js` 的 `safeDraftItem`（L25-37）只认几种固定说法。
  - 可选做法：所有长文本题都显示按钮，确认框里列出将要发送的教育、经历和常用回答。

### 10. 其他

- **最近岗位互相覆盖**：`recentJobs.js` L17 按清理后的链接去重，清理时去掉了 # 路由。在 Moka 这类单页网站上，看过的多个岗位会互相覆盖。建议改用「链接 + 岗位名」去重，或者保留 hash。
- **一条不稳定的测试**：component 全量里，Element「加载中手动选择」偶发失败过 1 次；我单独复现 24 次都正常。建议在测试里等选项可以点击后再点，不要用 `force`。

## 4. 已读与未读

- **已读**：
  - `pageBridge.js` 的改动部分；`aiPairing.js`、`panelView.js`、`recordDraft.js`、`recentJobs.js`、`recordCard.js` 全文。
  - `ai.js` 中写草稿的部分；`assistant.js` 中写草稿和轮询的部分。
  - `model.js`、`backup.js`、`storageMutations.js`、`excel.js` 的改动；`records.js` 的导入部分。
  - 两份实施记录和 `PROMPT_FOR_CLAUDE.txt`。
- **未读**：vision.js、visualCapture.js、看板、问答记忆页、aiProfileMemory.js、records.js 导入以外的部分，以及大部分 review/*.txt。本文结论不覆盖这些模块。

## 5. 验收命令

```powershell
npm.cmd test
npm.cmd run test:browser
npm.cmd run test:ui
npm.cmd run test:data-ui
npm.cmd run test:extension
npm.cmd run test:vision-browser
npm.cmd run test:slow
# 换一个时区再跑单元测试：
$env:TZ = "America/New_York"; npm.cmd test; Remove-Item Env:TZ
```
