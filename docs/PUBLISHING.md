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
- `tarball:` 可选。**本仓库先不填**：它必须是 GitHub Release 托管的 `https` `.tgz`，而当前账号的 Release
  资产上传被关掉了；从源码安装已经可用（根 `package.json` 声明了 `dsh.bundle`，`schemastery` 随仓库提交）。
  等能传资产时再补，并且**要钉住 tag**——`releases/latest/download/` 那条链接只在请求时解析 `latest`，文件名却是
  照字面取的，资产名带版本号时下一次发版就 404。

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

1. 打 tag、建 GitHub Release。资产上传被关掉时先跳过这一步——源码安装不依赖 Release：
   `dsh plugin add github:SHI2008/dsh-qgis-driver`。
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
