# 发布到 DSH 插件市场

市场（`dshmarket`）打开时实时读取 `https://awesome-dsh-plugin.com/plugins.json`，那份数据来自
[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 仓库的
`data/plugins/*.yml`，**一个插件一个文件**。所以「上架」= 给那个仓库提一个 PR，加一个 YAML 文件；两个 README
由脚本生成，不能手改（规则原文见 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)）。

## 本仓库的形态

`dsh-tools/` 是一个 monorepo 子包，`dsh-tools/package.json` 声明了 `dsh.bundle.patch` 和 `dsh.client`。
条目因此要按 **monorepo 子包** 的形式写：`url` 指向子目录，`name` 用 `owner/repo#subname`，文件名用
`owner__repo--<子目录用短横连接>.yml`。

```yaml
# data/plugins/SHI2008__dsh-qgis-driver--dsh-tools.yml
url: https://github.com/SHI2008/dsh-qgis-driver/tree/main/dsh-tools
name: SHI2008/dsh-qgis-driver#dsh-qgis-driver
category: tools
description:
  en: 'Drive QGIS 4 from DSH: ten qgis_* tools for layers, symbology, print layouts and Processing, backed by a QGIS plugin that runs them on the live GUI thread.'
  zh: '从 DSH 驱动 QGIS 4：十个 qgis_* 工具覆盖图层、符号、出图和 Processing，由 QGIS 插件在 GUI 主线程上执行。'
tarball: https://github.com/SHI2008/dsh-qgis-driver/releases/latest/download/dsh-qgis-driver-<版本>.tgz
```

- `category` 取 `tools`（工作流/自动化也可用 `workflow`）。
- `description.en` 必填，只讲功能、不带营销词；描述里提到的任何命令和 API 都会被对照代码检查。
- `tarball:` 是可选的预构建包地址。不发 npm 时必须用它——市场会优先展示这个包而不是源码构建命令。
  指向 GitHub Release 的资产；本仓库的 `scripts/pack.mjs` 产出的
  `dist/dsh-qgis-driver-<版本>.tgz` 就是可以直接挂上去的文件（npm 布局，根是 `package/`）。
- 如果以后把子包发布到 npm，把 `tarball:` 去掉、让市场用 `npm install` 即可，预构建安装还能跳过 `allowBuilds`。

## 收录前的硬性条件

1. 仓库 public，且创建满 1 天（CI 自动检查）。
2. 仓库带 `dsh-plugin` topic。
3. `package.json` 声明 `dsh.bundle.patch`，且那个 patch 文件真的在默认分支上（本仓库满足：`dsh-tools/cordis.patch.yml`）。
4. 有真实可用的代码，不是占位。
5. 描述与代码一致——数字、命令名、API 名都会被核对。

## 步骤

1. 仓库推到 `https://github.com/SHI2008/dsh-qgis-driver`（`main` + tags）。
2. 打 tag 并建 Release，把 `dist/dsh-qgis-driver-<版本>.tgz` 和 `dist/dsh_qgis_driver-<版本>.zip` 作为资产上传。
3. fork `awesome-dsh-plugin/awesome-dsh-plugin`，在 `data/plugins/` 下新增上面那个文件（一个 PR 最多 3 条，只加自己的）。
4. 提 PR。CI 会检查 manifest、仓库年龄、格式和 README 能否重新生成；合并后站点与市场通常一天内生效。

## 打包

```
node scripts/bump.mjs <bundle 版本> [插件版本]
node scripts/pack.mjs
```

`dist/` 会得到两个交付件：`dsh-qgis-driver-<版本>.tgz`（DSH bundle，npm 布局，可被插件管理器按
tarball 安装）和 `dsh_qgis_driver-<版本>.zip`（QGIS 里「从 ZIP 安装插件」）。

## 本地自测安装

插件管理器接受 tarball 路径（`install_bundle` 的 `target` 传绝对路径或 `https://… .tgz`），
包内 `package.json` 的 `dsh.bundle.patch` 必须指向真实存在的文件。注意本机 profile 现在用
`link: H:/shichencai/Code/dsh-qgis-driver/dsh-tools`（名字 `@local/dsh-qgis-driver`）装着同一份代码，
两者会抢同一个 `include:dsh-qgis-driver` 行——自测最好换一个临时 profile，或者先用
`plugin_manager` 卸掉 link 版再装 tarball。
