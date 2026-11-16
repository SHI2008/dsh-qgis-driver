"""Development hot reload (manual).

From the menu "Plugins > dsh-qgis-driver > Hot Reload", manually clean
sys.modules for the plugin under development and run reloadPlugin
(+ re-show open_dialog). No QGIS restart or deploy is needed.

Candidate plugin ids are only those whose deployed realpath resolves to
<repo>/qgis-plugin/<id> (junction placement). Real-copy placement (user mode)
and third-party plugins are not targeted.
"""

import os

try:
    from qgis.PyQt.QtCore import QCoreApplication
except ImportError:
    QCoreApplication = None

CTRL_ID = "dsh_qgis_driver"


def dev_plugin_ids(own_file):
    """Return the list of plugin ids eligible for hot reload.

    The ids of deployed plugins whose realpath resolves under
    <repo>/qgis-plugin/ (junction placement), in id order. Empty if none.
    """
    deployed_dir = os.path.dirname(os.path.abspath(own_file))
    plugins_root = os.path.dirname(deployed_dir)
    ids = []
    try:
        for d in os.listdir(plugins_root):
            p = os.path.join(plugins_root, d)
            if not os.path.isdir(p):
                continue
            try:
                src = os.path.dirname(os.path.realpath(p))
            except Exception:  # nosec B112  # acceptable by design
                continue
            if os.path.basename(src) == "qgis-plugin":
                ids.append(d)
    except Exception:  # nosec B110  # acceptable by design
        pass
    return sorted(ids)


def reload_plugins(ids, notify=None):
    """Reload the plugin ids one by one.

    The control side, dsh_qgis_driver, goes last (so the send path is not killed
    first). Reloading the plugin itself is also possible (the calling frame
    stays valid). notify is a callback receiving (level, msg)
    (level="info"/"warn").
    """
    notify = notify or (lambda level, msg: None)
    for pid in sorted(ids, key=lambda p: (p == CTRL_ID, p)):
        try:
            from .live_driver import reload_plugin_now
            res = reload_plugin_now(pid)
            notify("info", QCoreApplication.translate(
                "dsh_qgis_driver", "Hot Reload: {0}").format(pid)
                + (QCoreApplication.translate(
                    "dsh_qgis_driver", " (dialog reopened)")
                   if res.get("opened") else ""))
        except Exception:
            notify("warn", QCoreApplication.translate(
                "dsh_qgis_driver", "Hot Reload failed: {0}").format(pid))
