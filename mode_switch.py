"""Deploy mode (dev/use) switch UI.

From the menu "Plugins > QGIS Live Driver > Deploy Mode", explicitly switch
between development mode (junction = repo preferred) and use mode (real dir =
restore the parked copy). The actual switch is performed by launching
scripts/deploy-plugin.ps1 in the repository, and afterwards the plugin can
optionally be reloaded.

The mode declaration is written to profiles/<profile>/qgis_live_mode.json
({"mode":"dev"|"use","repo":"<harness repo>"}). The declaration records
intent; mode detection prefers the deployment reality (junction/dir) and
falls back to the declaration only when nothing is deployed. Even with a
real-dir install (use mode), the script can be resolved from marker.repo.
When switching to dev, any existing real plugin (use version) is parked to
profiles/<profile>/qgis_live_parked/<id> before the junction is created;
when switching to use, the junction is removed and the parked copy is
restored (if there is neither a parked copy nor an existing real dir, the
plugin stays undeployed = it was not being used).
Creating/updating a use version by copying from the repo happens only with
-Install (a release operation). The script guarantees that a failed junction
never falls back to copy automatically.
"""

import json
import os
import subprocess  # nosec B404  # needed to launch deploy-plugin.ps1

CTRL_ID = "geo_driver"
_MARK = "qgis_live_mode.json"
_REPARSE = 0x400  # FILE_ATTRIBUTE_REPARSE_POINT
SETTING_REPO = "geo_driver/harness_repo"


def _looks_like_repo(path):
    """Check whether the path looks like a harness repo (deploy script present)."""
    return (os.path.isdir(path)
            and os.path.isfile(
                os.path.join(path, "scripts", "deploy-plugin.ps1")))


def _settings_repo():
    """Return the harness repo path explicitly set in QSettings (None if unset).

    A standalone install (copy/ZIP) has neither marker nor junction, so the
    user has a way to pick the folder from the Deploy Mode dialog.
    """
    try:
        from qgis.PyQt.QtCore import QSettings
        p = str(QSettings().value(SETTING_REPO, "") or "").strip()
        if p and os.path.isdir(p):
            return os.path.abspath(p)
    except Exception:  # nosec B110  # acceptable by design
        pass
    return None


def set_repo_path(path):
    """Save the harness repo path to QSettings. None/empty clears it.

    @returns (ok, msg). Folders that do not look like a repo are rejected.
    """
    try:
        from qgis.PyQt.QtCore import QSettings
        if path:
            if not _looks_like_repo(path):
                return False, (
                    "not a harness repo "
                    "(scripts/deploy-plugin.ps1 not found): "
                    + str(path))
            QSettings().setValue(SETTING_REPO, os.path.abspath(path))
        else:
            QSettings().remove(SETTING_REPO)
        return True, ""
    except Exception as e:
        return False, str(e)


def profile_root(own_file):
    """Return the profile root from the deployed path
    .../<profile>/python/plugins/<id>/<file>."""
    p = os.path.abspath(own_file)
    for _ in range(4):
        p = os.path.dirname(p)
    return p


def _is_junction(path):
    """Detect a Windows junction/reparse point (islink does not catch junctions)."""
    try:
        st = os.stat(path, follow_symlinks=False)
        if getattr(st, "st_file_attributes", 0) & _REPARSE:
            return True
    except Exception:  # nosec B110  # acceptable by design
        pass
    return os.path.islink(path)


def read_marker(own_file):
    """Read the mode declaration marker. Returns an empty dict if absent."""
    try:
        with open(os.path.join(profile_root(own_file), _MARK),
                  encoding="utf-8-sig") as f:
            m = json.load(f)
        if isinstance(m, dict):
            return m
    except Exception:  # nosec B110  # acceptable by design
        pass
    return {}


def repo_root(own_file):
    """Return the root of the harness repository.

    Resolution order: explicit QSettings value > marker.repo >
    inference from the junction realpath (.../qgis-plugin/<id>).
    """
    p = _settings_repo()
    if p:
        return p
    m = read_marker(own_file).get("repo")
    if m and os.path.isdir(m):
        return m
    deployed = os.path.dirname(os.path.abspath(own_file))
    real = os.path.dirname(os.path.realpath(deployed))
    if os.path.basename(real) == "qgis-plugin":
        return os.path.dirname(real)
    return None


def managed_ids(own_file):
    """Ids of the managed plugins. Prefers repo-side plugin.config.json,
    else junction installs (realpath under qgis-plugin)."""
    root = repo_root(own_file)
    if root:
        try:
            with open(os.path.join(root, "plugin.config.json"),
                      encoding="utf-8-sig") as f:
                ids = json.load(f).get("id")
            if isinstance(ids, str):
                ids = [ids]
            if ids:
                return sorted(set(ids))
        except Exception:  # nosec B110  # acceptable by design
            pass
    try:
        from .hot_reload import dev_plugin_ids
        return sorted(set(dev_plugin_ids(own_file) + [CTRL_ID]))
    except Exception:
        return [CTRL_ID]


