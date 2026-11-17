// dsh-qgis-driver — DSH client UI.
// (1) Registers a QGIS connection-status widget in the composer tool row (right of the model selector)
//     (OFF by default, Config `dock`; enabled in Settings).
// (2) Registers a dedicated Settings section (`settings.section`) with an
//     editable host/port/key/dock form, persisted via the Host's same-origin
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
    const ACCENT = '#8f9dff'
    const ACCENT_BG = '#8f9dff'

    const inputStyle = {
      width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 13,
      background: SURFACE, color: TEXT, border: '1px solid ' + BORDER,
      borderRadius: 6, outline: 'none',
    }
    const btnStyle = {
      padding: '7px 16px', fontSize: 13, fontWeight: 600, borderRadius: 6,
      border: 'none', background: ACCENT_BG, color: '#08080a', cursor: 'pointer',
    }

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
      if (!status || !status.dock) return null

      const dot = h('span', {
        style: {
          display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
          background: connected ? GREEN : RED, marginRight: 5, flexShrink: 0,
        },
      })

      const channel = status.channel === 'file' ? '文件通道' : (status.channel === 'http' ? 'REST' : '')
      const place = status.target === 'remote'
        ? '远程 ' + (status.host || '')
        : '本地 ' + (status.host || '')

      let head
      let bodyText
      if (connected) {
        head = status.target === 'remote' ? '远程 QGIS 已连接' : '本地 QGIS 已连接'
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

    function Field(label, input) {
      return h('div', { style: { marginBottom: 12 } },
        h('div', { style: { fontSize: 12, color: MUTED, marginBottom: 4 } }, label),
        input,
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

    function SettingsPanel(props) {
      const [form, setForm] = React.useState({ host: '', port: 0, key: '', dock: false })
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
                host: (c && typeof c.host === 'string') ? c.host : '',
                port: (c && Number.isInteger(c.port)) ? c.port : 0,
                key: (c && typeof c.key === 'string') ? c.key : '',
                dock: !!c?.dock,
              })
              setLoaded(true)
            }
          } catch (e) {
            if (alive) setErr(e && e.message ? e.message : String(e))
          }
        })()
        return () => { alive = false }
      }, [])

      const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

      async function save() {
        setSaving(true); setMsg(null); setErr(null)
        try {
          const r = await fetch('/api/dsh-qgis-driver/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              host: form.host,
              port: Number(form.port) || 0,
              key: form.key,
              dock: !!form.dock,
            }),
          })
          const b = await r.json().catch(() => ({}))
          if (r.ok && b.ok !== false) setMsg('已保存。QGIS 连接参数将在下次工具调用时生效。')
          else setErr('保存失败：' + (b && b.error ? b.error : ('HTTP ' + r.status)))
        } catch (e) {
          setErr(e && e.message ? e.message : String(e))
        } finally {
          setSaving(false)
        }
      }

      return h('div', { style: { maxWidth: 520, padding: '8px 0', color: TEXT, fontSize: 13, lineHeight: 1.5 } },
        h('div', { style: { fontSize: 12, color: MUTED, marginBottom: 14 } },
          'QGIS 连接参数。host 留空 = 使用本地自动发现（本机 QGIS）；填入 host:port + Key = 连接远程 QGIS。'),
        Field('Host（主机地址，如 192.168.1.10）',
          h('input', { value: form.host, onChange: set('host'), placeholder: '127.0.0.1', style: inputStyle })),
        Field('Port（端口，0 = 自动）',
          h('input', { type: 'number', min: 0, max: 65535, value: form.port, onChange: set('port'), style: inputStyle })),
        Field('Key（API 密钥，对应 QGIS 端 QGIS_LIVE_API_KEY）',
          h('input', { type: 'password', value: form.key, onChange: set('key'), placeholder: '（可选）', style: inputStyle })),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 18 } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
            h('span', { style: { fontSize: 13 } }, '显示连接状态挂件'),
            h('span', { style: { fontSize: 11, color: MUTED, lineHeight: 1.4 } },
              '在消息输入框右侧显示 QGIS 连接状态徽标，点击可启动 QGIS 或查看通道（默认关闭）。')),
          Switch({ checked: !!form.dock, onChange: (v) => setForm((f) => ({ ...f, dock: v })) })),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('button', { onClick: save, disabled: saving, style: { ...btnStyle, opacity: saving ? 0.6 : 1 } },
            saving ? '保存中…' : '保存'),
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
