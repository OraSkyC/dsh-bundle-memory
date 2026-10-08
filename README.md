# 记忆管理 · dsh-bundle-memory

一个 [DeepSeek Harness](https://github.com/OraSkyC/dsh-bundle-memory)（DSH）插件：
给智能体一个**跟着工作区走**的记忆库。

开启后，记忆默认存在**当前工作目录的 `./memory/`** 下，根目录放一个自动维护的
`MEMORY.md` 索引；需要分类的按需建子目录，不需要分类的直接写在根目录。

> [English](README.en.md) · 简体中文

---

## 它长什么样

```
<你的工作目录>/
└── memory/                       ← 记忆根目录（可配置）
    ├── MEMORY.md                 ← 索引，插件自动生成
    ├── 用户偏好用-pnpm.md          ← 不需要分类的，直接写在根目录
    ├── 部署注意事项.md
    └── 项目约定/                  ← 需要分类的，按需建子目录
        └── 提交信息用中文.md
```

`memory_recall` 不带参数时返回的就是索引：

```markdown
# 记忆索引

> 本文件由 dsh-bundle-memory 自动生成，手工改动会在下次保存记忆时被覆盖。

- 工作区：`D:\OraSkyC\Project\Python`
- 记忆根目录：`D:\OraSkyC\Project\Python\memory`
- 共 3 条记忆

## 未分类

- [用户偏好用 pnpm](./用户偏好用-pnpm.md) — 工具链, 偏好 · 2026-10-08 · 420 B
- [部署注意事项](./部署注意事项.md) · 2026-10-08 · 1.1 KB

## 项目约定/

- [提交信息用中文](./项目约定/提交信息用中文.md) — 约定 · 2026-10-08 · 380 B
```

## 为什么是「跟着工作区走」

记忆的根目录是**相对于会话的工作目录**（`exec.agent.session.header.cwd`）算出来的，
所以：

- 在 A 项目里记的东西，在 B 项目里**看不到** —— 不会串味；
- 记忆跟着代码走，可以直接提交进版本库（如果你愿意），换台机器 clone 下来还在；
- 想集中存也行，把 `root` 填成 `notes/mem` 之类即可（仍相对工作目录）。

这和「全局记忆」是两种取向：全局记忆省事但容易把项目细节混在一起，
工作区记忆多花一点空间但边界清楚。这个插件选了后者。

## 四个工具

| 工具 | 作用 |
| --- | --- |
| `memory_save` | 存一条记忆。给 `title` + `content`；`category` 可选（`项目约定` 或 `people/work`，最多 3 级）—— **省略即直接写在根目录**。同名默认报错而不是静默覆盖，要覆盖得显式传 `overwrite: true`。 |
| `memory_recall` | 不带参数 → 返回索引（先看它）；带 `name` → 读某一条。`name` 可以是相对路径（`项目约定/提交信息用中文.md`），也可以是唯一后缀（`提交信息用中文`）；匹配到多条会报错并列出候选，**不猜**。 |
| `memory_search` | 跨全部记忆做全文检索（标题、标签、正文，大小写不敏感），返回匹配路径与命中处的摘录。记得有这件事但忘了在哪时用它。 |
| `memory_forget` | 删一条记忆。只接受单个 `.md` 文件，**永远不会删目录**，也不会碰 `./memory/` 之外的任何东西。 |

## 安装

**设置 → 插件 → 添加插件**，填入：

```
https://github.com/OraSkyC/dsh-bundle-memory
```

或命令行：

```bash
dsh plugin --profile desktop add https://github.com/OraSkyC/dsh-bundle-memory
```

装完**重启 DSH**。

## 设置

**设置 → 插件 → 记忆管理**。改动**立即生效，不用重启**。

配置分两层：`cordis.patch.yml` 写部署默认值（改完需重启），
用户覆盖落到 `%USERPROFILE%\.dsh\state\dsh-bundle-memory\settings.json` 的**稀疏覆盖层**，
点「恢复默认」是删除那个键、回落部署默认值。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后不注册任何记忆工具，面板仍可打开。 |
| `root` | `memory` | 记忆根目录，相对于会话工作目录，最多 3 级。 |
| `indexFile` | `MEMORY.md` | 索引文件名，位于记忆根目录下。 |
| `autoIndex` | `true` | 每次保存/删除后自动重建索引。 |
| `maxEntryBytes` | `262144` | 单条记忆正文上限（1024–4194304 字节），防止一次把大文件塞进一条记忆。 |
| `searchMaxResults` | `20` | `memory_search` 默认返回条数（1–100）。 |

## 设计要点

### 索引是「投影」，不是「账本」

`MEMORY.md` 每次都由磁盘上的记忆文件**重新生成**（扫描目录 → 读每个文件的 front matter →
按分类分组渲染）。因此不存在「索引和实际内容不一致」这种状态 —— 那是最容易腐坏的东西。

代价是：**手工往 `MEMORY.md` 里加的内容会在下次重建时消失**。文件头写明了这点。
想加记忆就放一个 `.md` 文件进目录（插件会把它纳入索引），或者用 `memory_save`。

### 每条记忆的格式

```markdown
---
title: 用户偏好用 pnpm
tags: 工具链, 偏好
created: 2026-10-08T08:31:24.000Z
updated: 2026-10-08T08:31:24.000Z
---

不要在文档里写 npm。
```

刻意**不引入 YAML 解析器**：格式只有 `key: value` 行，手写解析更可预测，
而且遇到用户手改坏的行只会忽略、不会抛错。没有 front matter 的文件也照收，
标题回落到文件名。

### 写入路径的防护

这是整个插件最需要小心的地方 —— 智能体给的 `name` / `category` 最终会变成文件路径。
一共四层：

1. **片段校验**（`safeSegment`）：拒绝 `..`、`.`、绝对路径、路径分隔符、
   Windows 非法字符（`\ / : * ? " < > |`）、控制字符、系统保留名（`CON`/`NUL`/`COM1`…）、
   以点或空格结尾、超过 64 字符。
2. **层级限制**：`category` 与 `root` 最多 3 级。
3. **拼完再验一次**（`resolveInside`）：用 `relative()` 检查结果是否仍在记忆根目录内，
   以 `..` 开头就拒绝。即使前面被绕过，这一层也会挡住。
4. **删除只接受 `.md` 文件**：`memory_forget` 永远删不掉目录，也删不掉索引本身。

四层都有测试覆盖，包括各种嵌套 `..` 的穿越尝试。

### 「当前工作目录」从哪来

```js
const cwd = exec.agent.session.header.cwd ?? process.cwd();
```

工具的第二个参数 `exec` 里带着 agent，agent 带着 session，session 的 header 里有 `cwd`。
**不能用 `process.cwd()`** —— 那是 DSH 自己的安装目录，不是你的工作区。

## 要求

| 项目 | 要求 |
| --- | --- |
| DSH | `web` 或任何带 Host `tools` 服务的 profile |
| Node | `>= 22.19.0` |
| npm 依赖 | **无**（只用 `node:` 内建模块） |
| 构建步骤 | **无** |

插件依赖 Host 的 `tools` 与 `webServer` 两个服务
（`inject = ['tools', 'webServer']`）。`webServer` 是**硬依赖**：
Cordis 的 `ctx` 是受限代理，读一个没声明在 `inject` 里的属性会**抛错**而不是返回 `undefined`，
漏声明会让整个 `apply()` 失败、插件在插件页显示「异常」。

## 常见问题

**记忆会进版本库吗**
`./memory/` 就在工作目录里，取决于你的 `.gitignore`。想让它跟着代码走就别忽略；
不想就加一行 `memory/`。

**为什么智能体不自己想起来用**
这个版本**没有**把索引自动注入上下文 —— 智能体需要主动调 `memory_recall` 或
`memory_search`。建议在项目的 `AGENTS.md` 里写一句「开工前先 `memory_recall` 看索引」。
自动注入是可行的后续方向，但需要构造会话消息并插进消息流，风险更高，单独做。

**索引被我不小心改坏了**
删掉 `memory/MEMORY.md`，下次任何一次保存/删除都会重建它；或者直接调一次
`memory_recall`（不带参数）触发重建。

**能不能存二进制 / 附件**
不能。这是纯 Markdown 记忆库，只认 `.md`。别的东西放工作区别的地方。

## 目录结构

```
dsh-bundle-memory/
├── package.json         # 清单：dsh.bundle.patch / dsh.client / files
├── cordis.patch.yml     # 注册 entry（id: memory）+ 部署默认配置
├── lib/index.js         # 配置契约、路径安全、索引生成、四个工具、面板路由
├── client.js            # 浏览器半侧：插件页里的设置卡
├── icon.svg
├── locale/zh.json       # meta.title / meta.description
├── locale/en.json
├── README.md            # 本文件
├── README.en.md         # 英文版
├── CHANGELOG.md
├── LICENSE
├── test-host.mjs        # 宿主侧：59 项断言组
└── test-client.mjs      # 浏览器侧：24 项断言组
```

## 开发

```bash
npm run check     # 语法检查
npm test          # 宿主 59 项 + 客户端 24 项断言组
```

宿主测试用真实临时目录，覆盖配置归一化、四层路径防护、front matter 往返、
索引生成、四个工具的全部行为、工作区隔离、面板路由。
客户端测试覆盖注册路径、组件渲染，以及两条「界面不会报错」的回归：
**字段标签必须可见**、**用到的 CSS 变量必须真实存在**。

## 许可证

[MIT](./LICENSE)
