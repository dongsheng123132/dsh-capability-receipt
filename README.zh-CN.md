# dsh-capability-receipt

[![CI](https://github.com/dongsheng123132/dsh-capability-receipt/actions/workflows/ci.yml/badge.svg)](https://github.com/dongsheng123132/dsh-capability-receipt/actions/workflows/ci.yml)
[![MIT 许可证](https://img.shields.io/github/license/dongsheng123132/dsh-capability-receipt)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Awesome DSH Plugins](https://img.shields.io/badge/Awesome_DSH-%E5%B7%B2%E9%AA%8C%E8%AF%81%E5%AE%9E%E9%AA%8C-0969da)](https://github.com/dongsheng123132/awesome-dsh-plugins/blob/main/README.zh-CN.md#2origin-%E6%8F%92%E4%BB%B6%E5%AE%9E%E9%AA%8C%E5%AE%A4)

`dsh-capability-receipt` 用来证明 DeepSeek Harness **实际加载了哪份 skill**。它对 `ctx.skills.get()` 返回的有效指令正文做哈希，记录胜出的 provider、source 与调用策略；如果资源基址是本地目录，还会在严格限额下计算资源闭包哈希。随后，它可以把这次运行时观察与可信来源预先固定的哈希进行比对，并写出确定性的内容寻址收据。

它刻意不再发明 skill 包格式、依赖解析器、安装器、注册表、评测器、逐轮摘要或事件审计账本。包与分发应复用 [pack-agent](https://github.com/sakikoTGW/pack-agent)；本插件只补「固定来源产物」到「DSH 内实际生效能力」之间缺失的最后一跳。

v0.3.0 的 DSH 入口已经宿主中立：不导入 ToolRuntime 私有辅助包，也不暴露默认导出，因此官方 `web` profile 的 Cordis Loader 会保留模块级 `inject = ['tools', 'skills']` 契约。

## DSH 工具

- `dsh_capability_receipt_inspect`：只返回结构字段与哈希，不返回 skill 指令正文、元数据或绝对路径。
- `dsh_capability_receipt_issue`：必须提供 `expectedContentSha256`，可选比对资源闭包、provider、source 与调用策略，只能向显式指定的工作区相对 `artifactDir` 写收据。
- `dsh_capability_receipt_issue_from_pack`：读取工作区相对的 pack-agent `agent-pack/lock/v1`，按 pack-agent 原算法重算目录来源和 portable bundle 两种 skill 哈希，要求 DSH 有效正文等于锁定 `SKILL.md` 去 frontmatter 后的正文，再核验可选 provider/source/调用策略并写出同一收据格式。

插件只观察，绝不执行目标能力。出现以下情况会闭门失败：DSH 目录不完整、观察期间目录变化、加载定义与目录条目不一致、任一期望不匹配，或资源无法安全闭包。

## MCP 证明表面

正式 `.mcp.json` 声明提供两个 stdio 工具：

- `capability_receipt_inspect_lock`：解析显式内联的 pack-agent lock，只返回身份与哈希。
- `capability_receipt_verify_recorded`：把显式录制的 DSH 内容/资源摘要信封与 lock 比对，返回内容寻址判决。

MCP 表面刻意保持纯内存、只证明：不能查看 DSH 实时注册表、读文件、联网、执行能力或写收据。实时观察与产物签发仍由 DSH ToolRuntime 工具完成，两种表面共用同一核心核验器。

## pack-agent 桥接

pack-agent 完成 export/install 后，直接用它的 lock 签发收据，不翻译成第二套 manifest：

```text
pack-agent .agent-pack/lock.json
          │ skill contentHash + fileCount
          ▼
dsh_capability_receipt_issue_from_pack
          │ 重算 pack-agent hash + 比对已加载 SKILL.md 正文
          ▼
内容寻址的 DSH 运行时收据
```

必填输入为 `skillName`、`packLockPath` 和 `artifactDir`。lock 中的 `ref` 与 `lockedAt` 不会进入收据。当前桥接固定兼容 pack-agent commit `e2db1f8f56b74b64597a01175c810358f2c0b450` 观察到的哈希契约，fixture 记录了对应 upstream Git blob。目录来源与 portable bundle 的路径形式都能识别，实际命中的形式会明确写入 `verification.matchedHashMode`。

## 安装到 DSH

在隔离的 DSH profile 中固定经过审查的提交：

```bash
dsh plugin --profile capability-proof add \
  github:owner/dsh-capability-receipt#<commit>
```

本包声明了 DSH bundle 并提供 `cordis.patch.yml`，安装成功后会自动把该层加入对应 profile。

## 离线核验收据

CLI 不发现也不加载 skill，只核验已经签发的产物：

```bash
dsh-capability-receipt verify \
  --receipt artifacts/capability-receipt-<sha256>.json \
  --require-verified
```

stdout 只有一行 JSON；失败写 stderr 并以 `4` 退出，用法错误以 `1` 退出。

## 资源安全

目录闭包默认最多 256 个普通文件、单文件 1 MiB、总计 8 MiB。符号链接和特殊文件一律拒绝；URL 与 opaque 资源基址只披露为不可闭包，不主动联网抓取。可信的 DSH 配置可调整这些限额。

## 开发

```bash
npm install
npm test
npm run check
npm run smoke:plugin
npm run smoke:mcp
DSH_CHECKOUT=/path/to/deepseek-harness npm run smoke:dsh
```

需要 Node.js 22 或更高版本，不使用任何安装生命周期脚本。

## 证明边界

`verified` 收据只证明：在某次 DSH 运行时观察中，有效能力与调用者提供的固定期望或某份 pack-agent lock 相等。pack lock 是证据输入，不是签名或信任锚；桥接会核验它与运行时文件及有效正文相等，但不证明是谁生成了 lock。它也不证明 skill 有用或安全、能力已经执行，或外部模型/工具行为正确。来源提交、代码审查和评测证据仍需另行固定和保存。