def deploy_state(own_file):
    """Return the current deploy state.

    {mode, declared, actual, diverged, plugins:{id: junction|dir|missing},
     parked, repo, profile}
    mode prefers the deployment reality (actual). What actually runs is the
    deployed artifact, so a stale declaration must not override reality. Only
    when nothing is deployed (none) does the declaration fill in (keeping the
    use declaration = intent to suppress auto-deploy). diverged=True when the
    declaration and reality disagree.
    """
    proot = profile_root(own_file)
    plugins_root = os.path.join(proot, "python", "plugins")
    parked_root = os.path.join(proot, "qgis_live_parked")
    forms = {}
    parked = {}
    for pid in managed_ids(own_file):
        p = os.path.join(plugins_root, pid)
        parked[pid] = os.path.isdir(os.path.join(parked_root, pid))
        if not os.path.isdir(p):
            forms[pid] = "missing"
        elif _is_junction(p):
            forms[pid] = "junction"
        else:
            forms[pid] = "dir"
    declared = read_marker(own_file).get("mode")
    if declared not in ("dev", "use"):
        declared = None
    vals = set(forms.values()) - {"missing"}
    if not vals:
        actual = "none"
    elif "junction" in vals and "dir" in vals:
        actual = "mixed"
    elif "junction" in vals:
        actual = "dev"
    else:
        actual = "use"
    mode = actual if actual != "none" else (declared or "none")
    return {
        "mode": mode,
        "declared": declared,
        "actual": actual,
        "diverged": declared is not None and declared != mode,
        "plugins": forms,
        "parked": parked,
        "repo": repo_root(own_file),
        "profile": os.path.basename(proot),
    }


