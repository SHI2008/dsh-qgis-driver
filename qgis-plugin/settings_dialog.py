"""Connection settings dialog (bind address / port / API key).

The HTTP server bind address, port and stable API key can be set from the GUI
(stored in QSettings) or from environment variables (QGIS_LIVE_HOST,
QGIS_LIVE_PORT, QGIS_LIVE_API_KEY). Precedence is QSettings > environment >
defaults. Changing the values takes effect on the next start of the HTTP
server (toggle Remote Control off/on, or restart QGIS), because the server
binds once at startup.

- Opened from the menu "Plugins > dsh-qgis-driver > Settings"
"""

import os

from qgis.PyQt.QtCore import QCoreApplication, QSettings
from qgis.PyQt.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLabel,
    QLineEdit,
    QSpinBox,
)

SETTING_HOST = "dsh_qgis_driver/host"
SETTING_PORT = "dsh_qgis_driver/port"
SETTING_API_KEY = "dsh_qgis_driver/api_key"

_DEFAULT_HOST = "127.0.0.1"


def _tr(s):
    return QCoreApplication.translate("dsh_qgis_driver", s)


def _raw(setting):
    val = QSettings().value(setting, "")
    return str(val).strip() if val is not None else ""


def get_host():
    """Bind host: QSettings > QGIS_LIVE_HOST > 127.0.0.1."""
    return _raw(SETTING_HOST) or os.environ.get("QGIS_LIVE_HOST", "").strip() \
        or _DEFAULT_HOST


def get_port():
    """Bind port (0 = auto): QSettings > QGIS_LIVE_PORT > 0."""
    raw = _raw(SETTING_PORT) or os.environ.get("QGIS_LIVE_PORT", "").strip() \
        or "0"
    try:
        return int(raw)
    except ValueError:
        return 0


def get_api_key():
    """Optional stable API key: QSettings > QGIS_LIVE_API_KEY > empty."""
    return _raw(SETTING_API_KEY) or os.environ.get("QGIS_LIVE_API_KEY", "").strip()


class SettingsDialog(QDialog):
    """Edit the connection settings; writes QSettings on save."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle(_tr("dsh-qgis-driver — Settings"))

        self._host = QLineEdit(get_host())
        self._port = QSpinBox()
        self._port.setRange(0, 65535)
        self._port.setSpecialValueText(_tr("auto"))
        self._port.setValue(get_port())
        self._key = QLineEdit(get_api_key())
        self._key.setEchoMode(QLineEdit.Password)

        form = QFormLayout(self)
        form.addRow(_tr("Bind address"), self._host)
        form.addRow(_tr("Port (0 = auto)"), self._port)
        form.addRow(_tr("API key (optional)"), self._key)

        hint = QLabel(_tr(
            "Changes apply after the plugin restarts (toggle Remote Control "
            "off and on, or restart QGIS). Leave the API key empty to use only "
            "the per-session token. For cross-machine access, set the bind "
            "address to 0.0.0.0 and a fixed port, then share the API key with "
            "the remote client."))
        hint.setWordWrap(True)
        form.addRow(hint)

        buttons = QDialogButtonBox(
            QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self._save)
        buttons.rejected.connect(self.reject)
        form.addRow(buttons)

    def _save(self):
        s = QSettings()
        s.setValue(SETTING_HOST, self._host.text().strip())
        s.setValue(SETTING_PORT, self._port.value())
        s.setValue(SETTING_API_KEY, self._key.text().strip())
        self.accept()
