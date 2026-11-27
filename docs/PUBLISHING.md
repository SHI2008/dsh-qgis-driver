# 发布到 DSH 插件市场

市场（`dshmarket`）打开时实时读取 `https://awesome-dsh-plugin.com/plugins.json`，那份数据来自
[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 仓库的
`data/plugins/*.yml`，**一个插件一个文件**。所以「上架」= 给那个仓库提一个 PR，加一个 YAML 文件；两个 README
由脚本生成，不能手改。规则原文：[contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。

## 要提交的文件

内容就是 [marketplace-entry.yml](marketplace-entry.yml)（那份文件里不放注释），提交到：

```
data/plugins/SHI2008__dsh-qgis-driver.yml
```

字段说明：

- `url` / `name`：仓库根就是包（根 `package.json` + 根 `cordis.patch.yml`），所以 `url` 指仓库根、
  `name` 用 `owner/repo`，文件名对应 `owner__repo.yml`。
- `category: tools`：按插件实际做的事选；选偏了维护者会直接改，不会打回。
- `description.en` 必填，单行、以句号结尾、只说功能；含 `: `（冒号加空格）必须加引号。描述里提到的命令、
  API、数量都会被对照代码核对。
- `tarball:` 可选，填了市场会优先给「预构建安装」。它必须是 **GitHub Release 托管**的 `https` `.tgz`。
  本仓库指向 `releases/latest/download/dsh-qgis-driver.tgz`：**资产名不带版本号**，所以条目只写一次，
  以后每次发版只换同名附件即可。两个前提——资产必须真的叫这个名字（上传时用
  `uploads.github.com/...?name=dsh-qgis-driver.tgz`），且最新那次 Release **不能勾 prerelease**
  （`releases/latest` 会跳过预发布，勾了就 404）。

## 收录前的硬性条件

1. 仓库 public，创建满 1 天（CI 自动检查，仓库 2026-11 创建，已满足）。
2. 仓库带 `dsh-plugin` topic。
3. 包声明 `dsh.bundle.patch`，且 patch 文件在默认分支上（本仓库：根 `package.json` +
   根 `cordis.patch.yml`，两者都被 `dsh-tools/` 复用）。
4. 有真实可用的代码，不是占位。
5. 描述与代码一致。

CI 第 2 步是「从仓库的 `package.json` 读 `dsh.bundle`」，查找范围是**根包，或 `packages/` · `plugins/` ·
`apps/` 子包**。所以仓库根必须有清单：根 `package.json` 的 `main` 指向 `./dsh-tools/index.js`、`exports`
转发 `./dsh-tools/client.js`，`dsh.bundle.patch` 指向根 `cordis.patch.yml`（里面的行名是安装后的包名
`dsh-qgis-driver`，不是 dev 用的 `@local/dsh-qgis-driver`）。`dsh-tools/package.json` 保持 `private` 与
`@local/…`，继续服务本机 `link:` 安装；`scripts/bump.mjs` 会同时写这两个清单的版本号。

## 步骤

1. 打 tag、建 GitHub Release，把 `dist/` 里的两个交付件作为资产上传，**资产名去掉版本号**
   （`?name=` 可以任意命名，本地文件名不必改）：
   - `dsh-qgis-driver.tgz` ← `dist/dsh-qgis-driver-<bundle>.tgz`（DSH bundle，npm 布局，市场 `tarball:` 指向它）
   - `dsh_qgis_driver.zip` ← `dist/dsh_qgis_driver-<plugin>.zip`（QGIS 插件 ZIP，同时要单独上传 plugins.qgis.org）
   最新那次 Release 不要勾 prerelease，否则 `releases/latest/download/…` 解析不到。
   上传按钮被锁时不是死路：Release 与附件都能用 API 建（`POST /repos/{owner}/{repo}/releases`，
   再 `POST https://uploads.github.com/repos/{owner}/{repo}/releases/{id}/assets?name=…`），
   或者干脆跳过——源码安装（`dsh plugin add github:SHI2008/dsh-qgis-driver`）不依赖 Release。
2. 给仓库加 `dsh-plugin` topic。
3. fork `awesome-dsh-plugin/awesome-dsh-plugin`，新增上面那个 YAML（一个 PR 最多 3 条，只加自己的）。
4. 提 PR。CI 检查 manifest、仓库年龄、格式与 README 能否重新生成；合并后站点与市场通常一天内生效。
   被要求修改时，往同一分支推修复并留一条说明即可。

## 两个交付件分开装，绝不互相包含

DSH 市场只发 **bundle**；QGIS 插件只走 QGIS 的「从 ZIP 安装插件」。两条通道互不打包对方：

| 产物 | 通道 | 内容 |
|---|---|---|
| `dsh-qgis-driver-<版本>.tgz` | DSH 市场 / 插件管理器 | 只有 `dsh-tools/`（`index.js`、`tools.js`、`client.js`、技能、`node_modules`） |
| `dsh_qgis_driver-<版本>.zip` | QGIS 插件安装器 | 只有 `qgis-plugin/`（`metadata.txt`、`live_driver.py`、`__init__.py`） |

所以根 `package.json` 的 `files` 里**不许出现 `qgis-plugin`**，市场条目里也不许出现 ZIP 链接或
`qgis-plugin` 路径——QGIS 插件不该经由 DSH 的安装器落到别人机器上。`scripts/pack.mjs` 的两个 `archive()`
调用（`['dsh_qgis_driver']` 与 `['package']`）就是这条边界的实现，改动打包逻辑时别把两个树合到一起。

## 打包

```
node scripts/bump.mjs <bundle 版本> [插件版本]
node scripts/pack.mjs                  # 两个都打
node scripts/pack.mjs --only=plugin    # 只改插件时用这个
node scripts/pack.mjs --only=bundle    # 只改 bundle 时用这个
```

打包会重写每个条目的时间戳，所以**内容没变、哈希也会变**。只改一侧时务必用 `--only=`，否则已经发布出去的
那个资产会因为你本地重打而得到新哈希，`SHA256SUMS.txt` 与 Release 上的附件就对不上了。

打包前会先过两道静态检查，有发现就**直接失败**，不会产出半成品：

- `python -m pyflakes` 扫插件全部 `.py`（QGIS 仓库上传时跑的就是它）；
- `node scripts/lint-js.mjs` 扫 bundle 的 `tools.js`/`index.js`/`client.js`：引用了却没声明的名字、
  写了两遍的对象键（后者静默生效）、声明了没人读的变量、`return` 之后的语句。解析用 `acorn`
  （`devDependencies`，`npm install` 装上；没装时打印一行提示并跳过）。单独跑：
  `node scripts/lint-js.mjs` 或 `node scripts/lint-js.mjs dsh-tools/tools.js`。

`dist/` 会得到 `dsh-qgis-driver-<版本>.tgz`（DSH bundle，npm 布局：根是 `package/`，`package.json` 里
`dsh.bundle.patch` 指向包内的 `cordis.patch.yml`，`schemastery` 随包）和 `dsh_qgis_driver-<版本>.zip`
（QGIS 里「从 ZIP 安装插件」）。

## 本地自测安装

插件管理器接受 tarball 路径（`install_bundle` 的 `target` 传绝对路径或 `https://… .tgz`）。注意本机
profile 现在用 `link: H:/shichencai/Code/dsh-qgis-driver/dsh-tools`（名字 `@local/dsh-qgis-driver`）装着
同一份代码，两者会抢同一个 `include:dsh-qgis-driver` 行——自测最好换一个临时 profile，或者先卸掉 link 版。
