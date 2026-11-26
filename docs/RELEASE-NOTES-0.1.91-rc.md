dsh-qgis-driver 0.1.91-rc — 用 DSH 驱动 QGIS

两个交付件：

- `dsh-qgis-driver-0.1.91-rc.tgz` —— DSH bundle（npm 布局，插件管理器可按 tarball 安装）
- `dsh_qgis_driver-0.18.13.zip` —— QGIS 插件（QGIS 里 插件 → 管理并安装插件 → 从 ZIP 安装）

## 这一版做了什么

十个 `qgis_*` 工具，覆盖图层、要素、符号、Processing、出图和会话状态；真正的执行发生在运行中的
QGIS GUI 主线程上，由 QGIS 插件 `dsh_qgis_driver` 承载。

- 结构写入可以撤销：`qgis_project action=undo` 回退上一次写操作加进来的图层、布局和布局元素，
  以及被改动的布局元素位置与地图范围；`not_undone` 明确写出它不碰要素、属性和样式。
- 布局地图可以给范围：`qgis_layout add_item kind=map` 接受 `extent`（或 `xmin/ymin/xmax/ymax`，可带 `crs`），
  回传最终 extent；空范围或项目没有 CRS 时给出可读的 `warning`，而不是一张白纸。
- `qgis_layer classify` 按字段类型建类别、按几何类型选符号，点图层不再被填色符号画成空白。
- `qgis_analysis run` 用算法自己的参数表校验参数名、必填项和枚举值，拼错的参数会列出真实参数名。
- 性能：事件驱动唤醒取代轮询（`status` 65 → 7.7 ms），写租约合进同一次请求（带租约的写入 194 → 6.7 ms）。

## 安装

```
# QGIS
插件 → 管理并安装插件 → 从 ZIP 安装 → 选择 dsh_qgis_driver-0.18.13.zip

# DSH
plugin_manager install_bundle target=<tarball 路径或 URL>
```

需要 QGIS 4.2（已在 4.2.3 上实测），DSH 0.2.x。许可证 GPL-3.0。
