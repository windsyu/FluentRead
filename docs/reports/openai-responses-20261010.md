# openai responses 本地验收记录

日期：2026-10-10。开发分支：`codex/openai-responses`。基线：`5d8b9e90fb96c48a5d03f85d305c687855a0d3f7`。

下文记录发布前、版本保持 `0.0.37` 的本地实现及真实 New API 验收。用户随后授权提交 Fork 并发布新版本；`0.0.38` / 用户脚本 `2.0.2` 的发版补充见文末，旧 ZIP 大小和校验值不代表新 Release 资产。

## 实现范围

新增独立供应商 `openaiResponses`，显示名 `openai responses`。服务地址、凭据、模型、提示词、高级请求体和请求限制均沿用现有按服务存储；既有 OpenAI、New API、自定义 Chat 服务不迁移，也不增加全局协议开关。

端点、缓存身份和凭据绑定共享规范地址规则。原生请求使用 `instructions` 和数组 `input`，固定 `stream: true`、`store: false`；拒绝 `messages`，过滤四个不适用的采样/输出上限字段。连接检查与翻译使用同一 registry 和真实 SDK transport。SSE 按[官方 OpenAI 事件定义](https://developers.openai.com/api/reference/resources/responses/streaming-events)处理，只在有效 completed 终态且有有效译文时返回；失败、断流或取消不返回或缓存部分译文。

首期只提供文本翻译与连接检查，不提供逐字界面、阅读/写作助手或图片识别。Responses 不显示无效 Thinking 开关；原生 reasoning 参数通过高级请求体设置。

## 已通过的检查

| 检查 | 结果 |
| --- | --- |
| 最终协议、配置、旧 Chat、Vue 生命周期、语言与目录专项 | 12 文件，405/405 通过；其中新 transport 集成 33 项、SSE 62 项 |
| 协议专项严格覆盖率 | 12 文件，521/521 通过；规范地址、endpoints、errors、responses-api、templates 的 statements/branches/functions/lines 均 100% |
| 回归分组 | 37 文件，984/984 通过 |
| 测试审计 | 633 文件、10154 静态用例，唯一分组/重复/.only/.skip/忽略审计通过 |
| 类型检查 | `pnpm compile` 通过 |
| Chrome / Firefox / userscript | 三种生产构建均通过；manifest verifier 和 userscript verifier 通过 |
| 文档 | `pnpm docs:build`、Storybook 构建与两种文档 verifier 均通过；完整站点检查需要先构建 Storybook 链接目标 |
| 真实 Chrome + 本机 HTTP/SSE 夹具 | 8 项通过，11 个请求，运行时异常和外部请求均为 0 |
| 真实 Chrome + 用户自建 New API | 最终验收 7 项通过，17 个请求全部结束：16 个 HTTP 200 SSE，1 个预期 HTTP 401 |

覆盖率只报告上述五个协议模块，不能据此宣称全仓或 SDK transport 边界四维 100%。该 transport 按仓库现有规则属于集成边界，使用真实 SDK 行为测试验收。整组运行之后补充的默认模板、Thinking 与 HTML 错误协议提示用例已纳入最终专项和审计。Responses 的 HTML 错误不会泄漏网页或误建议 Chat 协议，旧 Chat 提示保持不变。

真实浏览器验证发现连接检查存在既有 UI 生命周期问题：配置广播重建嵌套映射，即使连接身份没有变化，返回新数组的 watcher 仍会使成功的检查失效。现在逐项比较前后身份字段；同值广播不取消检查，真实地址、模型、Key 变化、根配置替换和失活仍隔离旧结果。回归先验证红灯（27 项中新增的 3 项失败），修复后 27/27 通过；覆盖 Responses、OpenAI、DeepSeek。最终专项、回归、审计、类型检查和三种生产构建均在修复后重新通过。

## 全仓既有失败

| 命令 | 记录结果 |
| --- | --- |
| `pnpm test:architecture` | 1581 通过，1 失败 |
| `pnpm test:unit` | 8594 通过，2 失败，1 既有跳过 |
| `pnpm test:functional` | 6347 通过，24 失败 |
| `pnpm test:coverage` | 14405 通过，25 失败，1 既有跳过；因测试失败退出，未生成全仓最终覆盖率报告 |

失败集合涉及 `imageTranslationRuntime`（16）、`imageAuthorizedReadBudget`（2）、`localModelReadiness`（1）、`userscriptFreeTranslationSettings`（1）、`settingsUiArchitecture`（1）、`implementationAudit48A`（1）和 `implementationAudit49I`（5）。分组交叠，不能把各组失败数相加。

已通过 `git archive HEAD` 提取未修改基线，并关闭 Vitest 缓存，分别核对上述七个文件。第一批两份结果均为 272 总例、251 通过、21 失败；第二批两份结果均为 163 总例、157 通过、6 失败，测试状态、失败名称和断言一致。相关需要 loopback/进程观察的检查在获准的沙箱外运行，无权限拒绝证据。本轮不修改这些无关故障，也不降低覆盖率阈值。

## 浏览器执行范围与限制

使用自有临时 Chrome profile，通过 `Extensions.loadUnpacked` 加载最终 MV3 产物并核对扩展 ID；未访问日常 profile。启动方式为 `macos-background-cdp`，焦点策略为 `launchservices-no-foreground`，自有资源通过 ownership helper 清理。

八项覆盖：根地址、`/v1`、完整端点与 Key 保留；单一地址字段、模型及提示词保存重开；流内 error；incomplete；分片 UTF-8 全文翻译/恢复/再译；请求期间导航后无迟到插入；旧 Chat JSON；Responses 隐藏 Thinking 而 Chat 保留。

读流取消/超时与 reader、监听器、调度槽位释放由自动化集成/单元测试验证。浏览器导航专项只证明没有迟到 DOM 插入，不证明服务端 socket 提前断开。

窗口请求为只读 NSScreen 布局推导的屏幕外正常尺寸 `(1984,0,1440,1000)`，系统夹回实际 `(1880,30,1440,994)`，仍与主屏重叠 40px。报告明确 `offscreen=false`，不能宣称完全屏幕外执行。焦点检查前后前台进程未改变，未调用 `bringToFront()` 或最小化。

本机证据：`/private/tmp/fluentread-openai-responses-ui-final/report.json` 及同目录四张截图；专项覆盖率在 `/private/tmp/fluentread-responses-protocol-coverage/coverage-summary.json`；分组与构建日志在 `/private/tmp/fluentread-responses-*-final.log`。基线对照目录为 `/private/tmp/fluentread-responses-baseline.Z1Px2e`。临时证据不随源码公开分发，也不含真实服务凭据。

## 用户脚本资源

未发布的七语言设置文案使用已发布精确提交的远端资源加小型压缩覆盖，不引用尚不存在的远端哈希文件，不写回原始资源缓存。最终脚本 1,979,094 字节，相对基线约增加 14.5 KB；体积预算有界从 1,965,000 调整为 1,980,000，其他 verifier 断言保持不变。userscript 设置也复用原生接口地址及高级请求体说明，相关最终六组测试 146/146 通过。依赖、锁文件和正式版本号未改动。

未验证 Firefox 实机或 userscript 管理器。密钥不应粘贴到对话、源码、日志或报告。

## 真实 New API 验收

用户已提供自建 New API 的 HTTPS 根地址、精确模型名 `gpt-6-luna` 和外部本机凭据文件位置。预检通过：代理与直连均能完成正常 TLS 验证，使用内存读取的凭据查询 `/v1/models` 返回 HTTP 200，指定模型在目录中。未输出密钥或模型目录正文，未修改原始凭据文件；原文件权限为 644，已提醒用户建议自行收紧至 600。

用户明确允许普通正常尺寸后台窗口作为本轮验收例外。最终运行使用独立临时 profile 和最终 Chrome MV3 目录，启动方式 `macos-background-cdp`、焦点策略 `launchservices-no-foreground`，窗口为副屏后台正常尺寸 `(−1476,33,1440,949)`；`backgroundWindowException=true`、`offscreen=false`。前台应用未改变，自有测试浏览器没有成为前台；未最小化或调用 `bringToFront()`。

最终七项均通过：

1. 根地址连接检查、未缓存的新段落网页翻译、恢复原文和再次翻译。
2. `/v1` 地址的相同流程。
3. 完整 `/v1/responses` 地址的相同流程。
4. 地址、模型、Key 配置保存并重开。
5. 故意使用随机无效 Key 得到 401，恢复正确 Key 后连接检查成功。
6. 翻译中导航取消后无迟到 DOM 插入。
7. 导航取消后下一请求成功。

精确模型为 `gpt-6-luna`。最终 17 个请求全部结束：16 个 HTTP 200 SSE 均有有效字节、正确鉴权、原生 input/instructions、布尔 stream/store，且不含禁止字段；另 1 个为预期 401。请求上限 20，Node 侧实际截获 17 个；读取凭据前的 loopback Worker 截获探针通过。TLS 正常验证，不允许重定向。网络守卫拒绝数、非授权网络访问和运行时异常均为 0。只观察并转发原生请求及 SSE 字节，不替换解析器或译文。自有浏览器退出后临时 profile 已删除，未修改原始凭据文件。

导航时没有观察到上游提前 abort，实际请求随后完成。因此只证明页面取消隔离和下一请求可用，不宣称服务端 socket 提前断开；读流取消、总超时和 reader/监听器/调度槽位释放仍以离线测试为证。

最终证据为 `/private/tmp/fluentread-responses-live-verified-20261010/report.json`，同目录的 `article-root.png`、`article-v1.png`、`article-full.png` 已逐张核对目标新段落译文；`configuration-redacted.png` 遮盖凭据。脚本在目标译文出现及恢复/重译后再次检查新增请求均已成功结束，避免缓存的其他中文段落造成误判；新增断言已对最终证据逐项重放通过。

此前诊断轮不作为最终成功依据：两轮发现上述连接检查 UI 问题，另一轮发现验收脚本可能把其他缓存段落误判为新目标成功，随后修正等待及截图核对。含诊断在内本轮共发送 56 个 POST；17 是最终验收轮而非全部诊断请求总数。未获后台窗口例外前的定位/焦点诊断没有发送 provider POST。临时原始证据不随源码或交付包公开分发，持久报告不记录真实地址或凭据位置。

## 发布前本地交付（0.0.37）

- Chrome/Edge 可加载目录：`.output/chrome-mv3`。
- ZIP：`.output/fluentread-openai-responses-chrome-edge-20261010.zip`，18,916,976 字节。
- SHA-256：`6ee8214080b81c939299d8c4e7c74c65308b62538abe6ff6924f6947bcff2c80`。

ZIP CRC 校验通过，423 个文件与实测目录名称及内容逐字节一致；manifest 为 MV3、版本保持 `0.0.37`。源码、测试、脚本、文档及 ZIP 密钥扫描为 0，ZIP 不含自建服务地址、测试 profile、日志或凭据文件。构建内 `QuickTranslationProfiles` 的 JS/CSS 是正常功能资源，不是浏览器 profile。交付包不预置用户的凭据或服务配置。

文档说明了独立 Responses 服务及原生高级请求体边界；本轮未推送、创建 PR、发布 Release、升级依赖或修改正式版本号。

## 后续 Fork 发版（0.0.38）

用户后续明确授权向自己的 `windsyu/FluentRead` 提交并发布 Release。开发分支仍为 `codex/openai-responses`，不修改 `main`。正式构建元数据更新为扩展 `0.0.38`、用户脚本 `2.0.2`，不升级依赖或锁文件。

版本更新后重跑：405/405 协议与配置专项、984/984 回归、21/21 用户脚本元数据/manifest 专项、633 文件 / 10154 静态用例审计和类型检查通过。Chrome、专用 Edge、Firefox 与用户脚本重新构建，ZIP CRC、逐文件目录一致性及 manifest verifier 通过；Firefox 附带审查源码 ZIP。用户脚本仍为 1,979,094 字节并通过 verifier。发布前只更新版本元数据，没有重新发送真实 New API 请求。

新版本本机 SSE 浏览器夹具 8/8 通过、11 个请求，无运行时异常或外部请求；实际加载 manifest `0.0.38`。仍使用用户授权的普通正常尺寸后台窗口例外，`macos-background-cdp` / `launchservices-no-foreground`，`offscreen=false`，不使用日常 profile。证据在 `/private/tmp/fluentread-responses-release-0.0.38-ui/report.json`，不公开分发。测试脚本已修正相对 focus-safe helper 路径的解析，避免文档命令被当成 Node 包名。

下载资产、安装方式及限制见 [v0.0.38 发版说明](../releases/v0.0.38.md)。该 Fork Release 不等同于上游官方发行或商店提交；真实服务的取消限制与全仓基线失败说明继续有效。
