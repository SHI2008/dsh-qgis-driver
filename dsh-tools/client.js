// dsh-qgis-driver — DSH client UI.
// (1) Registers a QGIS connection-status widget in the composer tool row (right of the model selector)
//     (OFF by default, Config `dock`; enabled in Settings).
// (2) Registers a dedicated Settings section (`settings.section`) with an
//     editable dock/headless form, persisted via the Host's same-origin
//     route `/api/dsh-qgis-driver/config` (GET read / POST write).
window.__ModuleLoader__.load({
  id: '@local/dsh-qgis-driver',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const GREEN = '#3fb950'
    const RED = '#f85149'
    const MUTED = '#9a9aa6'
    const TEXT = '#ececf1'
    const SURFACE = '#141417'
    const BORDER = '#2c2c34'
    // DSH brand blue (design token --dsw-static-deepseek-450, the
    // 'primary-new-color' in the dark theme). One accent, no lavender.
    const ACCENT = '#5686fe'
    const ACCENT_BG = '#5686fe'

    const btnStyle = {
      padding: '7px 16px', fontSize: 13, fontWeight: 600, borderRadius: 6,
      border: 'none', background: ACCENT_BG, color: '#ffffff', cursor: 'pointer',
    }

    // What the tools may do. Enforced by the bundle on every call (tools.js
    // `requiredScope`), shown here so the user can loosen or tighten it live.
    const SCOPE_META = [
      { id: 'read', label: '只读', color: GREEN,
        hint: '查询、渲染、看日志；不改项目、不写文件、不跑 Python。' },
      { id: 'write', label: '编辑', color: ACCENT,
        hint: '默认：改图层/布局/样式、导出、跑分析；不删除、不执行裸 PyQGIS。' },
      { id: 'danger', label: '完全', color: RED,
        hint: '还包括删除、打开/另存任意项目与裸 PyQGIS。只在你信任当前任务时使用。' },
    ]

    function StatusWidget() {
      const [status, setStatus] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        let timer = null
        async function poll() {
          let next = { dock: false, connected: false, target: null, host: null, error: '无法读取连接状态' }
          try {
            const r = await fetch('/api/dsh-qgis-driver/status')
            if (r.ok) next = await r.json()
            else next.error = '状态接口 HTTP ' + r.status
          } catch (e) {
            next.error = e && e.message ? e.message : String(e)
          }
          if (!alive) return
          setStatus(next)
          timer = setTimeout(poll, next.connected ? 4000 : 1500)
        }
        poll()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [])

      const wrapRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) return
        function onDown(ev) {
          const el = wrapRef.current
          if (el && ev.target instanceof Node && el.contains(ev.target)) return
          setOpen(false)
        }
        function onKey(ev) { if (ev.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      const connected = !!(status && status.connected)

      async function onBadge() {
        if (connected) { setOpen((v) => !v); return }
        setOpen(true)
        if (busy) return
        setBusy(true)
        try {
          await fetch('/api/dsh-qgis-driver/launch', { method: 'POST' })
        } catch (e) {
          /* the poller will report the failure */
        }
        setTimeout(() => setBusy(false), 2500)
      }

      // Not enabled in Settings → render nothing.
      // Hidden by default: shown when the user enables `dock` in Settings or
      // after the first QGIS tool call in this session.
      if (!status || (!status.dock && !status.reveal)) return null

      const dot = h('span', {
        style: {
          display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
          background: connected ? GREEN : RED, marginRight: 5, flexShrink: 0,
        },
      })

      const channel = status.channel === 'file' ? '文件通道' : (status.channel === 'http' ? 'REST' : '')
      const place = '本地 ' + (status.host || '')

      let head
      let bodyText
      if (connected) {
        head = '本地 QGIS 已连接'
        bodyText = [place, channel].filter(Boolean).join(' · ')
      } else if (busy) {
        head = '正在启动 QGIS…'
        bodyText = '首次启动需要十几秒，启动完成后此处会自动变为已连接。'
      } else {
        head = 'QGIS 未连接'
        bodyText = '点击此处启动 QGIS；直接调用任一 qgis_* 工具也会自动拉起。'
      }

      return h('div', {
        ref: wrapRef,
        style: {
          position: 'relative', display: 'inline-flex', alignItems: 'center',
          flex: '0 0 auto', minWidth: 0, alignSelf: 'center',
        },
      },
        h('button', {
          type: 'button',
          onClick: onBadge,
          title: connected ? '点击查看连接通道' : '点击启动 QGIS',
          style: {
            display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
            background: 'transparent', border: 'none', padding: '0 2px',
            color: connected ? GREEN : RED, fontSize: 11, fontWeight: 600,
            lineHeight: '16px', cursor: 'pointer', userSelect: 'none',
            flex: '0 0 auto',
          },
        }, dot, connected ? 'QGIS 已连接' : (busy ? 'QGIS 启动中…' : 'QGIS 未连接')),
        open
          ? h('div', {
              style: {
                position: 'absolute', bottom: '100%', right: 0, zIndex: 20,
                marginBottom: 6, width: 232, boxSizing: 'border-box',
                padding: '9px 11px', borderRadius: 8,
                background: '#16161b', border: '1px solid ' + BORDER,
                boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                textAlign: 'left', whiteSpace: 'normal', wordBreak: 'break-word',
                fontSize: 11.5, lineHeight: '17px',
              },
            },
              h('div', { style: { color: connected ? GREEN : RED, fontWeight: 600, marginBottom: 3 } }, head),
              h('div', { style: { color: MUTED } }, bodyText),
              connected && status.detail
                ? h('div', { style: { color: '#6f6f7a', marginTop: 4, fontSize: 10.5 } }, status.detail)
                : null,
            )
          : null,
      )
    }

    function Switch(props) {
      const on = !!props.checked
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        onClick: () => props.onChange(!on),
        style: {
          position: 'relative', flex: '0 0 auto', width: 36, height: 20,
          borderRadius: 999, border: '1px solid ' + (on ? ACCENT : BORDER),
          background: on ? ACCENT : '#222228', cursor: 'pointer', padding: 0,
          transition: 'background .15s ease, border-color .15s ease',
        },
      }, h('span', {
        style: {
          position: 'absolute', top: 1, left: on ? 17 : 1, width: 16, height: 16,
          borderRadius: '50%', background: on ? '#ffffff' : '#8b8b95',
          transition: 'left .15s ease, background .15s ease',
        },
      }))
    }

    function ScopePill() {
      const [scope, setScope] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState(null)
      const wrapRef = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        let timer = null
        async function load() {
          try {
            const r = await fetch('/api/dsh-qgis-driver/config')
            if (r.ok) {
              const c = await r.json()
              if (alive && typeof c.scope === 'string') setScope(c.scope)
            }
          } catch (e) { /* the connection badge reports failures */ }
          if (alive) timer = setTimeout(load, 6000)
        }
        load()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [])

      React.useEffect(() => {
        if (!open) return
        function onDown(ev) {
          const el = wrapRef.current
          if (el && ev.target instanceof Node && el.contains(ev.target)) return
          setOpen(false)
        }
        function onKey(ev) { if (ev.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      async function pick(id) {
        setOpen(false)
        if (id === scope) return
        setBusy(true); setErr(null)
        try {
          const r = await fetch('/api/dsh-qgis-driver/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scope: id }),
          })
          const b = await r.json().catch(() => ({}))
          if (r.ok && b.ok !== false) setScope(id)
          else setErr(b && b.error ? b.error : ('HTTP ' + r.status))
        } catch (e) {
          setErr(e && e.message ? e.message : String(e))
        } finally {
          setTimeout(() => setBusy(false), 800)
        }
      }

      if (!scope) return null
      const meta = SCOPE_META.find((s) => s.id === scope) || SCOPE_META[1]

      return h('div', {
        ref: wrapRef,
        style: {
          position: 'relative', display: 'inline-flex', alignItems: 'center',
          flex: '0 0 auto', minWidth: 0, alignSelf: 'center', marginRight: 8,
        },
      },
        h('button', {
          type: 'button',
          onClick: () => setOpen((v) => !v),
          title: '工具权限：' + meta.label + ' — ' + meta.hint,
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
            background: 'transparent', border: '1px solid ' + BORDER, borderRadius: 999,
            padding: '0 6px', color: meta.color, fontSize: 11, fontWeight: 600,
            lineHeight: '16px', cursor: 'pointer', userSelect: 'none', flex: '0 0 auto',
            opacity: busy ? 0.6 : 1,
          },
        }, '权限' + (busy ? '…' : meta.label)),
        open
          ? h('div', {
              style: {
                position: 'absolute', bottom: '100%', right: 0, zIndex: 21,
                marginBottom: 6, width: 264, boxSizing: 'border-box',
                padding: '8px', borderRadius: 8,
                background: '#16161b', border: '1px solid ' + BORDER,
                boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                textAlign: 'left', whiteSpace: 'normal', fontSize: 11.5, lineHeight: '17px',
              },
            },
              SCOPE_META.map((s) => h('button', {
                key: s.id,
                type: 'button',
                onClick: () => pick(s.id),
                style: {
                  display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                  background: s.id === scope ? '#1d1d24' : 'transparent',
                  border: 'none', borderRadius: 6, padding: '6px 8px', marginBottom: 2,
                  color: TEXT, font: 'inherit',
                },
              },
                h('span', { style: { color: s.color, fontWeight: 700, marginRight: 6 } }, s.label),
                h('span', { style: { color: MUTED } }, s.hint))),
              h('div', { style: { color: '#6f6f7a', marginTop: 4, fontSize: 10.5 } },
                '立刻生效：下一次工具调用就按新范围执行，不需要重载。'),
              err ? h('div', { style: { color: RED, marginTop: 4, fontSize: 10.5 } }, err) : null,
            )
          : null,
      )
    }

    function SettingsPanel(props) {
      const [form, setForm] = React.useState({ dock: false, headless: true, scope: 'write' })
      const [loaded, setLoaded] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [err, setErr] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const r = await fetch('/api/dsh-qgis-driver/config')
            if (!r.ok) { if (alive) setErr('读取配置失败：HTTP ' + r.status); return }
            const c = await r.json()
            if (alive) {
              setForm({
                dock: !!c?.dock,
                headless: c?.headless !== false,
                scope: typeof c?.scope === 'string' ? c.scope : 'write',
              })
              setLoaded(true)
            }
          } catch (e) {
            if (alive) setErr(e && e.message ? e.message : String(e))
          }
        })()
        return () => { alive = false }
      }, [])


      // Every control writes immediately: a settings page that needs a Save
      // button makes people think the toggle did nothing.
      async function push(patch) {
        const next = { dock: !!form.dock, headless: !!form.headless, scope: form.scope, ...patch }
        setForm(next)
        setSaving(true); setMsg(null); setErr(null)
        try {
          const r = await fetch('/api/dsh-qgis-driver/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(next),
          })
          const b = await r.json().catch(() => ({}))
          if (r.ok && b.ok !== false) setMsg('已生效')
          else {
            setErr('保存失败：' + (b && b.error ? b.error : ('HTTP ' + r.status)))
          }
        } catch (e) {
          setErr(e && e.message ? e.message : String(e))
        } finally {
          setSaving(false)
        }
      }

      return h('div', { style: { maxWidth: 520, padding: '8px 0', color: TEXT, fontSize: 13, lineHeight: 1.5 } },
        h('div', { style: { fontSize: 12, color: MUTED, marginBottom: 14 } },
          '连接本机正在运行的 QGIS：通过插件写下的注册表自动发现，不需要填地址或密钥。'),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 18 } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
            h('span', { style: { fontSize: 13 } }, '显示连接状态挂件'),
            h('span', { style: { fontSize: 11, color: MUTED, lineHeight: 1.4 } },
              '在消息输入框右侧显示 QGIS 连接状态徽标，点击可启动 QGIS 或查看通道（默认关闭）。')),
          Switch({ checked: !!form.dock, onChange: (v) => push({ dock: v }) })),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 18 } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
            h('span', { style: { fontSize: 13 } }, '自动启动使用无头模式'),
            h('span', { style: { fontSize: 11, color: MUTED, lineHeight: 1.4 } },
              '自动拉起 QGIS 时不显示窗口；只有需要地图画布的工具（平移/缩放/截图）才启动 GUI。关闭则总是启动 GUI。')),
          Switch({ checked: !!form.headless, onChange: (v) => push({ headless: v }) })),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 } },
          h('span', { style: { fontSize: 13 } }, '工具权限范围'),
          h('span', { style: { fontSize: 11, color: MUTED, lineHeight: 1.4 } },
            '和输入框右侧的权限按钮是同一个设置：改完立刻生效，下一次工具调用就按新范围执行，不需要重载。'),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
            SCOPE_META.map((s) => h('button', {
              key: s.id,
              type: 'button',
              onClick: () => push({ scope: s.id }),
              style: {
                flex: '1 1 0', padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
                fontSize: 12, fontWeight: 600,
                border: '1px solid ' + (form.scope === s.id ? s.color : BORDER),
                background: form.scope === s.id ? '#1d1d24' : 'transparent',
                color: form.scope === s.id ? s.color : MUTED,
              },
            }, s.label)),
          ),
          h('span', { style: { fontSize: 10.5, color: '#6f6f7a', lineHeight: 1.45 } },
            '只读：不写项目、不写文件、不跑 Python。编辑：改图层/布局/样式、导出、跑分析。完全：还能删除、打开或另存任意项目、执行裸 PyQGIS。')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 18 } },
          saving ? h('span', { style: { fontSize: 12, color: MUTED } }, '应用中…') : null,
          msg ? h('span', { style: { fontSize: 12, color: GREEN } }, msg) : null,
          err ? h('span', { style: { fontSize: 12, color: RED } }, err) : null),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposers = []
        const offDock = ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'dsh-qgis-driver-dock', order: 90 },
            StatusWidget,
          ),
        )
        if (typeof offDock === 'function') disposers.push(offDock)

        const offScope = ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'dsh-qgis-driver-scope', order: 89 },
            ScopePill,
          ),
        )
        if (typeof offScope === 'function') disposers.push(offScope)

        const offSettings = ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-qgis-driver', order: 60, label: () => 'dsh-qgis-driver' },
            SettingsPanel,
          ),
        )
        if (typeof offSettings === 'function') disposers.push(offSettings)

        return () => { for (const d of disposers) d() }
      },
    }
  },
})
