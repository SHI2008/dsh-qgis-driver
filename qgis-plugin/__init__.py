import json
import os
import tempfile
import time
import traceback

try:
    from qgis.PyQt.QtCore import QCoreApplication
except ImportError:
    # Becomes None when imported outside QGIS (unit tests, etc.).
    # GUI code paths only run inside QGIS, so this is fine.
    QCoreApplication = None

from .i18n_json import install_translator


def _log(msg):
    log = os.environ.get(
        "WEBENGINE_LOG_PATH",
        os.path.join(tempfile.gettempdir(), "plugin_load.log"),
    )
    try:
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, "a", encoding="utf-8") as f:
            f.write(str(msg) + "\n")
    except Exception:  # nosec B110  # acceptable by design
        pass


def _http_allowed():
    """Return the exposed command kinds from QGIS_LIVE_TOOLS (None = allow all)."""
    raw = os.environ.get("QGIS_LIVE_TOOLS", "").strip()
    if raw and raw != "*":
        return {t.strip().lower().removeprefix("qgis_")
                for t in raw.split(",") if t.strip()}
    return None


def _registry_dir():
    # The spawned side has no env vars, so write the
    # discovery info to a fixed path ~/.qgis-live/
    return os.environ.get(
        "QGIS_LIVE_REGISTRY",
        os.path.join(os.path.expanduser("~"), ".qgis-live"),
    )


def _restrict_file(path):
    """Restrict a file containing a token etc. to the current user (best-effort)."""
    try:
        if os.name == "nt":
            import shutil
            import subprocess  # nosec B404  # needed to run icacls
            user = os.environ.get("USERNAME") or ""
            exe = shutil.which("icacls") or os.path.join(
                os.environ.get("SystemRoot", r"C:\Windows"),
                "System32", "icacls.exe")
            if user:
                subprocess.run(  # nosec B603  # fixed args + USERNAME only
                    [exe, path, "/inheritance:r",
                     "/grant:r", f"{user}:F"],
                    capture_output=True, timeout=10)
        else:
            os.chmod(path, 0o600)
    except Exception:  # nosec B110  # acceptable by design
        pass


