"""Connection info dialog (first-run guidance).

So that a user who enabled remote control is not left wondering "what next",
it shows the REST connection details together with a copyable curl example,
plus the session token, live dir and registry path.

- Opened from the menu "Plugins > QGIS Live Driver > Connection Info"
- Also shown automatically right after the remote control toggle is turned ON
- Opens even while remote control is OFF. In that case it shows only the
  enablement steps.

The layout is "top Harness repository row (always visible) + tabs by content":
the repo is the first thing needed for initial setup, so it stays visible,
while REST/session details are separated into tabs for readability.
"""

import os

from qgis.PyQt.QtCore import QCoreApplication


def _tr(s):
    return QCoreApplication.translate("geo_driver", s)


def _curl_example(host, port, token):
    return (f'curl.exe -H "Authorization: Bearer {token}" '
            f"http://{host}:{port}/api/status")


def _repo_status(plugin_dir):
    """Return the resolved harness repo (same path as resolution in mode_switch)."""
    try:
        from .mode_switch import repo_root
        return repo_root(os.path.join(plugin_dir, "__init__.py"))
    except Exception:  # nosec B110  # acceptable by design
        return None


def _off_msg():
    return _tr(
        "Remote control is OFF.\\n"
        "Enable it via Plugins > QGIS Live Driver > "
        "Remote Control, then press Refresh.")


def build_sections(plugin):
    """Build and return the per-tab display data.

    {"repo": str|None, "status": str, "rest": str,
     "fields": {"reg": str, "livedir": str|None, "token": str|None},
     "snippets": {key: text}}
    """
    plugin_dir = os.path.dirname(os.path.abspath(__file__))
    drv = plugin.driver
    repo = _repo_status(plugin_dir)
    snippets = {}
    if repo:
        snippets["repo"] = repo

    reg_dir = os.environ.get(
        "QGIS_LIVE_REGISTRY",
        os.path.join(os.path.expanduser("~"), ".qgis-live"))
    reg_path = getattr(plugin, "_reg_path", None) or os.path.join(
        reg_dir, f"{os.getpid()}-geo_driver.json")
    fields = {"reg": reg_path, "livedir": None, "token": None}
    snippets["reg"] = reg_path

    if drv is None:
        off = _off_msg()
        status = off
        rest = off
    else:
        port = drv.http_port
        host = getattr(drv, "http_host", None) or "127.0.0.1"
        fields["livedir"] = drv.dir
        fields["token"] = drv.token
        snippets["livedir"] = drv.dir
        snippets["token"] = drv.token
        status = _tr("Remote control is enabled.")
        if port:
            status += f"  (http://{host}:{port})"
            snippets["curl"] = _curl_example(host, port, drv.token)
            rest = (f"REST API base: http://{host}:{port}/api"
                    "\\n\\n--- " + _tr("REST example (curl)") + " ---\\n"
                    + snippets["curl"])
        else:
            rest = _tr(
                "(HTTP server is not listening; the registry file "
                "still works)")
    return {"repo": repo, "status": status, "rest": rest,
            "fields": fields, "snippets": snippets}


