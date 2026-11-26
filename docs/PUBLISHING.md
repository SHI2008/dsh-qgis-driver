# 发布到 DSH 插件市场

市场（`dshmarket`）打开时实时读取 `https://awesome-dsh-plugin.com/plugins.json`，那份数据来自
[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 仓库的
`data/plugins/*.yml`，**一个插件一个文件**。所以「上架」= 给那个仓库提一个 PR，加一个 YAML 文件；两个 README
由脚本生成，不能手改。规则原文：[contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。

## 要提交的文件

内容就是 [marketplace-entry.yml](marketplace-entry.yml)（那份文件里不放注释），提交到：

```
data/plugins/SHI2008__dsh-qgis-driver--dsh-tools.yml
```

字段说明：

- `url` / `name`：本仓库是 monorepo，bundle 在 `dsh-tools/`，所以 `url` 指到子目录、`name` 用 `owner/repo#subname`，
  文件名对应 `owner__repo--<子目录短横连接>.yml`。
- `category: tools`：按插件实际做的事选；选偏了维护者会直接改，不会打回。
- `description.en` 必填，单行、以句号结尾、只说功能；含 `: `（冒号加空格）必须加引号。描述里提到的命令、
  API、数量都会被对照代码核对。
- `tarball:`：不发 npm 时必填，必须是 **GitHub Release 托管**的 `https` `.tgz`。**要钉住 tag**，不要用
  `releases/latest/download/`——那条链接只在请求时解析 `latest`，文件名却是照字面取的，资产名带版本号时，
  下一次发版就会 404。

## 收录前的硬性条件

1. 仓库 public，创建满 1 天（CI 自动检查，仓库 2026-11 创建，已满足）。
2. 仓库带 `dsh-plugin` topic。
3. 包声明 `dsh.bundle.patch`，且 patch 文件在默认分支上（本仓库：`dsh-tools/package.json` +
   `dsh-tools/cordis.patch.yml`）。
4. 有真实可用的代码，不是占位。
5. 描述与代码一致。

⚠️ CI 第 2 步是「从仓库的 `package.json` 读 `dsh.bundle`」，它明说的查找范围是**根包，或
`packages/` · `plugins/` · `apps/` 子包**——本仓库的 `dsh-tools/` 不在这个名单里。如果 gate 报找不到
`dsh.bundle`，最直接的修法是把 `dsh-tools/` 移到 `packages/dsh-tools/`（或加一个根 `package.json` 做薄
清单）；两者都会动到 profile 里的 `link:` 路径，所以要单独做一次、跟着改 `scripts/*.mjs` 与文档。

## 步骤

1. 打 tag、建 GitHub Release，把 `dist/` 里的两个交付件作为资产上传：
   - `dsh-qgis-driver-0.1.91-rc.tgz`（DSH bundle）
   - `dsh_qgis_driver-0.18.13.zip`（QGIS 插件 ZIP）
2. 给仓库加 `dsh-plugin` topic。
3. fork `awesome-dsh-plugin/awesome-dsh-plugin`，新增上面那个 YAML（一个 PR 最多 3 条，只加自己的）。
4. 提 PR。CI 检查 manifest、仓库年龄、格式与 README 能否重新生成；合并后站点与市场通常一天内生效。
   被要求修改时，往同一分支推修复并留一条说明即可。

## 打包

```
node scripts/bump.mjs <bundle 版本> [插件版本]
node scripts/pack.mjs
```

`dist/` 会得到 `dsh-qgis-driver-<版本>.tgz`（DSH bundle，npm 布局：根是 `package/`，`package.json` 里
`dsh.bundle.patch` 指向包内的 `cordis.patch.yml`，`schemastery` 随包）和 `dsh_qgis_driver-<版本>.zip`
（QGIS 里「从 ZIP 安装插件」）。

## 本地自测安装

插件管理器接受 tarball 路径（`install_bundle` 的 `target` 传绝对路径或 `https://… .tgz`）。注意本机
profile 现在用 `link: H:/shichencai/Code/dsh-qgis-driver/dsh-tools`（名字 `@local/dsh-qgis-driver`）装着
同一份代码，两者会抢同一个 `include:dsh-qgis-driver` 行——自测最好换一个临时 profile，或者先卸掉 link 版。