class GeoDriverPlugin:
    """Control-only plugin with no UI.

    Enabled by two paths (both require a token):
      - WEBENGINE_LIVE_DIR env set → enabled immediately at startup (development)
      - Menu toggle → stored in QSettings, auto-enabled from the next startup

    Exposed surfaces:
      - File JSONL (commands.jsonl/results.jsonl) — language-neutral base
      - HTTP (default 127.0.0.1:<auto port>; set QGIS_LIVE_HOST=0.0.0.0 and
        QGIS_LIVE_PORT=<port> for cross-machine access) (/api/* = REST)
      - ~/.qgis-live/<pid>-dsh_qgis_driver.json — connection info + token (discovery)

    Auth: every endpoint except /api/health requires a token (Bearer/X-Api-Key/
    api-key). The per-session token is in the registry; QGIS_LIVE_API_KEY is a
    stable extra key for remote clients (use it as the "Key" with host:port).
    """

    SETTING_ENABLED = "dsh_qgis_driver/enabled"
    SETTING_AI_PANEL = "dsh_qgis_driver/ai_panel_open"
    _MENU_NAME = "dsh-qgis-driver"
    # Menu action source strings (English); they are translated for display
    _ACTION_SOURCES = ("Remote Control",
                       "AI Assistant",
                       "Connection Info",
                       "Hot Reload",
                       "Hot Reload (auto-apply on save)",
                       "Deploy Mode")

    def _own_action_texts(self):
        """For removing leftover actions: include both English sources and translations."""
        texts = set(self._ACTION_SOURCES)
        for src in self._ACTION_SOURCES:
            texts.add(QCoreApplication.translate("dsh_qgis_driver", src))
        return texts

    def __init__(self, iface):
        self.iface = iface
        self.driver = None
        self._http = None
        self._reg_path = None
        self._action = None
        self._ai_action = None
        self._ai_panel = None
        self._ai_driver = None
        self._hot_menu = None
        self._mode_action = None
        self._conn_action = None
        self._conn_dlg = None
        self._geo_tb = None
        self._mode_badge = None
        self._mode_badge_action = None
        self._mode_badge_sep = None
        self._ai_tb_button = None
        self._ai_tb_action = None
        self._mode_timer = None
        self._init_language()
        try:
            from .bridge import GeoDriverBridge
            self.bridge = GeoDriverBridge(self)
        except Exception:  # nosec B110  # acceptable by design
            pass
        # Cross-plugin layer organization service. geo_import etc. can place
        # added layers into the profile rules via
        # plugins['dsh_qgis_driver'].layer_org.place_all([(layer, ctx)]) (flat if none)
        try:
            from .layer_org import LayerOrganizer
            self.layer_org = LayerOrganizer()
        except Exception:
            self.layer_org = None
        # Scale-linked standard line-width service
        try:
            from .scale_style import ScaleStyler
            self.scale_style = ScaleStyler()
        except Exception:
            self.scale_style = None

    def _init_language(self):
        """Load i18n/<lang>.json matching the QGIS language setting.
        Source strings are English; en or unsupported languages load no translation."""
        try:
            self.translator = install_translator(
                os.path.dirname(os.path.abspath(__file__)))
        except Exception:
            self.translator = None

    def _own_menu(self):
        """Return the Plugins > dsh-qgis-driver submenu (None if absent)."""
        try:
            for top in self.iface.mainWindow().menuBar().actions():
                tm = top.menu()
                if tm is None:
                    continue
                for a in tm.actions():
                    sm = a.menu()
                    if sm is not None and sm.title() == self._MENU_NAME:
                        return sm
        except Exception:  # nosec B110  # acceptable by design
            pass
        return None

    def _sweep_menu_actions(self):
        """Remove leftover actions with identical text from the menu.

        Cleans up same-named QActions left behind by previous or other plugin
        generations. Runs deferred via _menu_cleanup to stay out of menu event
        handling; actions added by this generation while waiting are skipped by
        identity comparison.
        """
        menu = self._own_menu()
        if menu is None:
            return
        own = [x for x in (self._ai_action, self._action,
                           self._conn_action, self._mode_action)
               if x is not None]
        if self._hot_menu is not None:
            try:
                own.append(self._hot_menu.menuAction())
            except Exception:  # nosec B110  # acceptable by design
                pass
        for a in list(menu.actions()):
            if any(a is x for x in own):
                continue
            if a.text() in self._own_action_texts():
                try:
                    menu.removeAction(a)
                    a.deleteLater()
                except Exception:  # nosec B110  # acceptable by design
                    pass

    def _defer_menu_cleanup(self, items):
        """Defer menu removal from unload() until the event loop has finished.

        Calling removePluginMenu while a QMenu is processing an event (e.g. the
        reloadPlugin path inside a triggered handler) has destroyed the popup
        menu hierarchy and caused access violations.
        """
        try:
            from qgis.PyQt.QtCore import QTimer
            QTimer.singleShot(0, lambda: self._menu_cleanup(items))
        except Exception:  # nosec B110  # acceptable by design
            self._menu_cleanup(items)

    def _menu_cleanup(self, items):
        """Deferred plugin menu removal.

        To avoid deleting actions added by a new generation in initGui while the
        removal is pending, only references captured at unload time are removed,
        and the trailing sweep also excludes this instance's own actions.
        """
        for a in items.get("actions") or ():
            try:
                self.iface.removePluginMenu("dsh-qgis-driver", a)
            except Exception:  # nosec B110  # acceptable by design
                pass
            try:
                a.deleteLater()
            except Exception:  # nosec B110  # acceptable by design
                pass
        m = items.get("hot_menu")
        if m is not None:
            try:
                self.iface.removePluginMenu(
                    "dsh-qgis-driver", m.menuAction())
            except Exception:  # nosec B110  # acceptable by design
                pass
            try:
                m.deleteLater()
            except Exception:  # nosec B110  # acceptable by design
                pass
        try:
            self._sweep_menu_actions()  # also clean leftovers not owned by us
        except Exception:  # nosec B110  # acceptable by design
            pass

    def initGui(self):
        from qgis.PyQt.QtWidgets import QAction
        # Menu operations are deferred until the event loop finishes. Running
        # initGui while a menu is handling an event (via reloadPlugin) can make
        # menu hierarchy changes cause an access violation (observed in practice).
        # The deferred sweep is safe because it excludes this instance's actions.
        self._defer_menu_cleanup({})
        self._ai_action = QAction(
            QCoreApplication.translate("dsh_qgis_driver", "AI Assistant"),
            self.iface.mainWindow())
        self._ai_action.triggered.connect(self._open_ai_panel)
        self.iface.addPluginToMenu("dsh-qgis-driver", self._ai_action)

        self._action = QAction(
            QCoreApplication.translate(
                "dsh_qgis_driver", "Remote Control"),
            self.iface.mainWindow())
        self._action.setCheckable(True)
        self._action.toggled.connect(self._on_toggle)
        self.iface.addPluginToMenu("dsh-qgis-driver", self._action)

        self._conn_action = QAction(
            QCoreApplication.translate(
                "dsh_qgis_driver", "Connection Info"),
            self.iface.mainWindow())
        self._conn_action.triggered.connect(self._open_conn_info)
        self.iface.addPluginToMenu("dsh-qgis-driver", self._conn_action)

        self._settings_action = QAction(
            QCoreApplication.translate("dsh_qgis_driver", "Settings"),
            self.iface.mainWindow())
        self._settings_action.triggered.connect(self._open_settings)
        self.iface.addPluginToMenu("dsh-qgis-driver", self._settings_action)

        self._hot_menu = self._build_hot_menu()
        self.iface.addPluginToMenu("dsh-qgis-driver",
                                   self._hot_menu.menuAction())

        # The Deploy Mode dialog is also the supported way to point at the
        # harness repo, so always show it, even for a standalone install where
        # the repo is unresolved
        self._mode_action = QAction(
            QCoreApplication.translate("dsh_qgis_driver", "Deploy Mode"),
            self.iface.mainWindow())
        self._mode_action.triggered.connect(self._open_mode_dialog)
        self.iface.addPluginToMenu("dsh-qgis-driver", self._mode_action)
        self._init_geo_toolbar()

        live_base = os.environ.get("WEBENGINE_LIVE_DIR")
        _log(f"dsh_qgis_driver initGui: live_base={live_base!r}")
        if live_base:
            self._start(live_base)  # dev path: env wins, start immediately
        elif self._settings_enabled():
            self._start(self._default_live_base())
        self._sync_action()
        # Reopen the AI panel that was open before a reload/restart
        if self._settings_enabled(self.SETTING_AI_PANEL):
            self._open_ai_panel()

    # ---- Hot reload ----

    def _build_hot_menu(self):
        from qgis.PyQt.QtWidgets import QMenu
        menu = QMenu(
            QCoreApplication.translate("dsh_qgis_driver", "Hot Reload"),
            self.iface.mainWindow())
        menu.aboutToShow.connect(self._rebuild_hot_menu)
        return menu

    def _rebuild_hot_menu(self):
        """Rebuild the list of development plugins each time the menu opens."""
        if self._hot_menu is None:
            return
        self._hot_menu.clear()
        ids = self._dev_plugin_ids()
        for pid in ids:
            act = self._hot_menu.addAction(pid)
            act.triggered.connect(
                lambda _checked=False, p=pid: self._defer_hot_reload([p]))
        if ids:
            self._hot_menu.addSeparator()
            act = self._hot_menu.addAction(
                QCoreApplication.translate(
                    "dsh_qgis_driver", "Reload All"))
            act.triggered.connect(
                lambda _checked=False: self._defer_hot_reload(ids))
        else:
            act = self._hot_menu.addAction(
                QCoreApplication.translate(
                    "dsh_qgis_driver",
                    "(no development plugins)"))
            act.setEnabled(False)

    def _dev_plugin_ids(self):
        try:
            from .hot_reload import dev_plugin_ids
            return dev_plugin_ids(__file__)
        except Exception:
            _log("hot reload id discovery failed:\n"
                 + traceback.format_exc())
            return []

    def _defer_hot_reload(self, ids):
        """Run hot reload after the menu event has finished.

        Calling reloadPlugin directly inside a triggered handler makes unload()
        rewrite the popup menu hierarchy via removePluginMenu while Qt is still
        processing it, causing an access violation (observed when reloading
        dsh_qgis_driver itself through hot reload). Defer until the event completes.
        """
        try:
            from qgis.PyQt.QtCore import QTimer
            QTimer.singleShot(0, lambda: self._hot_reload(ids))
        except Exception:
            self._hot_reload(ids)

    def _hot_reload(self, ids):
        try:
            from .hot_reload import reload_plugins
            reload_plugins(ids, notify=self._hot_notify)
        except Exception:
            _log("hot reload failed:\n" + traceback.format_exc())

    def _hot_notify(self, level, msg):
        try:
            from qgis.core import Qgis
            lv = (Qgis.MessageLevel.Warning if level == "warn"
                  else Qgis.MessageLevel.Info)
            self.iface.messageBar().pushMessage(
                "dsh-qgis-driver", msg, level=lv, duration=4)
        except Exception:  # nosec B110  # acceptable by design
            pass
        _log(f"hot_reload {level}: {msg}")

    # ---- Connection info ----

    def _open_conn_info(self):
        """Open the connection info dialog (if already open, reopen it fresh)."""
        try:
            if self._conn_dlg is not None:
                try:
                    self._conn_dlg.close()
                    self._conn_dlg.deleteLater()
                except Exception:  # nosec B110  # acceptable by design
                    pass
            from .connection_info import show_dialog
            self._conn_dlg = show_dialog(self)
        except Exception:
            _log("connection info dialog failed:\n"
                 + traceback.format_exc())

    def _open_settings(self):
        """Open the connection settings dialog (host / port / API key)."""
        try:
            from .settings_dialog import SettingsDialog
            dlg = SettingsDialog(self.iface.mainWindow())
            self._settings_dlg = dlg  # keep a reference against GC
            dlg.exec()
        except Exception:
            _log("settings dialog failed:\n"
                 + traceback.format_exc())

    # ---- Deploy mode switch ----

    def _open_mode_dialog(self):
        try:
            from .mode_switch import show_dialog
            show_dialog(self.iface, __file__, notify=self._hot_notify)
        except Exception:
            _log("deploy mode dialog failed:\n" + traceback.format_exc())
        self._refresh_mode_badge()

    # ---- GeoSuite shared toolbar ----

    def _init_geo_toolbar(self):
        """Find-or-create the GeoSuite toolbar and put a mode badge first.

        The badge always shows "development mode / use mode"; clicking it opens
        the Deploy Mode dialog. Other plugins add their own toolbar entries to
        the same-named toolbar themselves.
        """
        try:
            from qgis.PyQt.QtCore import QTimer
            from qgis.PyQt.QtGui import QIcon
            from qgis.PyQt.QtWidgets import QToolButton
            from .geo_toolbar import geo_suite_toolbar
            self._geo_tb = geo_suite_toolbar(self.iface)
            # Force the toolbar to stay visible while the driver runs (disable
            # toggleViewAction so the show/hide menu cannot remove it either;
            # restored on unload)
            try:
                tva = self._geo_tb.toggleViewAction()
                if tva is not None:
                    tva.setEnabled(False)
            except Exception:  # nosec B110  # acceptable by design
                pass
            self._geo_tb.setVisible(True)
            self._mode_badge = QToolButton(self._geo_tb)
            self._mode_badge.setAutoRaise(True)
            self._mode_badge.clicked.connect(self._open_mode_dialog)
            # Insert at the front if entries already exist (always first,
            # regardless of reload order)
            acts = self._geo_tb.actions()
            if acts:
                self._mode_badge_action = self._geo_tb.insertWidget(
                    acts[0], self._mode_badge)
            else:
                self._mode_badge_action = self._geo_tb.addWidget(
                    self._mode_badge)
            # Put a separator between the badge and the plugin entries
            after = self._geo_tb.actions()
            if len(after) > 1:
                self._mode_badge_sep = self._geo_tb.insertSeparator(
                    after[1])
            else:
                self._mode_badge_sep = None
            # AI assistant launch button (right of the badge; the toolbar has no
            # AI entry point, so keep at least chat launch resident)
            self._ai_tb_button = QToolButton(self._geo_tb)
            self._ai_tb_button.setAutoRaise(True)
            self._ai_tb_button.setToolTip(
                QCoreApplication.translate(
                    "dsh_qgis_driver", "AI Assistant"))
            ai_icon = QIcon(os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "icon_ai.png"))
            if ai_icon.isNull():
                self._ai_tb_button.setText("AI")
            else:
                self._ai_tb_button.setIcon(ai_icon)
            self._ai_tb_button.clicked.connect(self._open_ai_panel)
            after = self._geo_tb.actions()
            if len(after) > 2:
                self._ai_tb_action = self._geo_tb.insertWidget(
                    after[2], self._ai_tb_button)
            else:
                self._ai_tb_action = self._geo_tb.addWidget(
                    self._ai_tb_button)
            self._refresh_mode_badge()
            self._mode_timer = QTimer(self.iface.mainWindow())
            self._mode_timer.setInterval(5000)
            self._mode_timer.timeout.connect(self._refresh_mode_badge)
            self._mode_timer.start()
        except Exception:
            _log("GeoSuite toolbar init failed:\n" + traceback.format_exc())

    def _refresh_mode_badge(self):
        if self._mode_badge is None:
            return
        try:
            if self._geo_tb is not None and not self._geo_tb.isVisible():
                # Force always-visible (restore if hidden through any path)
                self._geo_tb.setVisible(True)
        except Exception:  # nosec B110  # acceptable by design
            pass
        try:
            from .mode_switch import deploy_state
            st = deploy_state(__file__)
            tr = QCoreApplication.translate
            label = {
                "dev": tr("dsh_qgis_driver", "Development mode"),
                "use": tr("dsh_qgis_driver", "Usage mode"),
                "mixed": tr("dsh_qgis_driver", "Mixed"),
                "none": tr("dsh_qgis_driver", "Not deployed"),
            }.get(st["mode"], st["mode"] or "")
            from qgis.PyQt.QtGui import QIcon
            self._mode_badge.setToolTip(
                "{0} — {1}".format(
                    label, tr("dsh_qgis_driver", "Deploy Mode")))
            if st["mode"] == "use":
                # Usage mode shows only a gear icon to stay unobtrusive
                self._mode_badge.setText("")
                self._mode_badge.setStyleSheet("")
                icon = QIcon()
                try:
                    from qgis.core import QgsApplication
                    icon = QgsApplication.getThemeIcon(
                        "/mActionOptions.svg")
                except Exception:  # nosec B110  # acceptable by design
                    pass
                if icon.isNull():
                    self._mode_badge.setText("⚙")
                else:
                    self._mode_badge.setIcon(icon)
                return
            self._mode_badge.setIcon(QIcon())
            self._mode_badge.setText(label)
            # dev uses a red background as a warning; others use the default
            style = {
                "dev": ("QToolButton { font-weight: bold; color: white; "
                        "background: #c0392b; border-radius: 3px; "
                        "padding: 1px 6px; }"),
            }.get(st["mode"], "")
            self._mode_badge.setStyleSheet(style)
        except Exception:  # nosec B110  # acceptable by design
            pass

    # ---- AI assistant panel ----

    def _open_ai_panel(self):
        from .ai_panel import show_panel
        new = self._ai_panel is None
        self._ai_panel = show_panel(
            self.iface, self._panel_driver, self._ai_panel)
        # Persist visibility (so it reopens after hot reload / QGIS restart)
        self._set_setting(True, self.SETTING_AI_PANEL)
        if new:
            try:
                self._ai_panel.visibilityChanged.connect(
                    lambda vis:
                    self._set_setting(bool(vis), self.SETTING_AI_PANEL))
            except Exception:  # nosec B110  # acceptable by design
                pass

    def _panel_driver(self):
        """Return the LiveDriver used by AI panel tool execution.

        Share the existing driver when remote control is enabled; otherwise
        create an internal driver dedicated to the panel. The internal driver
        has no registry/HTTP surface (only a tempdir live dir), so it cannot be
        discovered externally. Creating it involves a QTimer, so always do it
        on the GUI thread.
        """
        if self.driver is not None:
            return self.driver
        if self._ai_driver is None:
            from .live_driver import LiveDriver
            live_dir = os.path.join(
                tempfile.gettempdir(), f"qgis-live-ai-{os.getpid()}")
            self._ai_driver = LiveDriver(live_dir, iface=self.iface)
        return self._ai_driver

    # ---- Enable/disable ----

    def _default_live_base(self):
        # For distributed use without env, use a user-private dir in the registry
        return os.path.join(_registry_dir(), "run")

    def _settings_enabled(self, key=SETTING_ENABLED):
        try:
            from qgis.PyQt.QtCore import QSettings
            return str(QSettings().value(
                key, "false")).lower() in ("1", "true")
        except Exception:
            return False

    def _set_setting(self, on, key=SETTING_ENABLED):
        try:
            from qgis.PyQt.QtCore import QSettings
            QSettings().setValue(key, bool(on))
        except Exception:  # nosec B110  # acceptable by design
            pass

    def _sync_action(self):
        if self._action is not None:
            self._action.blockSignals(True)
            self._action.setChecked(self.driver is not None)
            self._action.blockSignals(False)

    def _on_toggle(self, checked):
        if checked and self.driver is None:
            from qgis.PyQt.QtWidgets import QMessageBox
            ret = QMessageBox.warning(
                self.iface.mainWindow(), "dsh-qgis-driver",
                QCoreApplication.translate(
                    "dsh_qgis_driver",
                    "Clients will be able to remotely "
                    "control this QGIS process.\n"
                    "pyeval executes arbitrary Python inside QGIS.\n\n"
                    "Access is protected by a per-session token stored "
                    "only in a user-private file, but only trusted "
                    "processes should run under your account.\n\n"
                    "Enable it?"),
                QMessageBox.StandardButton.Yes
                | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No)
            if ret != QMessageBox.StandardButton.Yes:
                self._sync_action()
                return
            self._set_setting(True)
            self._start(self._default_live_base())
            if self.driver is None:
                self._set_setting(False)
            else:
                # Open the connection info dialog so first-time users are not
                # left guessing how to connect (also available from the menu)
                self._open_conn_info()
        elif not checked and self.driver is not None:
            self._set_setting(False)
            self._stop()
        self._sync_action()

    def _start(self, live_base):
        live_dir = os.path.join(
            live_base, f"qgis-{os.getpid()}", __package__)
        try:
            from .live_driver import LiveDriver
            self.driver = LiveDriver(live_dir, iface=self.iface)
            _log(f"dsh_qgis_driver LiveDriver active: {live_dir}")
        except Exception:
            _log("dsh_qgis_driver LiveDriver failed:\n"
                 + traceback.format_exc())
            return

        # Auth: session token mandatory; QGIS_LIVE_API_KEY is an optional extra
        # stable key. For cross-machine access set QGIS_LIVE_HOST=0.0.0.0 and a
        # known QGIS_LIVE_PORT, and give the remote client the QGIS_LIVE_API_KEY.
        # Values come from the Settings dialog (QSettings) or the env vars.
        from .settings_dialog import get_api_key, get_host, get_port
        api_keys = {self.driver.token}
        key = get_api_key() or None
        if key:
            api_keys.add(key)
        host = get_host()
        is_loopback = host in ("127.0.0.1", "localhost", "::1")
        port = get_port()
        try:
            from .http_api import start_http
            self._http, port = start_http(
                self.driver, host=host, port=port, api_keys=api_keys,
                allowed=_http_allowed(), allow_remote=not is_loopback)
            self.driver.http_port = port
            self.driver.http_host = host
            _log(f"dsh_qgis_driver HTTP API: http://{host}:{port}/ "
                 f"remote={'yes' if not is_loopback else 'no'} "
                 f"tools={sorted(_http_allowed()) if _http_allowed() else 'all'}")
        except Exception:
            _log("dsh_qgis_driver HTTP failed:\n"
                 + traceback.format_exc())
            port = None

        try:
            reg_dir = _registry_dir()
            os.makedirs(reg_dir, exist_ok=True)
            self._reg_path = os.path.join(
                reg_dir, f"{os.getpid()}-{__package__}.json")
            with open(self._reg_path, "w", encoding="utf-8") as f:
                json.dump({
                    "pid": os.getpid(),
                    "plugin_id": __package__,
                    "live_dir": live_dir,
                    "host": host,
                    "http_port": port,
                    "token": self.driver.token,
                    "http_tools": (sorted(_http_allowed())
                                   if _http_allowed() else "all"),
                    "started": time.time(),
                }, f)
            # Contains the token, so restrict to the current user
            _restrict_file(self._reg_path)
            _restrict_file(os.path.join(live_dir, "token"))
        except Exception:
            _log("dsh_qgis_driver registry write failed:\n"
                 + traceback.format_exc())

    def _stop(self):
        if self._http is not None:
            try:
                self._http.shutdown()
            except Exception:  # nosec B110  # acceptable by design
                pass
            self._http = None
        if self.driver is not None:
            try:
                self.driver.stop()
            except Exception:  # nosec B110  # acceptable by design
                pass
            self.driver = None
        if self._reg_path is not None:
            try:
                os.remove(self._reg_path)
            except Exception:  # nosec B110  # acceptable by design
                pass
            self._reg_path = None

    def unload(self):
        # QGIS swallows exceptions during unload and keeps going, which would
        # leave actions orphaned in the menu before removal, so catch each one
        if self._ai_panel is not None:
            try:
                # Disconnect first, so visibilityChanged fired by close()
                # cannot overwrite the setting with False; then save visibility
                self._ai_panel.visibilityChanged.disconnect()
            except Exception:  # nosec B110  # acceptable by design
                pass
            try:
                self._set_setting(bool(self._ai_panel.isVisible()),
                                  self.SETTING_AI_PANEL)
            except Exception:  # nosec B110  # acceptable by design
                pass
            try:
                self._ai_panel.close()
                self._ai_panel.deleteLater()
            except Exception:  # nosec B110  # acceptable by design
                pass
            self._ai_panel = None
        if self._ai_driver is not None:
            try:
                self._ai_driver.stop()
            except Exception:  # nosec B110  # acceptable by design
                pass
            self._ai_driver = None
        _menu_cleanup_items = {}
        if self._hot_menu is not None:
            _menu_cleanup_items["hot_menu"] = self._hot_menu
            self._hot_menu = None
        if self._conn_dlg is not None:
            try:
                self._conn_dlg.close()
                self._conn_dlg.deleteLater()
            except Exception:  # nosec B110  # acceptable by design
                pass
            self._conn_dlg = None
        # Defer removal of plugin-menu QAction/QMenu items until the event loop
        # finishes. If unload runs from a menu triggered handler via
        # reloadPlugin, removePluginMenu rewrites the popup menu hierarchy while
        # Qt is processing it, causing an access violation inside Qt (observed
        # when dsh_qgis_driver was reloaded from another driver's hot reload).
        _menu_cleanup_items["actions"] = [
            a for a in (self._ai_action, self._action,
                        self._conn_action, self._mode_action)
            if a is not None]
        self._ai_action = None
        self._action = None
        self._conn_action = None
        self._mode_action = None
        self._defer_menu_cleanup(_menu_cleanup_items)
        if self._mode_timer is not None:
            try:
                self._mode_timer.stop()
            except Exception:  # nosec B110  # acceptable by design
                pass
            self._mode_timer = None
        for a in (self._mode_badge_sep, self._mode_badge_action):
            if a is not None:
                try:
                    if self._geo_tb is not None:
                        self._geo_tb.removeAction(a)
                except Exception:  # nosec B110  # acceptable by design
                    pass
        self._mode_badge_sep = None
        self._mode_badge_action = None
        if self._mode_badge is not None:
            try:
                self._mode_badge.deleteLater()
            except Exception:  # nosec B110  # acceptable by design
                pass
            self._mode_badge = None
        if self._ai_tb_action is not None:
            try:
                if self._geo_tb is not None:
                    self._geo_tb.removeAction(self._ai_tb_action)
            except Exception:  # nosec B110  # acceptable by design
                pass
            self._ai_tb_action = None
        if self._ai_tb_button is not None:
            try:
                self._ai_tb_button.deleteLater()
            except Exception:  # nosec B110  # acceptable by design
                pass
            self._ai_tb_button = None
        if self._geo_tb is not None:
            try:
                # Release the always-visible override (other plugins' entries stay)
                tva = self._geo_tb.toggleViewAction()
                if tva is not None:
                    tva.setEnabled(True)
            except Exception:  # nosec B110  # acceptable by design
                pass
        self._geo_tb = None
        try:
            self._stop()
        except Exception:  # nosec B110  # acceptable by design
            pass


def classFactory(iface):
    return GeoDriverPlugin(iface)
