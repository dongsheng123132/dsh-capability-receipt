# dsh-capability-receipt

`dsh-capability-receipt` 用来证明 DeepSeek Harness **实际加载了哪份 skill**。它对 `ctx.skills.get()` 返回的有效指令正文做哈希，记录胜出的 provider、source 与调用策略；如果资源基址是本地目录，还会在严格限额下计算资源闭包哈希。随后，它可以把这次运行时观察与可信来源预先固定的哈希进行比对，并写出确定性的内容寻址收据。

它刻意不再发明 skill 包格式、依赖解析器、安装器、注册表或评测器。包与分发应复用 pack-agent 等现有方案；本插件只补「固定来源产物」到「DSH 内实际生效能力」之间缺失的最后一跳。

## DSH 工具

- `dsh_capability_receipt_inspect`：只返回结构字段与哈希，不返回 skill 指令正文、元数据或绝对路径。
- `dsh_capability_receipt_issue`：必须提供 `expectedContentSha256`，可选比对资源闭包、provider、source 与调用策略，只能向显式指定的工作区相对 `artifactDir` 写收据。

插件只观察，绝不执行目标能力。出现以下情况会闭门失败：DSH 目录不完整、观察期间目录变化、加载定义与目录条目不一致、任一期望不匹配，或资源无法安全闭包。

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
DSH_CHECKOUT=/path/to/deepseek-harness npm run smoke:dsh
```

需要 Node.js 22 或更高版本，不使用任何安装生命周期脚本。

## 证明边界

`verified` 收据只证明：在某次 DSH 运行时观察中，有效能力与调用者提供的固定期望相等。它不证明来源本身可信、skill 有用或安全、能力已经执行，也不证明外部模型或工具行为正确。来源提交、代码审查和评测证据仍需另行固定和保存。