def show_dialog(plugin):
    """Open the connection info dialog non-modally and return it."""
    from qgis.PyQt.QtWidgets import (
        QApplication, QDialog, QDialogButtonBox, QFormLayout,
        QHBoxLayout, QLabel, QLineEdit, QPlainTextEdit, QPushButton,
        QTabWidget, QVBoxLayout, QWidget)
    from qgis.PyQt.QtGui import QFontDatabase

    dlg = QDialog(plugin.iface.mainWindow())
    dlg.setWindowTitle(_tr("QGIS Live Driver — Connection Info"))
    lay = QVBoxLayout(dlg)
    fixed = QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont)

    state = {"snippets": {}}
    copies = []

    def _notify(msg):
        try:
            plugin._hot_notify("info", msg)
        except Exception:  # nosec B110  # acceptable by design
            pass

    def _make_copy(key):
        def _copy():
            s = state["snippets"].get(key)
            if s:
                QApplication.clipboard().setText(s)
                _notify(_tr("Copied to clipboard"))
        return _copy

    def _copy_btn(row, label, key):
        b = QPushButton(label, dlg)
        b.clicked.connect(_make_copy(key))
        row.addWidget(b)
        copies.append((b, key))
        return b

    # ── Top row: Harness repository (always shown; essential for first setup) ──
    repo_row = QHBoxLayout()
    repo_row.addWidget(QLabel(_tr("Harness repository"), dlg))
    repo_edit = QLineEdit(dlg)
    repo_edit.setReadOnly(True)
    repo_row.addWidget(repo_edit, 1)
    _copy_btn(repo_row, _tr("Copy"), "repo")
    repo_btn = QPushButton(_tr("Locate harness repo…"), dlg)
    repo_row.addWidget(repo_btn)
    refresh_btn = QPushButton(_tr("Refresh"), dlg)
    repo_row.addWidget(refresh_btn)
    lay.addLayout(repo_row)

    status_lbl = QLabel(dlg)
    status_lbl.setWordWrap(True)
    lay.addWidget(status_lbl)

    # ── Tabs by content type ──
    tabs = QTabWidget(dlg)
    lay.addWidget(tabs, 1)

    def _text_tab(title):
        w = QWidget(dlg)
        v = QVBoxLayout(w)
        edit = QPlainTextEdit(w)
        edit.setReadOnly(True)
        edit.setFont(fixed)
        v.addWidget(edit, 1)
        row = QHBoxLayout()
        row.addStretch(1)
        v.addLayout(row)
        tabs.addTab(w, title)
        return edit, row

    rest_edit, rest_row = _text_tab("REST")
    _copy_btn(rest_row, _tr("Copy REST example"), "curl")
    _copy_btn(rest_row, _tr("Copy token"), "token")

    sess_w = QWidget(dlg)
    sess_lay = QVBoxLayout(sess_w)
    form = QFormLayout()
    sess_lay.addLayout(form)
    sess_lay.addStretch(1)
    sess_rows = []
    for label, key in (
            (_tr("Registry file"), "reg"),
            (_tr("Live dir"), "livedir"),
            (_tr("Token"), "token")):
        lab = QLabel(label, sess_w)
        holder = QWidget(sess_w)
        h = QHBoxLayout(holder)
        h.setContentsMargins(0, 0, 0, 0)
        e = QLineEdit(sess_w)
        e.setReadOnly(True)
        h.addWidget(e, 1)
        b = QPushButton(_tr("Copy"), sess_w)
        b.clicked.connect(_make_copy(key))
        h.addWidget(b)
        copies.append((b, key))
        form.addRow(lab, holder)
        sess_rows.append((key, lab, holder, e))
    tabs.addTab(sess_w, _tr("Session"))

    btns = QDialogButtonBox(QDialogButtonBox.StandardButton.Close,
                            parent=dlg)
    btns.rejected.connect(dlg.reject)
    lay.addWidget(btns)

    def _refresh():
        secs = build_sections(plugin)
        repo = secs["repo"]
        repo_edit.setText(repo or "")
        repo_edit.setPlaceholderText(
            "" if repo else _tr("(not configured)"))
        state["snippets"] = secs["snippets"]
        status_lbl.setText(secs["status"])
        rest_edit.setPlainText(secs["rest"])
        for key, lab, holder, e in sess_rows:
            val = secs["fields"].get(key)
            lab.setVisible(val is not None)
            holder.setVisible(val is not None)
            e.setText(val or "")
        for b, key in copies:
            b.setEnabled(key in state["snippets"])

    refresh_btn.clicked.connect(_refresh)

    def _locate_repo():
        """Let the user pick the harness repo folder and save it to QSettings."""
        from qgis.PyQt.QtWidgets import QFileDialog, QMessageBox
        plugin_dir = os.path.dirname(os.path.abspath(__file__))
        d = QFileDialog.getExistingDirectory(
            dlg, _tr("Select the qgis_live_harness repository folder"),
            _repo_status(plugin_dir) or "")
        if not d:
            return
        try:
            from .mode_switch import set_repo_path
            ok, msg = set_repo_path(d)
        except Exception as e:  # nosec B110  # acceptable by design
            ok, msg = False, str(e)
        if not ok:
            QMessageBox.warning(
                dlg, "QGIS Live Driver",
                _tr("Not a harness repository") + "\\n" + msg)
            return
        _notify(_tr("Harness repository set: {0}").format(d))
        _refresh()

    repo_btn.clicked.connect(_locate_repo)

    _refresh()
    dlg.resize(680, 560)
    dlg.show()
    return dlg
