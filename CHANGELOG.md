# 更新日志

本文件记录本插件的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [1.0.0] - 2026-10-08

首个版本。

### 新增

**存储布局**

- 记忆默认存在**会话工作目录**下的 `./memory/`（`root` 可配置，最多 3 级）。
  工作目录取自 `exec.agent.session.header.cwd`，因此每个工作区各有独立的一份记忆。
- 索引 `MEMORY.md`：按分类分组、带链接与标签/日期/大小。
- 需要分类的按需建子目录（`category` 支持最多 3 级，如 `people/work`）；
  不需要分类的直接写在记忆根目录 —— 省略 `category` 即可。

**四个工具**

- `memory_save` —— 存一条记忆。同名默认报错而非静默覆盖，`overwrite: true` 才替换。
- `memory_recall` —— 不带参数返回索引；带 `name` 读单条，支持相对路径与唯一后缀匹配，
  匹配到多条时报错并列出候选（不猜）。
- `memory_search` —— 跨全部记忆全文检索（标题、标签、正文，大小写不敏感），带命中摘录。
- `memory_forget` —— 删一条；只接受单个 `.md`，永远不删目录。

**索引是「投影」而不是「账本」**

`MEMORY.md` 每次都由磁盘上的记忆文件重新生成，因此不会出现索引与实际内容漂移。
代价是手工写进索引的内容会在下次重建时被覆盖 —— 文件头写明了这点。

**记忆文件格式**

front matter（`title` / `tags` / `created` / `updated`）+ Markdown 正文。
刻意不引入 YAML 解析器：只有 `key: value` 行，坏行忽略而不是抛错；
没有 front matter 的文件也照样收录，标题回落到文件名。

**四层路径防护**

1. `safeSegment` —— 拒绝 `..`、`.`、绝对路径、路径分隔符、Windows 非法字符、控制字符、
   系统保留名（`CON`/`NUL`/`COM1`…）、以点或空格结尾、超过 64 字符。
2. 层级限制 —— `category` 与 `root` 最多 3 级。
3. `resolveInside` —— 拼接后再用 `relative()` 校验一次，以 `..` 开头即拒绝。
4. 删除只接受 `.md` 文件。

**设置面板**

- 新增浏览器半侧 `client.js`，在插件页提供设置卡，改动**立即生效，无需重启**。
- 设置项：`enabled`、`root`、`indexFile`、`autoIndex`、`maxEntryBytes`、`searchMaxResults`。
- 配置分层与其它插件一致：`cordis.patch.yml` 写部署默认值，
  用户覆盖落到 `$DSH_HOME/state/dsh-bundle-memory/settings.json` 的稀疏覆盖层。

### 测试

- `test-host.mjs`（59 项断言组）：配置归一化与夹取、四层路径防护（含嵌套 `..` 穿越尝试）、
  slug 派生、front matter 往返与容错、索引生成与分组、
  四个工具的完整行为、**工作区隔离**、面板路由的 403/405/400、
  停用后工具立即注销、受限代理降级。
- `test-client.mjs`（20 项断言组）：注册路径、apply 容错、组件渲染、
  文案键对齐，以及三条「界面不会报错」的回归 ——
  **字段标签必须可见**、**用到的 CSS 变量必须真实存在**、
  **文案里不能有 Markdown 标记**（面板是纯文本渲染，`**x**` 会显示成字面星号）。
