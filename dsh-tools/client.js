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

      React.useEffect(() => {
        let alive = true
        async function poll() {
          let next = { dock: false, connected: false, target: null, host: null, error: '无法读取连接状态' }
          try {
            const r = await fetch('/api/dsh-qgis-driver/status')
            if (r.ok) next = await r.json()
            else next.error = '状态接口 HTTP ' + r.status
          } catch (e) {
            next.error = e && e.message ? e.message : String(e)
          }
          if (alive) setStatus(next)
        }
        poll()
        const timer = setInterval(poll, 4000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      // Not enabled in Settings → render nothing.
      if (!status || !status.dock) return null

      const connected = !!status.connected
      const dot = h('span', {
        style: {
          display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
          background: connected ? GREEN : RED, marginRight: 5, flexShrink: 0,
        },
      })
      const channel = status.channel === 'file' ? '文件通道' : (status.channel === 'http' ? 'REST' : '')
      const detail = connected
        ? (status.target === 'remote'
            ? '远程 ' + (status.host || '') + (channel ? ' · ' + channel : '')
            : '本地 ' + (status.host || '') + (channel ? ' · ' + channel : ''))
        : String(status.detail || status.error || '未检测到 QGIS，请启动 QGIS 或在设置中配置 host/port/Key')

      return h('div', {
        style: {
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          flex: '0 0 auto',
          minWidth: 0,
          alignSelf: 'center',
        },
      },
        h('button', {
          type: 'button',
          onClick: () => setOpen((v) => !v),
          title: 'QGIS 连接状态（可在设置中开关）',
          style: {
            display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
            background: 'transparent', border: 'none', padding: '0 2px',
            color: connected ? GREEN : RED, fontSize: 11, fontWeight: 600,
            lineHeight: '16px', cursor: 'pointer', userSelect: 'none',
            flex: '0 0 auto',
          },
        }, dot, connected ? 'QGIS 已连接' : 'QGIS 未连接'),
        open
          ? h('div', {
              style: {
                position: 'absolute', bottom: '100%', right: 0, zIndex: 5,
                marginBottom: 4, padding: '4px 8px', borderRadius: 6,
                background: SURFACE, border: '1px solid ' + BORDER,
                fontSize: 11, color: MUTED, lineHeight: '15px',
                maxWidth: 320, textAlign: 'right', whiteSpace: 'normal',
                boxShadow: '0 4px 12px rgba(0,0,0,0.45)',
              },
            }, detail)
          : null,
      )
    }

    function Field(label, input) {
      return h('div', { style: { marginBottom: 12 } },
        h('div', { style: { fontSize: 12, color: MUTED, marginBottom: 4 } }, label),
        input,
      )
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
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, cursor: 'pointer', userSelect: 'none' } },
          h('input', { type: 'checkbox', checked: !!form.dock, onChange: (e) => setForm((f) => ({ ...f, dock: e.target.checked })) }),
          h('span', { style: { fontSize: 13 } }, '显示连接状态挂件（消息输入框下方）')),
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