def switch_mode(own_file, mode):
    """Launch deploy-plugin.ps1 to switch modes. Returns (ok, output)."""
    root = repo_root(own_file)
    if not root:
        return False, "repo root not found (qgis_live_mode.json/repo unknown)"
    ps1 = os.path.join(root, "scripts", "deploy-plugin.ps1")
    # QGIS (OSGeo4W) environments have a minimal PATH and may fail to resolve
    # "powershell", so prefer the full path under SystemRoot
    exe = "powershell"
    if os.name == "nt":
        cand = os.path.join(
            os.environ.get("SystemRoot", r"C:\Windows"),
            "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        if os.path.isfile(cand):
            exe = cand
    args = [exe, "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", ps1]
    if mode == "use":
        args.append("-Use")
    elif mode == "install":
        args.append("-Install")
    elif mode != "dev":
        return False, f"unknown mode: {mode}"
    kw = {"capture_output": True, "text": True, "timeout": 300}
    if os.name == "nt":
        kw["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        r = subprocess.run(args, **kw)  # nosec B603  # exe/args are fixed whitelisted values
    except Exception as e:
        return False, str(e)
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    return r.returncode == 0, out


def show_dialog(iface, own_file, notify=None):
    """Show the mode switch dialog modally."""
    from qgis.PyQt.QtCore import QCoreApplication, Qt
    from qgis.PyQt.QtWidgets import (
        QApplication, QCheckBox, QDialog, QDialogButtonBox, QHBoxLayout,
        QLabel, QMessageBox, QPushButton, QTableWidget, QTableWidgetItem,
        QVBoxLayout)

    def tr(s):
        return QCoreApplication.translate("geo_driver", s)

    dlg = QDialog(iface.mainWindow())
    dlg.setWindowTitle(tr("Deploy Mode"))
    lay = QVBoxLayout(dlg)
    repo_row = QHBoxLayout()
    repo_row.addWidget(QLabel(tr("Harness repository:"), dlg))
    repo_label = QLabel(dlg)
    repo_label.setTextInteractionFlags(
        Qt.TextInteractionFlag.TextSelectableByMouse)
    repo_row.addWidget(repo_label, 1)
    browse_btn = QPushButton(tr("Browse…"), dlg)
    repo_row.addWidget(browse_btn)
    lay.addLayout(repo_row)
    mode_label = QLabel(dlg)
    lay.addWidget(mode_label)
    table = QTableWidget(dlg)
    table.setColumnCount(2)
    table.setHorizontalHeaderLabels([tr("Plugin"), tr("Form")])
    table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
    lay.addWidget(table)
    chk = QCheckBox(tr("Reload plugins after switch"), dlg)
    chk.setChecked(True)
    lay.addWidget(chk)
    note = QLabel(tr(
        "geo_driver itself is reloaded via Hot Reload menu "
        "or QGIS restart."), dlg)
    note.setWordWrap(True)
    lay.addWidget(note)
    human_note = QLabel(tr(
        "[UI only] Mode switching is a manual operation — it cannot be "
        "invoked by AI or automation (no API path). "
        "deployMode() is read-only."), dlg)
    human_note.setWordWrap(True)
    lay.addWidget(human_note)
    btns = QDialogButtonBox(QDialogButtonBox.StandardButton.Close,
                            parent=dlg)
    dev_btn = QPushButton(tr("Switch to Development (junction)"), dlg)
    use_btn = QPushButton(tr("Switch to Usage (restore parked)"), dlg)
    inst_btn = QPushButton(
        tr("Install current repo as usage version (release)"), dlg)
    btns.addButton(dev_btn, QDialogButtonBox.ButtonRole.ActionRole)
    btns.addButton(use_btn, QDialogButtonBox.ButtonRole.ActionRole)
    btns.addButton(inst_btn, QDialogButtonBox.ButtonRole.ActionRole)
    btns.rejected.connect(dlg.reject)
    lay.addWidget(btns)
    dlg.resize(520, 340)

    def refresh():
        st = deploy_state(own_file)
        repo_label.setText(st["repo"] or tr("(not configured)"))
        label = {
            "dev": tr("Development (junction: repository sources)"),
            "use": tr("Usage (restored version)"),
            "mixed": tr("Mixed"),
            "none": tr("Not deployed"),
        }.get(st["mode"], st["mode"] or "")
        text = tr("Current mode: {0}").format(label)
        if st.get("diverged") and st.get("declared"):
            dlabel = {
                "dev": tr("Development mode"),
                "use": tr("Usage mode"),
            }.get(st["declared"], st["declared"])
            text += " " + tr("(declared: {0})").format(dlabel)
        mode_label.setText(text)
        ids = list(st["plugins"])
        table.setRowCount(len(ids))
        for i, pid in enumerate(ids):
            table.setItem(i, 0, QTableWidgetItem(pid))
            form = st["plugins"][pid]
            if st.get("parked", {}).get(pid):
                form += " (+parked)"
            table.setItem(i, 1, QTableWidgetItem(form))
        table.resizeColumnsToContents()
        dev_btn.setEnabled(st["mode"] != "dev")
        use_btn.setEnabled(st["mode"] != "use")
        return st

    def do_switch(mode):
        if not deploy_state(own_file)["repo"]:
            QMessageBox.warning(
                dlg, "QGIS Live Driver",
                tr("Repository not found: cannot locate deploy-plugin.ps1"))
            return
        dev_btn.setEnabled(False)
        use_btn.setEnabled(False)
        inst_btn.setEnabled(False)
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            ok, out = switch_mode(own_file, mode)
        finally:
            QApplication.restoreOverrideCursor()
        if not ok:
            QMessageBox.warning(
                dlg, "QGIS Live Driver",
                tr("Mode switch failed") + "\n" + out[-2000:])
            inst_btn.setEnabled(True)
            refresh()
            return
        if chk.isChecked():
            # Exclude the driver itself (the plugin owning this dialog;
            # it picks up changes via the menu hot reload or a QGIS restart)
            ids = [p for p in deploy_state(own_file)["plugins"]
                   if p != CTRL_ID]
            try:
                from .hot_reload import reload_plugins
                reload_plugins(ids, notify=notify)
            except Exception:  # nosec B110  # acceptable by design
                pass
        if notify:
            notify("info", tr("Deploy mode switched: {0}").format(mode))
        inst_btn.setEnabled(True)
        refresh()

    def do_browse():
        """Let the user pick a harness repo folder and save it to QSettings.

        Even on a standalone install (no marker/junction), specifying the repo
        here lets "Switch to Development" run deploy-plugin.ps1 afterwards
        (the driver is junctioned too and moves to the dev environment).
        """
        from qgis.PyQt.QtWidgets import QFileDialog
        d = QFileDialog.getExistingDirectory(
            dlg, tr("Select the qgis_live_harness repository folder"),
            repo_root(own_file) or "")
        if not d:
            return
        ok, msg = set_repo_path(d)
        if not ok:
            QMessageBox.warning(
                dlg, "QGIS Live Driver",
                tr("Not a harness repository") + "\n" + msg)
            return
        refresh()

    browse_btn.clicked.connect(do_browse)
    dev_btn.clicked.connect(lambda: do_switch("dev"))
    use_btn.clicked.connect(lambda: do_switch("use"))
    inst_btn.clicked.connect(lambda: do_switch("install"))
    refresh()
    dlg.exec()
