// dsh-qgis-driver — DSH client UI.
// Registers a QGIS connection-status widget below the message composer.
// The widget is OFF by default (Config `dock`); enable it in Settings.
// It polls the Host's same-origin status endpoint `/api/dsh-qgis-driver/status`
// and renders a green/red dot + target + hint.
window.__ModuleLoader__.load({
  id: '@local/dsh-qgis-driver',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const GREEN = '#3fb950'
    const RED = '#f85149'

    function StatusWidget() {
      const [status, setStatus] = React.useState(null)

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
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
          background: connected ? GREEN : RED, marginRight: 6, flexShrink: 0,
        },
      })
      const label = connected ? 'QGIS 已连接' : 'QGIS 未连接'
      const target = status.target === 'remote'
        ? '远程 ' + (status.host || '')
        : (connected ? '本地 ' + (status.host || '') : '本地自动发现')
      const hint = connected
        ? target
        : (status.error && String(status.error).length ? String(status.error) : '未检测到 QGIS，请启动 QGIS 或在设置中配置 host/port/Key')

      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 8px',
          fontSize: 12, color: '#9a9aa6', padding: '2px 2px', userSelect: 'none',
          lineHeight: '18px',
        },
        title: 'QGIS 连接状态（可在设置中开关）',
      },
        dot,
        h('span', { style: { color: connected ? GREEN : RED, fontWeight: 600 } }, label),
        h('span', { style: { opacity: 0.85 } }, hint),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const off = ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'dsh-qgis-driver-dock', order: 5 },
            StatusWidget,
          ),
        )
        return () => { if (typeof off === 'function') off() }
      },
    }
  },
})
