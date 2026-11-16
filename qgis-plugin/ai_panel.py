"""AI assistant dock - connects to LLM APIs and drives QGIS interactively.

Opened from `Plugins > dsh-qgis-driver > AI Assistant`.
After configuring a provider (OpenAI-compatible / Anthropic / Gemini / Azure OpenAI /
GitHub Copilot), the endpoint, API key and model, this driver's tool set
(qgis_pyeval/qgis_screenshot/...) is run in a loop from the chat through
function calling.
Selecting GitHub Copilot and pressing "Sign in with GitHub" obtains a token
through the OAuth device flow.

Layout:
    - Transport and schema conversion live in ai_client.py (stdlib only, pytest-covered)
    - Tool execution goes LiveDriver.submit() -> dispatch on the GUI thread.
        Works even with the remote-control toggle OFF, via the internal driver from __init__
    - Network/tool execution uses worker threads; UI updates go through signals
    - API keys are stored in the OS credential store (credential_store.py).
        If the store write fails, report an error instead of saving plaintext.
        Endpoint/model are kept in QSettings under a separate key per provider
"""

import html
import json
import os
import re
import threading
import time

from qgis.PyQt.QtCore import (
    Qt, QSettings, QUrl, QCoreApplication, QT_TRANSLATE_NOOP,
    pyqtSignal)
from qgis.PyQt.QtGui import (
    QDesktopServices,
    QImage,
    QPixmap,
    QStandardItem,
    QStandardItemModel,
    QTextDocument,
)
from qgis.PyQt.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDockWidget,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QLineEdit,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSizePolicy,
    QSplitter,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
    QLabel,
)

from . import ai_client, credential_store

_SETTING = "dsh_qgis_driver/ai_{}"
# Display order is [API] -> [ACP] -> [Bridge] (ai_client.PROVIDER_ORDER).
# Future providers missing from ORDER are appended at the end in definition order.
_PROVIDER_IDS = (
    [p for p in ai_client.PROVIDER_ORDER if p in ai_client.PROVIDERS]
    + [p for p in ai_client.PROVIDERS
       if p not in ai_client.PROVIDER_ORDER])
_MODEL_HINT = QT_TRANSLATE_NOOP(
    "dsh_qgis_driver",
    "Press \"Fetch\" to list models from the endpoint. "
    "Values in parentheses are prices (input/output, $/1M tokens, "
    "reference only).")


def _esc(t):
    return html.escape(t or "").replace("\n", "<br>")


def _md(t):
    """Markdown -> body HTML (the body content of QTextDocument.toHtml())."""
    doc = QTextDocument()
    doc.setMarkdown(t or "")
    h = doc.toHtml()
    m = re.search(r"<body[^>]*>(.*)</body>", h, re.S)
    return m.group(1) if m else h


class _Input(QPlainTextEdit):
    """Input field that sends on Enter and inserts a newline on Shift+Enter.

    Images (clipboard, dragged image files) are not inserted as text;
    they are passed to the panel through sig_images.
    """
    sig_submit = pyqtSignal()
    sig_images = pyqtSignal(list)  # [QImage | local path str, ...]

    _IMG_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp",
                 ".webp", ".tif", ".tiff"}

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._hint = ""
        self._composing = False

    def _image_sources(self, mime):
        """Take an image source (QImage or local path) out of mime data."""
        if mime.hasImage():
            return [mime.imageData()]
        return [u.toLocalFile() for u in mime.urls()
                if u.isLocalFile() and os.path.splitext(
                    u.toLocalFile())[1].lower() in self._IMG_EXTS]

    def canInsertFromMimeData(self, mime):
        return (bool(self._image_sources(mime))
                or super().canInsertFromMimeData(mime))

    def insertFromMimeData(self, mime):
        imgs = self._image_sources(mime)
        if imgs:
            self.sig_images.emit(imgs)
            return
        super().insertFromMimeData(mime)

    def dragEnterEvent(self, e):
        if self._image_sources(e.mimeData()):
            e.acceptProposedAction()
        else:
            super().dragEnterEvent(e)

    def dropEvent(self, e):
        imgs = self._image_sources(e.mimeData())
        if imgs:
            self.sig_images.emit(imgs)
            e.acceptProposedAction()
            return
        super().dropEvent(e)

    def set_hint(self, text):
        """Apply the placeholder text while keeping a reference to it."""
        self._hint = text or ""
        super().setPlaceholderText(self._hint)

    def keyPressEvent(self, e):
        # Send on Enter without Shift (an Enter confirming IME conversion does not send)
        if (e.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter)
                and not self._composing
                and not e.modifiers() & Qt.KeyboardModifier.ShiftModifier):
            self.sig_submit.emit()
            return
        super().keyPressEvent(e)

    def inputMethodEvent(self, e):
        # The document is also empty while the IME preedit is active, so Qt's
        # placeholder would overlap the uncommitted text; hide it during conversion
        self._composing = bool(e.preeditString())
        super().setPlaceholderText("" if self._composing else self._hint)
        super().inputMethodEvent(e)

    def focusOutEvent(self, e):
        super().setPlaceholderText(self._hint)
        super().focusOutEvent(e)


class AiPanel(QDockWidget):
    sig_append = pyqtSignal(str, str)    # (kind, text) formatted on the GUI thread
    sig_instructions = pyqtSignal()      # an ai_* tool updated an instruction
    sig_agent_changed = pyqtSignal(str)  # agent switched by ai_select_agent (id)
    sig_confirm = pyqtSignal(str, str)   # tool confirmation request (name, args label)
    sig_status = pyqtSignal(str)
    sig_busy = pyqtSignal(bool)
    sig_models = pyqtSignal(list, str)   # (models, error) model list fetch result
    sig_signin = pyqtSignal(str, str)    # (pid, token) device flow completed
    sig_open_url = pyqtSignal(str)       # URL to open in a browser (on the GUI thread)

    def __init__(self, iface, get_driver, parent=None):
        super().__init__(
            QCoreApplication.translate(
                "dsh_qgis_driver", "AI Assistant"),
            parent or iface.mainWindow())
        self.setObjectName("GeoDriverAiPanel")
        self.iface = iface
        self._get_driver = get_driver
        self._history = []      # [{"role": "user"|"assistant", "content": str}]
        # Chat sessions. Index 0 is always the "current chat" (matches the combo index).
        # Past chats are stacked behind it as {"title","history","html"}
        self._sessions = [{"title": QCoreApplication.translate(
            "dsh_qgis_driver", "Current chat"),
            "history": self._history, "html": "",
            "agent": None}]
        self._open_chat = 0     # index of the session being displayed
        self._model_infos = {}  # {id: ai_client.model_info()}
        self._busy = False
        self._abort = False         # set by the Abort button; checked at loop boundaries
        self._alive = True
        self._signin_abort = False
        self._confirm_event = threading.Event()
        self._confirm_result = False
        self._plugins = []           # plugin list at the last send (for ctx estimation)
        self._instr_dlg = None       # open instruction editor dialog
        self._attachments = []       # pending attachment image paths (PNG)
        self._usage = {"in": 0, "out": 0, "last": 0}  # cumulative API response usage
        self.destroyed.connect(self._on_destroyed)

        root = QWidget(self)
        lay = QVBoxLayout(root)
        lay.setContentsMargins(6, 6, 6, 6)

        # ---- API settings ----
        box = QGroupBox(self.tr("API settings"), root)
        form = QFormLayout(box)
        self.cmb_provider = QComboBox(box)
        for i, pid in enumerate(_PROVIDER_IDS):
            d = ai_client.PROVIDERS[pid]
            self.cmb_provider.addItem(
                d.get("tag", "") + ai_client.tr_label(d["label"]), pid)
            tip = ai_client.PROVIDER_TAGS.get(d.get("tag"), "")
            if tip:
                self.cmb_provider.setItemData(
                    i, d["tag"] + " " + ai_client.tr_label(tip),
                    Qt.ItemDataRole.ToolTipRole)
        self.ed_endpoint = QLineEdit(box)
        self.ed_key = QLineEdit(box)
        self.ed_key.setEchoMode(QLineEdit.EchoMode.Password)
        self.lbl_keystore = QLabel(credential_store.backend_label(), box)
        self.lbl_keystore.setStyleSheet("color:#666; font-size:11px")
        self.lbl_keystore.setWordWrap(True)
        self.cmb_model = QComboBox(box)
        self.cmb_model.setEditable(True)
        self.cmb_model.setToolTip(self.tr(
            "Model to use. Press \"Fetch\" to list models from the "
            "endpoint.\n"
            "Values in parentheses are prices per 1M tokens "
            "(input/output, $).\n"
            "Models in the \"Text (image input)\" group support sending "
            "screenshots."))
        model_row = QWidget(box)
        mr = QHBoxLayout(model_row)
        mr.setContentsMargins(0, 0, 0, 0)
        self.btn_models = QPushButton(self.tr("Fetch"), model_row)
        self.btn_models.setToolTip(self.tr(
            "Fetch the model list from the endpoint "
            "(GET {base}/models)"))
        mr.addWidget(self.cmb_model, 1)
        mr.addWidget(self.btn_models)
        self.lbl_model_info = QLabel(
            QCoreApplication.translate("dsh_qgis_driver", _MODEL_HINT),
            box)
        self.lbl_model_info.setStyleSheet("color:#666; font-size:11px")
        self.lbl_model_info.setWordWrap(True)
        self.chk_confirm = QCheckBox(
            self.tr("Confirm before running tools"), box)
        self.chk_confirm.setToolTip(self.tr(
            "When ON, asks for approval before each tool call.\n"
            "Use this if you do not want arbitrary code execution "
            "(pyeval) to run automatically."))
        # Agents (instructions injected into every request, ~/.qgis-live/agents/*.md)
        agent_row = QWidget(box)
        ar = QHBoxLayout(agent_row)
        ar.setContentsMargins(0, 0, 0, 0)
        self.cmb_agent = QComboBox(box)
        self.cmb_agent.setToolTip(self.tr(
            "Instruction document (agent) injected on every request.\n"
            "Lists ~/.qgis-live/agents/*.md. Use \"Edit\" to create or "
            "modify."))
        self.btn_agent_edit = QPushButton(self.tr("Edit"), agent_row)
        self.btn_agent_edit.setToolTip(self.tr(
            "Create, edit, or delete agent instructions (.md)"))
        ar.addWidget(self.cmb_agent, 1)
        ar.addWidget(self.btn_agent_edit)
        form.addRow(self.tr("Agent"), agent_row)
        # Skills (on-demand procedures in ~/.qgis-live/skills/*.md.
        # They all appear in the prompt list, so they are listed, not selected)
        skill_row = QWidget(box)
        sk = QHBoxLayout(skill_row)
        sk.setContentsMargins(0, 0, 0, 0)
        self.cmb_skill = QComboBox(box)
        self.cmb_skill.setToolTip(self.tr(
            "On-demand instruction documents. All entries appear in the "
            "prompt list,\n"
            "and the model reads the body via qgis_pyeval's open() when "
            "needed.\n"
            "Lists ~/.qgis-live/skills/*.md. Use \"Edit\" to create or "
            "modify."))
        self.btn_skill_edit = QPushButton(self.tr("Edit"), skill_row)
        self.btn_skill_edit.setToolTip(self.tr(
            "Create, edit, or delete skill instructions (.md)"))
        sk.addWidget(self.cmb_skill, 1)
        sk.addWidget(self.btn_skill_edit)
        form.addRow(self.tr("Skill"), skill_row)
        # OAuth device-flow row, shown only when Copilot is selected
        self.w_signin = QWidget(box)
        sr = QHBoxLayout(self.w_signin)
        sr.setContentsMargins(0, 0, 0, 0)
        self.btn_signin = QPushButton(
            self.tr("Sign in with GitHub"), self.w_signin)
        self.btn_signin.setToolTip(self.tr(
            "Acquires a GitHub token via the OAuth device flow and sets "
            "it in the API key field.\n"
            "Enter the displayed code in the browser "
            "(github.com/login/device).\n"
            "Requires an account with a GitHub Copilot subscription."))
        sr.addWidget(self.btn_signin)
        lbl = QLabel(
            self.tr("GitHub account with a Copilot subscription"),
            self.w_signin)
        lbl.setStyleSheet("color:#666; font-size:11px")
        sr.addWidget(lbl, 1)
        self.w_signin.setVisible(False)
        prov_row = QWidget(box)
        pr = QHBoxLayout(prov_row)
        pr.setContentsMargins(0, 0, 0, 0)
        pr.addWidget(self.cmb_provider, 1)
        btn_prov_help = QPushButton("?", prov_row)
        btn_prov_help.setFixedWidth(24)
        btn_prov_help.setToolTip(
            self.tr("Explain the provider type tags 【API】/【ACP】/【Bridge】"))
        btn_prov_help.clicked.connect(self._provider_help)
        pr.addWidget(btn_prov_help)
        form.addRow(self.tr("Provider"), prov_row)
        form.addRow(self.tr("Endpoint"), self.ed_endpoint)
        form.addRow(self.tr("API key"), self.ed_key)
        form.addRow("", self.w_signin)
        form.addRow(self.tr("Key storage"), self.lbl_keystore)
        form.addRow(self.tr("Model"), model_row)
        form.addRow("", self.lbl_model_info)
        form.addRow("", self.chk_confirm)
        lay.addWidget(box)
        self.box_api = box

        # ---- Chat history ----
        crow = QHBoxLayout()
        self.btn_settings = QPushButton("⚙", root)
        self.btn_settings.setCheckable(True)
        self.btn_settings.setFixedWidth(32)
        self.btn_settings.setToolTip(self.tr(
            "Toggle visibility of the API settings"))
        crow.addWidget(self.btn_settings)
        self.btn_newchat = QPushButton(self.tr("New chat"), root)
        self.btn_newchat.setToolTip(self.tr(
            "Saves the current chat to history and starts a new one.\n"
            "The context (conversation history) is also reset."))
        self.cmb_chats = QComboBox(root)
        self.cmb_chats.setToolTip(self.tr(
            "Past chats. Select one to review it or continue the "
            "conversation."))
        self.cmb_chats.addItem(self.tr("Current chat"))
        crow.addWidget(self.btn_newchat)
        crow.addWidget(self.cmb_chats, 1)
        self.btn_chat_export = QPushButton("↓", root)
        self.btn_chat_export.setFixedWidth(26)
        self.btn_chat_export.setToolTip(self.tr(
            "Save the displayed chat to a Markdown file"))
        self.btn_chat_del = QPushButton("✕", root)
        self.btn_chat_del.setFixedWidth(26)
        self.btn_chat_del.setEnabled(False)
        self.btn_chat_del.setToolTip(self.tr(
            "Delete the displayed history chat (the current chat is "
            "excluded)"))
        crow.addWidget(self.btn_chat_export)
        crow.addWidget(self.btn_chat_del)
        lay.addLayout(crow)

        # ---- Chat display ----
        self.view = QTextBrowser(root)
        self.view.setOpenExternalLinks(True)
        # Prevent tool output in pre blocks (no wrapping) or long code blocks from
        # inflating the document sizeHint and widening the dock on its own.
        # Ignore sizeHint horizontally and leave the overflow to the view's
        # horizontal scrolling.
        self.view.setSizePolicy(
            QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Expanding)
        lay.addWidget(self.view, 1)

        # ---- Attached images (paste, drag & drop, or the attach button) ----
        self.attach_row = QWidget(root)
        ah = QHBoxLayout(self.attach_row)
        ah.setContentsMargins(0, 0, 0, 0)
        ah.setSpacing(4)
        ah.addStretch(1)
        self.attach_row.setVisible(False)
        lay.addWidget(self.attach_row)

        # ---- Input row ----
        self.input = _Input(root)
        self._input_hint = self.tr(
            "Enter instructions (Enter to send / Shift+Enter for a new "
            "line / Ctrl+V or drag & drop to attach images).\n"
            "Use /agent and /skill to edit instructions directly "
            "(/help)")
        self.input.set_hint(self._input_hint)
        self.input.setMaximumHeight(64)
        lay.addWidget(self.input)

        row = QHBoxLayout()
        self.cmb_prompt = QComboBox(root)
        self.cmb_prompt.setMaximumWidth(170)
        self.cmb_prompt.setToolTip(self.tr(
            "Suggested prompts: picking one inserts the prompt text "
            "into the input field.\n"
            "Lists bundled <plugin>/prompts/*.md and user "
            "~/.qgis-live/prompts/*.md.\n"
            "Edit them via /prompt or the instruction editor."))
        self.cmb_prompt.activated.connect(self._on_prompt_activated)
        row.addWidget(self.cmb_prompt)
        self.btn_prompt_edit = QPushButton("✎", root)
        self.btn_prompt_edit.setFixedWidth(30)
        self.btn_prompt_edit.setToolTip(self.tr(
            "Create, edit, or delete suggested prompts (.md)"))
        self.btn_prompt_edit.clicked.connect(self._edit_prompts)
        row.addWidget(self.btn_prompt_edit)
        self.btn_attach = QPushButton("📎", root)
        self.btn_attach.setFixedWidth(30)
        self.btn_attach.setToolTip(self.tr(
            "Attach and send an image file.\n"
            "You can also paste (Ctrl+V) or drag & drop into the input "
            "field."))
        row.addWidget(self.btn_attach)
        self.btn_send = QPushButton(self.tr("Send"), root)
        self.btn_send.setToolTip(self.tr(
            "Enter also sends. While sending it changes to \"Abort\" "
            "and\n"
            "stops the ongoing round trip (in-flight API responses/"
            "tool executions cannot be interrupted)."))
        self.btn_retry = QPushButton(self.tr("Retry"), root)
        self.btn_retry.setEnabled(False)
        self.btn_retry.setToolTip(self.tr(
            "Discard the last question and its response, then resend"))
        self.btn_clear = QPushButton(self.tr("Clear history"), root)
        self.lbl_status = QLabel("", root)
        row.addWidget(self.btn_send)
        row.addWidget(self.btn_retry)
        row.addWidget(self.btn_clear)
        row.addWidget(self.lbl_status, 1)
        self.lbl_ctx = QLabel("", root)
        self.lbl_ctx.setStyleSheet("color:#666; font-size:11px")
        self.lbl_ctx.setToolTip(self.tr(
            "ctx: context usage (measured prompt_tokens from the last "
            "API response;\n"
            "if unavailable, an estimate marked with ~ using "
            "chars/3). The right value is the model limit.\n"
            "Σ: total tokens for this chat. $: estimated cost (when "
            "pricing info is available)"))
        row.addWidget(self.lbl_ctx)
        lay.addLayout(row)

        self.setWidget(root)
        self._load_settings()
        self._restore_chats()
        self._snapshot_fields()

        self.cmb_provider.currentIndexChanged.connect(
            self._on_provider_changed)
        self.cmb_model.activated.connect(self._on_model_activated)
        self.cmb_model.currentTextChanged.connect(
            self._on_model_text_changed)
        self.btn_models.clicked.connect(self._fetch_models)
        self.btn_send.clicked.connect(self._send_or_abort)
        self.btn_retry.clicked.connect(self._retry)
        self.btn_clear.clicked.connect(self._clear)
        self.btn_newchat.clicked.connect(self._new_chat)
        self.cmb_chats.activated.connect(self._switch_chat)
        self.btn_chat_export.clicked.connect(self._export_chat)
        self.btn_chat_del.clicked.connect(self._delete_chat)
        self.btn_settings.toggled.connect(self._on_settings_toggled)
        self.btn_agent_edit.clicked.connect(self._edit_agent)
        self.cmb_agent.activated.connect(self._on_agent_activated)
        self.btn_skill_edit.clicked.connect(self._edit_skills)
        self.input.sig_submit.connect(self._send)
        self.input.sig_images.connect(self._on_pasted_images)
        self.btn_attach.clicked.connect(self._attach_files)
        self.input.textChanged.connect(self._refresh_send_button)
        self._refresh_send_button()
        self.sig_append.connect(self._append)
        self.sig_instructions.connect(self._refresh_instructions)
        self.sig_agent_changed.connect(self._on_agent_changed)
        self.sig_confirm.connect(self._on_confirm)
        self.sig_status.connect(self.lbl_status.setText)
        self.sig_busy.connect(self._set_busy)
        self.sig_models.connect(self._on_models)
        self.btn_signin.clicked.connect(self._signin)
        self.sig_signin.connect(self._on_signin)
        self.sig_open_url.connect(
            lambda u: QDesktopServices.openUrl(QUrl(u)))

    def _provider_help(self):
        """The "?" button: explain how [API], [ACP] and [Bridge] differ."""
        lines = []
        for tag in ("【API】", "【Bridge】", "【ACP】"):
            names = [ai_client.tr_label(ai_client.PROVIDERS[p]["label"])
                     for p in _PROVIDER_IDS
                     if ai_client.PROVIDERS[p].get("tag") == tag]
            lines.append(
                f"{tag} {', '.join(names)}\n"
                f"　{ai_client.tr_label(ai_client.PROVIDER_TAGS[tag])}")
        QMessageBox.information(
            self, self.tr("Provider types"), "\n\n".join(lines))

    # ---- Settings persistence ----

    def _provider(self):
        return self.cmb_provider.currentData() or "openai"

    def _load_settings(self):
        s = QSettings()
        pid = s.value(_SETTING.format("provider"), "openai")
        idx = (_PROVIDER_IDS.index(pid) if pid in _PROVIDER_IDS else 0)
        self.cmb_provider.setCurrentIndex(idx)
        self._load_provider_fields()
        self.chk_confirm.setChecked(
            str(s.value(_SETTING.format("confirm"), "false")).lower()
            in ("1", "true"))
        # API settings visibility: on first run with no saved value,
        # open when the key is unset, collapse when it is already set
        v = s.value(_SETTING.format("settings_visible"), None)
        if v is None:
            v = not credential_store.get_secret(f"ai_{pid}_api_key")
        else:
            v = str(v).lower() in ("1", "true")
        self.btn_settings.setChecked(bool(v))
        self.box_api.setVisible(self.btn_settings.isChecked())
        self._refresh_agents(s.value(_SETTING.format("agent"), ""))
        self._refresh_skills()
        self._refresh_prompts()

    def _on_settings_toggled(self, on):
        self.box_api.setVisible(on)
        QSettings().setValue(_SETTING.format("settings_visible"), on)

    # ---- Agents (instructions injected on every request) ----

    def _refresh_agents(self, select_id=None):
        """Rebuild the agent combo from ~/.qgis-live/agents/*.md."""
        cur = (select_id if select_id is not None
               else self.cmb_agent.currentData())
        self.cmb_agent.blockSignals(True)
        self.cmb_agent.clear()
        self.cmb_agent.addItem(self.tr("(none)"), None)
        for a in ai_client.list_agents():
            self.cmb_agent.addItem(a["title"], a["id"])
            tip = a["path"]
            if a.get("when"):
                tip = f"use_when: {a['when']}\n" + tip
            if a.get("desc"):
                tip = a["desc"] + "\n" + tip
            self.cmb_agent.setItemData(
                self.cmb_agent.count() - 1, tip,
                Qt.ItemDataRole.ToolTipRole)
        idx = self.cmb_agent.findData(cur)
        self.cmb_agent.setCurrentIndex(idx if idx >= 0 else 0)
        self.cmb_agent.blockSignals(False)

    def _on_agent_activated(self, _idx):
        QSettings().setValue(_SETTING.format("agent"),
                             self.cmb_agent.currentData() or "")
        self._update_ctx_label()

    def _edit_agent(self):
        self._open_instruction_editor(
            "agents", self.cmb_agent.currentData())

    # ---- Skills (on-demand procedures; all listed, no selection needed) ----

    def _refresh_skills(self):
        """Rebuild the skill combo from ~/.qgis-live/skills/*.md plus the bundled ones."""
        cur = self.cmb_skill.currentData()
        self.cmb_skill.blockSignals(True)
        self.cmb_skill.clear()
        skills = ai_client.list_skills()
        if not skills:
            self.cmb_skill.addItem(self.tr("(none)"), None)
        for s in skills:
            label = s["title"] + (self.tr(" (bundled)")
                                  if s["builtin"] else "")
            self.cmb_skill.addItem(label, s["id"])
            tip = s["path"]
            if s.get("when"):
                tip = f"use_when: {s['when']}\n" + tip
            if s.get("desc"):
                tip = s["desc"] + "\n" + tip
            self.cmb_skill.setItemData(
                self.cmb_skill.count() - 1, tip,
                Qt.ItemDataRole.ToolTipRole)
        idx = self.cmb_skill.findData(cur)
        self.cmb_skill.setCurrentIndex(idx if idx >= 0 else 0)
        self.cmb_skill.blockSignals(False)

    def _edit_skills(self):
        self._open_instruction_editor(
            "skills", self.cmb_skill.currentData())

    # ---- Suggested prompts (canned text inserted into the input field) ----

    def _refresh_prompts(self):
        """Rebuild the prompt combo from each plugin's bundled prompts and
        ~/.qgis-live/prompts/. The first entry is a placeholder (inserts on pick)."""
        self.cmb_prompt.blockSignals(True)
        self.cmb_prompt.clear()
        self.cmb_prompt.addItem(self.tr("Suggested…"), None)
        for s in ai_client.list_prompts():
            label = s["title"] + (self.tr(" (bundled)")
                                  if s["builtin"] else "")
            self.cmb_prompt.addItem(label, s["id"])
            tip = s["path"]
            if s.get("desc"):
                tip = s["desc"] + "\n" + tip
            self.cmb_prompt.setItemData(
                self.cmb_prompt.count() - 1, tip,
                Qt.ItemDataRole.ToolTipRole)
        self.cmb_prompt.setCurrentIndex(0)
        self.cmb_prompt.blockSignals(False)

    def _on_prompt_activated(self, idx):
        """A suggested prompt was picked -> insert its body into the input field."""
        pid = self.cmb_prompt.itemData(idx)
        self.cmb_prompt.setCurrentIndex(0)
        if not pid:
            return
        body = ai_client.prompt_body(pid)
        if body is None:
            return
        self.input.setPlainText(body)
        self.input.setFocus()

    def _edit_prompts(self):
        self._open_instruction_editor(
            "prompts", self.cmb_prompt.currentData())

    # ---- Instruction editing ----
    # The "Edit" dialog is non-modal. While it is open the chat input stays
    # usable, and the prompt field inside the dialog can ask the AI to revise
    # the body (the AI's ai_save_instruction save is detected via
    # sig_instructions and mirrored into the open dialog's editor).

    def _open_instruction_editor(self, kind, select):
        """Open the instruction editor dialog (non-modal)."""
        dlg = self._instr_dlg
        if dlg is not None:
            # If it is already open, switch kind/target and raise it
            i = dlg.cmb_kind.findData(kind)
            if i >= 0:
                dlg.cmb_kind.setCurrentIndex(i)
                dlg.reload(select)
            dlg.show()
            dlg.raise_()
            dlg.activateWindow()
            return
        dlg = _InstructionsDialog(self, kind=kind, select=select)
        self._instr_dlg = dlg
        dlg.finished.connect(
            lambda _r: self._close_instruction_editor())
        dlg.show()

    def _close_instruction_editor(self):
        """Drop the reference when the dialog closes and rebuild the combos."""
        dlg = self._instr_dlg
        self._instr_dlg = None
        if dlg is not None:
            dlg.deleteLater()
        self._refresh_instructions()

    def _refresh_instructions(self):
        """Rebuild the combos after an ai_* tool updated an instruction."""
        self._refresh_agents()
        self._refresh_skills()
        self._refresh_prompts()
        if self._instr_dlg is not None:
            self._instr_dlg.refresh_external()

    def _on_agent_changed(self, aid):
        """The agent selected by ai_select_agent changed."""
        idx = self.cmb_agent.findData(aid or None)
        self.cmb_agent.setCurrentIndex(idx if idx >= 0 else 0)
        QSettings().setValue(_SETTING.format("agent"), aid or "")
        self._update_ctx_label()

    def _load_provider_fields(self):
        """Load the saved values of the current provider (defaults if none) into the fields."""
        s = QSettings()
        pid = self._provider()
        d = ai_client.PROVIDERS[pid]
        self.w_signin.setVisible(pid == "copilot")
        # Migration from the old key (no provider): read it when the new key is absent

        def legacy(k, dv):
            return (
                s.value(_SETTING.format(f"{pid}_{k}"), None)
                if s.value(_SETTING.format(f"{pid}_{k}"), None) is not None
                else s.value(_SETTING.format(k), dv))
        ep = legacy("endpoint", d["base"]) if pid == "openai" \
            else s.value(_SETTING.format(f"{pid}_endpoint"), d["base"])
        # Prefer the OS credential store for the API key;
        # otherwise read the legacy QSettings plaintext value (migration source)
        key = credential_store.get_secret(f"ai_{pid}_api_key")
        if key is None:
            key = (legacy("api_key", "") if pid == "openai"
                   else s.value(_SETTING.format(f"{pid}_api_key"), ""))
        model = legacy("model", d["model"]) if pid == "openai" \
            else s.value(_SETTING.format(f"{pid}_model"), d["model"])
        self.ed_endpoint.setText(ep)
        self.ed_endpoint.setPlaceholderText(
            ai_client.tr_label(d["endpoint_hint"]))
        self.ed_key.setText(key)
        self.ed_key.setPlaceholderText(
            ai_client.tr_label(d["key_hint"]))
        self.cmb_model.clear()
        # For the default endpoint, preload the recommended models (with kind and
        # reference price) into the combo. Custom endpoints (Ollama etc.) expose a
        # different list, so leave it empty and use "Fetch" for the real list.
        if ep == d["base"]:
            infos = [ai_client.model_info({"id": m})
                     for m in ai_client.SUGGESTED_MODELS.get(pid, ())]
            self._set_model_items(infos, keep_text=model)
        else:
            self._model_infos = {}
        self.cmb_model.setEditText(model)
        self.cmb_model.lineEdit().setPlaceholderText(d["model"])
        self._update_model_info()

    def _save_settings(self):
        s = QSettings()
        pid = self._provider()
        s.setValue(_SETTING.format("provider"), pid)
        s.setValue(_SETTING.format(f"{pid}_endpoint"),
                   self.ed_endpoint.text())
        self._save_provider_key(pid, self.ed_key.text())
        s.setValue(_SETTING.format(f"{pid}_model"),
                   self._current_model())
        s.setValue(_SETTING.format("confirm"),
                   self.chk_confirm.isChecked())

    def _save_provider_key(self, pid, key):
        """Save the API key into the OS credential store.

        Never leave plaintext in QSettings, under any circumstance. If the store
        write fails, show an error (no plaintext fallback).
        The field keeps its value, so sending works within this session,
        but the key must be re-entered on the next start.
        """
        s = QSettings()
        name = f"ai_{pid}_api_key"
        if key:
            ok = credential_store.set_secret(name, key)
        else:
            ok = credential_store.delete_secret(name)
        s.remove(_SETTING.format(f"{pid}_api_key"))
        if ok:
            s.setValue(_SETTING.format(f"{pid}_key_store"),
                       credential_store.backend())
        else:
            s.remove(_SETTING.format(f"{pid}_key_store"))
            self._append(
                "error",
                self.tr(
                    "Could not save the API key to the OS credential "
                    "store (backend={0}). It is not saved in plain "
                    "text. The entered key can be used in this "
                    "session, but you will need to re-enter it next "
                    "time.")
                .format(credential_store.backend()))
        return ok

    def _on_provider_changed(self, _idx):
        """Save the previous provider's input values and load the new provider's.

        At currentIndexChanged time the combo already points at the new provider,
        so the previous provider must be kept beforehand.
        """
        self._signin_abort = True  # stop any device flow in progress
        prev = getattr(self, "_prev_provider", None)
        if prev is not None and prev != self._provider():
            s = QSettings()
            s.setValue(_SETTING.format(f"{prev}_endpoint"),
                       self._prev_endpoint)
            self._save_provider_key(prev, self._prev_key)
            s.setValue(_SETTING.format(f"{prev}_model"),
                       self._prev_model)
        self._load_provider_fields()
        self._snapshot_fields()

    def _snapshot_fields(self):
        self._prev_provider = self._provider()
        self._prev_endpoint = self.ed_endpoint.text()
        self._prev_key = self.ed_key.text()
        self._prev_model = self._current_model()

    # ---- Model selection ----

    def _current_model(self):
        """Model ID of the selection. Returns just the ID even when
        decorated text ("id   $x/$y") or group headers are present."""
        data = self.cmb_model.currentData()
        t = self.cmb_model.currentText().strip()
        # Trust itemData only when the display text equals that item's ID
        # (if the text is rewritten after selection, currentIndex may point at an old item)
        if data and (not t or t == str(data)):
            return str(data)
        if not t or t.startswith("──"):
            return ""
        # Model IDs contain no spaces, so strip the decoration (2+ spaces and price)
        return re.split(r"\s{2,}", t, maxsplit=1)[0].strip()

    def _set_model_items(self, infos, keep_text=None):
        """Rebuild the model combo with kind group headers.

        @returns number of models configured
        """
        cur = (keep_text if keep_text is not None
               else self._current_model())
        self._model_infos = {i["id"]: i for i in infos}
        mdl = QStandardItemModel(self.cmb_model)
        n = 0
        for kind, label in ai_client.MODEL_KINDS:
            entries = [i for i in infos if i["kind"] == kind]
            if not entries:
                continue
            hdr = QStandardItem(f"── {ai_client.tr_label(label)} ──")
            hdr.setEnabled(False)          # non-selectable header row
            f = hdr.font()
            f.setBold(True)
            hdr.setFont(f)
            mdl.appendRow(hdr)
            for i in entries:
                it = QStandardItem(ai_client.model_label(i))
                it.setData(i["id"], Qt.ItemDataRole.UserRole)
                it.setToolTip(ai_client.model_tooltip(i))
                mdl.appendRow(it)
                n += 1
        self.cmb_model.setModel(mdl)
        idx = self.cmb_model.findData(cur) if cur else -1
        if cur and idx >= 0:
            self.cmb_model.setCurrentIndex(idx)
            self.cmb_model.setEditText(cur)  # show only the ID in the line edit
        elif cur:
            self.cmb_model.setEditText(cur)
        self._update_model_info()
        return n

    def _on_model_activated(self, idx):
        """On item selection, leave only the undecorated ID in the line edit."""
        data = self.cmb_model.itemData(idx)
        if data:
            self.cmb_model.setEditText(str(data))

    def _on_model_text_changed(self, _text):
        self._update_model_info()

    def _model_supports_images(self):
        """Whether the selected model is assumed to accept image input.

        Prefer the kind from the fetched list (_model_infos); unknown
        manually typed models fall back to classify_model's name hints.
        """
        if self._provider() in ("devin_acp", "copilot_acp"):
            return True  # ACP promptCapabilities.image=true
        mid = (self._current_model()
               or ai_client.PROVIDERS[self._provider()]["model"])
        info = self._model_infos.get(mid)
        kind = (info["kind"] if info
                else ai_client.classify_model(mid))
        return kind == "chat_vision"

    def _update_model_info(self):
        """Show the selected model's kind, price and so on below the model field."""
        ok_img = self._model_supports_images()
        self.btn_attach.setEnabled(ok_img)
        self.btn_attach.setToolTip(
            self.tr(
                "Attach and send an image file.\n"
                "You can also paste (Ctrl+V) or drag & drop into the "
                "input field.")
            if ok_img else
            self.tr(
                "The selected model does not support image input, so "
                "attachments are unavailable.\n"
                "Select a model from the \"Text (image input)\" "
                "group."))
        info = self._model_infos.get(self._current_model())
        if not info:
            self.lbl_model_info.setText(
                QCoreApplication.translate(
                    "dsh_qgis_driver", _MODEL_HINT))
            self._update_ctx_label()
            return
        parts = [ai_client.tr_label(ai_client.MODEL_KIND_LABELS.get(
            info["kind"], info["kind"]))]
        if info.get("price_desc"):
            src = ("API" if info["price_src"] == "api"
                   else self.tr("ref"))
            parts.append(f"{info['price_desc']} ({src})")
        ctx = ai_client.fmt_tokens(info.get("context"))
        if ctx:
            parts.append(self.tr("context {0}").format(ctx))
        if info["kind"] == "chat":
            parts.append(self.tr(
                "may not support image input (select a \"Text (image "
                "input)\" model to send images)"))
        elif info["kind"] != "chat_vision":
            parts.append(self.tr("not usable for chat"))
        self.lbl_model_info.setText(" / ".join(parts))
        self._update_ctx_label()   # the limit label depends on the model

    # ---- Display ----

    _STYLE = {
        "user": "#0759c7",
        "assistant": "#222222",
        "tool": "#666666",
        "cmd": "#666666",
        "error": "#b00020",
    }

    def _append(self, kind, text):
        color = self._STYLE.get(kind, "#222")
        label = {"user": self.tr("you"), "assistant": "AI",
                 "tool": "tool", "cmd": "cmd",
                 "error": "error"}.get(kind, kind)
        if kind == "assistant":
            # AI replies are rendered as Markdown (tables, code blocks, headings, and so on)
            body = f"<div style='color:{color}'>{_md(text)}</div>"
        elif kind == "tool":
            body = (f"<span style='color:{color}'>"
                    f"<pre style='margin:2px 0'>{_esc(text)}</pre></span>")
        else:
            body = f"<span style='color:{color}'>{_esc(text)}</span>"
        self.view.append(
            f"<div style='margin:6px 0'>"
            f"<b style='color:{color}'>[{label}]</b> {body}</div>")

    def _set_busy(self, busy):
        self._busy = busy
        self.input.setEnabled(not busy)
        self._refresh_send_button()
        self.btn_retry.setEnabled(not busy and bool(self._history))
        self.btn_chat_export.setEnabled(not busy)
        if busy:
            self.lbl_status.setText(self.tr("Running…"))
        if not busy:
            self._update_ctx_label()   # a finished round trip = history is final

    def _refresh_send_button(self):
        """Reflect the state on the send button.

        While running it shows the stop-colored "Abort"; while idle, "Send",
        disabled while the input is empty to signal that input is awaited.
        """
        if self._busy:
            self.btn_send.setText(self.tr("■ Abort"))
            self.btn_send.setStyleSheet(
                "background:#b03a2e; color:white;")
            self.btn_send.setEnabled(True)
        else:
            self.btn_send.setText(self.tr("Send"))
            self.btn_send.setStyleSheet("")
            self.btn_send.setEnabled(
                bool(self.input.toPlainText().strip())
                or bool(self._attachments))

    # ---- Attached images ----
    # Images added by paste, drag & drop or the attach button are normalized
    # to PNG, saved to temp, and shown as thumbnail chips above the input
    # field. They are bundled into the user message on send and kept in
    # history (shown and resendable only while the temp file survives).

    _ATTACH_MAX_SIDE = 2048   # long-side cap for attachments (saves tokens)

    def _add_attachment(self, src):
        """Normalize an image (QImage/QPixmap/file path) to PNG into the attachment row."""
        if not self._model_supports_images():
            self._append(
                "error",
                self.tr(
                    "The selected model does not support image input, "
                    "so attachments are unavailable (select a model "
                    "from the \"Text (image input)\" group)"))
            return
        if isinstance(src, str):
            img = QImage(src)
        elif isinstance(src, QPixmap):
            img = src.toImage()
        else:
            img = src
        if img is None or img.isNull():
            self._append("error",
                         self.tr("Cannot read as an image: {0}")
                         .format(src if isinstance(src, str)
                                 else self.tr("(pasted image)")))
            return
        if max(img.width(), img.height()) > self._ATTACH_MAX_SIDE:
            img = img.scaled(
                self._ATTACH_MAX_SIDE, self._ATTACH_MAX_SIDE,
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation)
        path = ai_client.attachment_temp_path()
        if not img.save(path, "PNG"):
            self._append("error", self.tr(
                "Failed to save the attached image: {0}").format(path))
            return
        self._attachments.append(path)
        chip = QFrame(self.attach_row)
        chip.setFrameShape(QFrame.Shape.StyledPanel)
        cl = QHBoxLayout(chip)
        cl.setContentsMargins(2, 2, 2, 2)
        cl.setSpacing(2)
        thumb = QLabel(chip)
        thumb.setPixmap(QPixmap.fromImage(img).scaled(
            220, 44,
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation))
        thumb.setToolTip(path)
        cl.addWidget(thumb)
        btn = QPushButton("✕", chip)
        btn.setFixedSize(18, 18)
        btn.setToolTip(self.tr("Remove this image"))
        cl.addWidget(btn, 0, Qt.AlignmentFlag.AlignTop)
        btn.clicked.connect(
            lambda _c, p=path, w=chip: self._remove_attachment(p, w))
        lay = self.attach_row.layout()
        lay.insertWidget(lay.count() - 1, chip)  # just before the stretch
        self.attach_row.setVisible(True)
        self._refresh_send_button()

    def _remove_attachment(self, path, chip):
        try:
            self._attachments.remove(path)
        except ValueError:  # nosec B110  # acceptable by design
            pass
        chip.deleteLater()
        if not self._attachments:
            self.attach_row.setVisible(False)
        self._refresh_send_button()

    def _clear_attachments(self):
        self._attachments = []
        lay = self.attach_row.layout()
        while lay.count() > 1:        # keep only the trailing stretch
            w = lay.takeAt(0).widget()
            if w is not None:
                w.deleteLater()
        self.attach_row.setVisible(False)

    def _on_pasted_images(self, sources):
        for s in sources:
            self._add_attachment(s)

    def _attach_files(self):
        paths, _ = QFileDialog.getOpenFileNames(
            self, self.tr("Attach image"), "",
            self.tr("Image files (*.png *.jpg *.jpeg *.gif *.bmp *.webp"
                    " *.tif *.tiff)"))
        for p in paths:
            self._add_attachment(p)

    def _append_image(self, path):
        """Show the sent attachment images in the chat view (local img tags)."""
        url = QUrl.fromLocalFile(path).toString()
        self.view.append(
            f"<div style='margin:2px 0 6px 0'>"
            f"<img src='{html.escape(url)}' width='240'></div>")

    def _update_ctx_label(self):
        """Show context usage and cumulative tokens/cost at the bottom right."""
        # ctx: measured from the last API reply's prompt_tokens, else estimated from chars
        actual = self._usage.get("last", 0)
        if actual:
            est, mark = actual, ""
        else:
            try:
                chars = len(self._build_system(
                    self._plugins, self.cmb_agent.currentData()))
            except Exception:
                chars = 0
            chars += sum(len(m.get("content") or "")
                         for m in self._history)
            est, mark = chars // 3, "~"  # midpoint between Japanese (~1.5) and English (~4)
        info = self._model_infos.get(self._current_model()) or {}
        lim = info.get("context")
        parts = [f"ctx {mark}{ai_client.fmt_tokens(est)}"
                 + (f"/{ai_client.fmt_tokens(lim)}"
                    f" ({est * 100 // lim}%)" if lim else "")]
        # Total: shown only when the API returns usage. Cost too when the price is known
        total = self._usage["in"] + self._usage["out"]
        if total:
            parts.append(f"Σ{ai_client.fmt_tokens(total)}")
            cost = ai_client.usage_cost(info, self._usage)
            if cost is not None:
                parts.append(f"${cost:.4f}" if cost < 1
                             else f"${cost:.2f}")
        self.lbl_ctx.setText(" · ".join(parts))

    def _clear(self):
        self._history.clear()
        self.view.clear()
        self._update_ctx_label()

    # ---- Chat history ----

    def _chat_title(self, history):
        """Build a title from the first user message."""
        for m in history:
            if m.get("role") == "user" and m.get("content"):
                t = m["content"].splitlines()[0].strip()
                return t[:30] + ("…" if len(t) > 30 else "")
        return self.tr("Chat {0}").format(len(self._sessions))

    def _save_open_chat(self):
        """Write the displayed chat state (history + display HTML) back to the session.

        toHtml() on an empty view returns a document with an empty body, so
        keep html empty when there is no display text
        (so an empty session is not archived by "New chat").
        """
        s = self._sessions[self._open_chat]
        s["history"] = self._history
        s["html"] = (self.view.toHtml()
                     if self.view.toPlainText().strip() else "")
        s["agent"] = self.cmb_agent.currentData()
        s["usage"] = self._usage

    def _load_chat(self, idx):
        """Make a session the displayed one (updates history, HTML and agent)."""
        s = self._sessions[idx]
        self._history = s["history"]
        self.view.setHtml(s["html"])
        ai = self.cmb_agent.findData(s.get("agent"))
        self.cmb_agent.setCurrentIndex(ai if ai >= 0 else 0)
        self._usage = dict(s.get("usage")
                           or {"in": 0, "out": 0, "last": 0})
        self._open_chat = idx
        # "Current chat" (0) is not deletable
        self.btn_chat_del.setEnabled(idx > 0)
        self._update_ctx_label()

    def _new_chat(self):
        """Save the current chat into history and start a new chat.

        Usable while a past chat is displayed: saves that display state and then
        opens a new "current chat". If the current chat is empty it just
        returns to that view.
        """
        self._save_open_chat()
        live = self._sessions[0]
        if live["history"] or live["html"]:
            live["title"] = self._chat_title(live["history"])
            self._sessions.append(live)
            self.cmb_chats.addItem(live["title"])
            self._sessions[0] = {"title": self.tr("Current chat"),
                                 "history": [], "html": "", "agent": None}
        self._load_chat(0)
        self.cmb_chats.setCurrentIndex(0)

    def _switch_chat(self, idx):
        """History combo selection: save the displayed chat, then open the picked one."""
        if idx == self._open_chat or idx >= len(self._sessions):
            return
        self._save_open_chat()
        self._load_chat(idx)
        self._persist_chats()

    def _chats_path(self):
        """Persistence target for chat history: ~/.qgis-live/chats.json."""
        return os.path.join(
            os.path.dirname(ai_client.agents_dir()), "chats.json")

    def _persist_chats(self):
        """Save archived chats (sessions[1:]) to the file."""
        try:
            data = self._sessions[1:][-50:]  # keep at most the latest 50
            with open(self._chats_path(), "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
        except Exception:  # nosec B110  # acceptable by design
            pass

    def _restore_chats(self):
        """Restore saved chats into the sessions and the combo at startup."""
        try:
            with open(self._chats_path(), "r", encoding="utf-8") as f:
                saved = json.load(f)
        except Exception:
            return
        if not isinstance(saved, list):
            return
        for s in saved:
            if not isinstance(s, dict) \
                    or ("history" not in s and "html" not in s):
                continue
            s.setdefault("title", self.tr("Chat"))
            s.setdefault("history", [])
            s.setdefault("html", "")
            s.setdefault("agent", None)
            self._sessions.append(s)
            self.cmb_chats.addItem(str(s["title"]))

    def _delete_chat(self):
        """Delete the displayed history chat and return to the current chat."""
        idx = self._open_chat
        if idx <= 0 or idx >= len(self._sessions):
            return  # the current chat (0) cannot be deleted
        del self._sessions[idx]
        self.cmb_chats.blockSignals(True)
        self.cmb_chats.removeItem(idx)
        self.cmb_chats.setCurrentIndex(0)
        self.cmb_chats.blockSignals(False)
        self._open_chat = -1        # fixed up by _load_chat
        self._load_chat(0)
        self._persist_chats()

    def _export_chat(self):
        """Save the displayed chat to a Markdown file."""
        doc = QTextDocument()
        doc.setHtml(self.view.toHtml())
        md = doc.toMarkdown()
        if not md.strip():
            self._append("error", self.tr("Nothing to save"))
            return
        title = self._sessions[self._open_chat].get("title") or "chat"
        path, _ = QFileDialog.getSaveFileName(
            self, self.tr("Save chat"), f"{title}.md",
            "Markdown (*.md)")
        if not path:
            return
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(md)
            self._append("tool", self.tr("Chat saved: {0}").format(path))
        except Exception as e:
            self._append("error", self.tr("Failed to save: {0}")
                         .format(e))

    def _on_destroyed(self):
        self._alive = False
        self._signin_abort = True
        ai_client.close_acp_sessions()

    def _emit(self, sig, *args):
        """Emit from worker threads. Ignored once the panel is gone."""
        if not self._alive:
            return
        try:
            sig.emit(*args)
        except RuntimeError:
            self._alive = False

    def hideEvent(self, e):
        self._save_settings()
        self._save_open_chat()
        self._persist_chats()
        super().hideEvent(e)

    # ---- Model list fetching ----

    def _fetch_models(self):
        """The "Fetch" button: pull the list from {base}/models."""
        pid = self._provider()
        base = (self.ed_endpoint.text().strip()
                or ai_client.PROVIDERS[pid]["base"])
        key = self.ed_key.text().strip()
        self.btn_models.setEnabled(False)
        self.lbl_status.setText(self.tr("Fetching model list…"))
        threading.Thread(
            target=self._models_run, args=(pid, base, key),
            daemon=True, name="qgis-ai-models").start()

    def _models_run(self, pid, base, key):
        try:
            infos = ai_client.list_model_infos(pid, base, key)
            self._emit(self.sig_models, infos, "")
        except Exception as e:
            self._emit(self.sig_models, [], str(e))

    def _on_models(self, infos, error):
        self.btn_models.setEnabled(True)
        self.lbl_status.setText("")
        if error:
            self._append("error", self.tr(
                "Failed to fetch the model list: {0}").format(error))
            return
        n = self._set_model_items(infos)
        self._append("tool", self.tr(
            "Fetched {0} model(s)").format(n))

    # ---- GitHub sign-in (OAuth device flow) ----

    def _signin(self):
        """'Sign in with GitHub': obtain a token through the device flow.

        The button is shown only when Copilot is selected. Polling runs on a worker
        thread; completion returns to the GUI thread through sig_signin.
        """
        self._signin_abort = False
        self.btn_signin.setEnabled(False)
        threading.Thread(target=self._signin_run, daemon=True,
                         name="qgis-ai-signin").start()

    def _signin_run(self):
        try:
            d = ai_client.github_device_code()
        except Exception as e:
            self._emit(self.sig_append, "error",
                       self.tr("Failed to get a device code for "
                               "sign-in: {0}").format(e))
            self._emit(self.sig_signin, "copilot", "")
            return
        uri = d.get("verification_uri") or "https://github.com/login/device"
        code = d["user_code"]
        self._emit(self.sig_append, "tool",
                   self.tr("GitHub sign-in: open {0} and enter code "
                           "{1}").format(uri, code))
        self._emit(self.sig_status,
                   self.tr("Entering code {0} on GitHub…")
                   .format(code))
        self._emit(self.sig_open_url, uri)
        interval = max(int(d.get("interval") or 5), 3)
        deadline = time.time() + int(d.get("expires_in") or 900)
        token = err = None
        while time.time() < deadline:
            if self._signin_abort or not self._alive:
                err = self.tr("Aborted")
                break
            time.sleep(interval)
            try:
                r = ai_client.github_poll_access_token(d["device_code"])
            except Exception as e:
                err = self.tr("Polling failed: {0}").format(e)
                break
            if r.get("access_token"):
                token = r["access_token"]
                break
            e = r.get("error")
            if e == "slow_down":
                interval += 5
            elif e != "authorization_pending":
                err = (f"{e}: {r.get('error_description') or ''}"
                       .rstrip(": "))
                break
        if token:
            self._emit(self.sig_append, "tool",
                       self.tr("GitHub sign-in completed. The token "
                               "was set in the API key field"))
        else:
            self._emit(self.sig_append, "error",
                       self.tr("GitHub sign-in: {0}")
                       .format(err or self.tr("Code expired")))
        self._emit(self.sig_status, "")
        self._emit(self.sig_signin, "copilot", token or "")

    def _on_signin(self, pid, token):
        """Device flow finished (GUI thread). Save the token into the key field."""
        self.btn_signin.setEnabled(True)
        if token and self._provider() == pid:
            self.ed_key.setText(token)
            self._save_provider_key(pid, token)
            self._snapshot_fields()

    # ---- Send / agent loop ----

    def _send_or_abort(self):
        """Send button: set the abort flag if a run is in progress."""
        if self._busy:
            self._abort = True
            prov = getattr(self, "_active_prov", None)
            abort = getattr(prov, "abort", None)
            if abort:
                try:
                    abort()  # devin_acp: interrupt the turn with session/cancel
                except Exception:  # nosec B110  # acceptable by design
                    pass
            self.lbl_status.setText(self.tr("Aborting…"))
            # Also change the button so the accepted abort request is visible
            self.btn_send.setText(self.tr("Aborting…"))
            self.btn_send.setEnabled(False)
            return
        self._send()

    def _retry(self):
        """Undo the last question+answer and resend the same question."""
        if self._busy or not self._history:
            return
        while self._history and self._history[-1]["role"] != "user":
            self._history.pop()
        if not self._history:
            return
        msg = self._history.pop()
        self.input.setPlainText(msg["content"])
        for p in msg.get("images") or []:
            if os.path.isfile(p):
                self._add_attachment(p)
        self._send()

    def _send(self):
        text = self.input.toPlainText().strip()
        images = list(self._attachments)
        if (not text and not images) or self._busy:
            return
        if text and self._chat_command(text):
            self.input.clear()
            return
        if self._send_prompt(text, images):
            self.input.clear()
            self._clear_attachments()

    def _send_prompt(self, text, images=None):
        """Send the user message to the API. True if sending started.

        images are attachment image paths (PNG). An image alone can be sent without text.
        Also called from "Ask AI to revise" in the instruction editor dialog.
        """
        if self._busy:
            self._append("error",
                         self.tr("Cannot send while running "
                                 "(retry after it completes)"))
            return False
        images = [p for p in (images or []) if os.path.isfile(p)]
        vision = self._model_supports_images()
        if images and not vision:
            self._append(
                "error",
                self.tr(
                    "The selected model does not support image input, "
                    "so images cannot be sent (select a model from "
                    "the \"Text (image input)\" group)"))
            return False
        # To make sending feel fast, switch the button to "Abort" and repaint
        # immediately, before the GUI-side preparation (driver creation, settings save,
        # history rendering); normal repaints are deferred until this function returns.
        # Revert to the idle display if preparation fails
        self._abort = False
        self.sig_busy.emit(True)
        self.btn_send.repaint()
        self.lbl_status.repaint()
        try:
            driver = self._get_driver()  # creation is involved, so always fetch on the GUI thread
            if driver is None:
                raise RuntimeError(
                    self.tr("could not prepare the live driver"))
            plugins = []
            try:
                import qgis.utils
                plugins = sorted(qgis.utils.plugins.keys())
            except Exception:  # nosec B110  # acceptable by design
                pass
            self._plugins = plugins
            pid = self._provider()
            cfg = {
                "provider": pid,
                "base": (self.ed_endpoint.text().strip()
                         or ai_client.PROVIDERS[pid]["base"]),
                "key": self.ed_key.text().strip(),
                "model": (self._current_model()
                          or ai_client.PROVIDERS[pid]["model"]),
                # Estimate the model's image support. Used to return screenshots as images
                "vision": vision,
                "agent": self.cmb_agent.currentData(),
                "confirm": self.chk_confirm.isChecked(),
            }
            self._save_settings()
            self._append("user", text or self.tr("(image only)"))
            for p in images:
                self._append_image(p)
        except Exception as e:
            self.sig_busy.emit(False)
            self._append("error", str(e))
            return False
        threading.Thread(
            target=self._agent_run,
            args=(driver, cfg, plugins, text, images),
            daemon=True, name="qgis-ai-agent").start()
        return True

    # Local chat commands (never sent to the API).
    # After '/<cmd> <name>' the rest of the line, or the following lines, form the body.
    _CHAT_CMDS = {"/agent": "agents", "/agents": "agents",
                  "/skill": "skills", "/skills": "skills",
                  "/prompt": "prompts", "/prompts": "prompts"}

    _CMD_USAGE = QT_TRANSLATE_NOOP(
        "dsh_qgis_driver",
        "Instruction commands (run locally, not sent to the API):\n"
        "  /agent               Show the current agent and list\n"
        "  /agent <name>        Switch agent\n"
        "  /agent <name> <body> Save an agent and select it\n"
        "  /skill               List skills\n"
        "  /skill <name>        Show a skill's body\n"
        "  /skill <name> <body> Save a skill\n"
        "  /prompt              List suggested prompts\n"
        "  /prompt <name>       Insert a prompt into the input\n"
        "  /prompt <name> <body> Save a suggested prompt\n"
        "(The body can span multiple lines starting from line 2)")

    def _chat_command(self, text):
        """Handle '/agent', '/skill' and '/prompt' as local commands.

        Save, switch and show instructions (agents|skills|prompts .md) directly,
        without the API. Returns True when handled (nothing is sent to the API). A
        '/' input with an unknown command name returns False (sent as a normal message).
        """
        first, _, rest = text.partition("\n")
        toks = first.split(None, 2)
        if toks[0].lower() in ("/help", "/?"):
            self._append("user", text)
            self._append("cmd", QCoreApplication.translate(
                "dsh_qgis_driver", self._CMD_USAGE))
            return True
        kind = self._CHAT_CMDS.get(toks[0].lower())
        if kind is None:
            return False
        name = toks[1] if len(toks) > 1 else ""
        body = ((toks[2] + "\n" if len(toks) > 2 else "") + rest).strip()
        self._append("user", text)
        try:
            if not name:
                msg = ai_client.run_instruction_tool(
                    "ai_list_instructions", {"kind": kind})
                if kind == "agents":
                    cur = self.cmb_agent.currentData()
                    msg = (self.tr("Selected: {0}").format(
                        cur or self.tr("(none)")) + "\n" + msg)
                self._append("cmd", msg)
                return True
            if not body:
                if kind == "agents":
                    self._cmd_select_agent(name)
                elif kind == "prompts":
                    self._cmd_insert_prompt(name)
                else:
                    self._cmd_show_instruction(kind, name)
                return True
            self._cmd_save_instruction(kind, name, body)
        except ai_client.ApiError as e:
            self._append("error", str(e))
        return True

    def _cmd_select_agent(self, name):
        """'/agent <name>' - switch to an existing agent."""
        stem = re.sub(r'[\\/:*?"<>|\s]+', "_", name)
        if ai_client.load_instruction("agents", stem) is None:
            raise ai_client.ApiError(
                self.tr("agent '{0}' not found "
                        "(provide a body to save it as new)")
                .format(stem))
        self._on_agent_changed(stem)
        self._append("cmd", self.tr("Switched agent to '{0}'")
                     .format(stem))

    def _cmd_insert_prompt(self, name):
        """'/prompt <name>' - insert a suggested prompt into the input field."""
        stem = re.sub(r'[\\/:*?"<>|\s]+', "_", name)
        body = ai_client.prompt_body(stem)
        if body is None:
            raise ai_client.ApiError(
                self.tr("prompt '{0}' not found "
                        "(provide a body to save it as new)")
                .format(stem))
        self.input.setPlainText(body)
        self.input.setFocus()
        self._append("cmd", self.tr("Inserted prompt '{0}'")
                     .format(stem))

    def _cmd_show_instruction(self, kind, name):
        """'/skill <name>' - show the body of an instruction."""
        stem = re.sub(r'[\\/:*?"<>|\s]+', "_", name)
        text = ai_client.load_instruction(kind, stem)
        if text is None:
            raise ai_client.ApiError(
                self.tr("skill '{0}' not found "
                        "(provide a body to save it as new)")
                .format(stem))
        self._append("cmd", text)

    def _cmd_save_instruction(self, kind, name, body):
        """'/agent|skill <name> <body>' - save an instruction."""
        p = ai_client.save_instruction(kind, name, body)
        stem = os.path.splitext(os.path.basename(p))[0]
        self._refresh_instructions()
        label = {"agents": self.tr("agent"),
                 "prompts": self.tr("prompt")}.get(
                     kind, self.tr("skill"))
        if kind == "agents":
            self._on_agent_changed(stem)
            self._append(
                "cmd", self.tr("{0} '{1}' saved and selected\n{2}")
                .format(label, stem, p))
        else:
            self._append("cmd", self.tr("{0} '{1}' saved\n{2}")
                         .format(label, stem, p))

    def _build_system(self, plugins, agent_id):
        """System prompt including the selected agent plus the skill/agent list."""
        return ai_client.system_prompt(
            plugins,
            agent_text=ai_client.load_agent(agent_id),
            skills=ai_client.list_skills(),
            agents=ai_client.list_agents(),
            active_agent=agent_id)

    def _agent_run(self, driver, cfg, plugins, user_text, user_images):
        """Worker thread: API call plus tool execution loop."""
        try:
            prov = ai_client.get_provider(cfg["provider"])
        except ai_client.ApiError as e:
            self._emit(self.sig_append, "error", str(e))
            self._emit(self.sig_status, "")
            self._emit(self.sig_busy, False)
            return
        self._active_prov = prov
        # ACP: stream turn progress to the status line
        prov.on_event = lambda kind, u: self._emit(
            self.sig_status,
            "{0}: {1}".format(
                ai_client.tr_label(prov.label),
                u.get("title") or kind or "…"))
        system = self._build_system(plugins, cfg.get("agent"))
        msgs = prov.build_messages(
            system, ai_client.trim_history(self._history),
            user_text, user_images)
        final_text = ""
        try:
            for _ in range(ai_client.MAX_TOOL_ROUNDS):
                if self._abort:
                    final_text = self.tr("(aborted)")
                    self._emit(self.sig_append, "error", final_text)
                    break
                self._emit(self.sig_status,
                           self.tr("Waiting for API response…"))
                data = prov.send(cfg["base"], cfg["key"], cfg["model"],
                                 system, msgs)
                turn = prov.parse(data)
                u = turn.get("usage")
                if u:
                    self._usage["in"] += u.get("in", 0)
                    self._usage["out"] += u.get("out", 0)
                    self._usage["last"] = u.get("in", 0)
                if turn["text"]:
                    self._emit(self.sig_append, "assistant", turn["text"])
                if not turn["calls"]:
                    final_text = turn["text"]
                    break
                results = []
                for c in turn["calls"]:
                    if self._abort:
                        results.append({"text": "ABORTED by user",
                                        "image": None})
                    else:
                        results.append(
                            self._run_tool(driver, cfg,
                                           c["name"], c["args"]))
                prov.append_exchange(msgs, turn, results)
                # ai_select_agent: apply the agent switch and
                # rebuild the system prompt (the last specification wins)
                sel = [r["agent_select"] for r in results
                       if "agent_select" in r]
                if sel:
                    aid = sel[-1]
                    cfg["agent"] = aid
                    system = self._build_system(plugins, aid or None)
                    if msgs and msgs[0].get("role") == "system":
                        msgs[0]["content"] = system  # OpenAI format.
                        # Gemini/Anthropic take system separately at send time,
                        # so track it through the variable
                    self._emit(self.sig_agent_changed, aid or "")
            else:
                final_text = self.tr(
                    "(tool round-trip limit reached)")
                self._emit(self.sig_append, "error", final_text)
            # Keep only text pairs in the conversation (tool details are collapsed).
            # Attachments stay in the user entry as PNG paths;
            # build_messages re-converts them into wire format on later turns
            entry = {"role": "user", "content": user_text}
            if user_images:
                entry["images"] = list(user_images)
            self._history.append(entry)
            if final_text:
                self._history.append(
                    {"role": "assistant", "content": final_text})
        except ai_client.ApiError as e:
            self._emit(self.sig_append, "error", str(e))
        except Exception:
            import traceback
            self._emit(self.sig_append, "error", traceback.format_exc())
        finally:
            self._emit(self.sig_status, "")
            self._emit(self.sig_busy, False)

    def _run_tool(self, driver, cfg, name, args):
        """Dispatch a tool call to the driver and return the normalized result.

        @returns {"text": str, "image": path|None}
        """
        if self._abort:
            return {"text": "ABORTED", "image": None}
        # Confirmation mode: ask the user for approval before each execution
        if cfg.get("confirm") and not self._confirm_tool(name, args):
            self._emit(self.sig_append, "tool",
                       self.tr("{0} → skipped by user").format(name))
            return {"text": "SKIPPED: user denied", "image": None}
        if name in ai_client.INSTRUCTION_TOOL_NAMES:
            return self._run_instruction_tool(name, args)
        try:
            cmd = ai_client.tool_to_command(name, args)
        except ai_client.ApiError as e:
            self._emit(self.sig_append, "error", str(e))
            return {"text": f"ERROR: {e}", "image": None}
        disp = {k: v for k, v in cmd.items() if k != "type"}
        self._emit(self.sig_append, "tool",
                   f"{name} {json.dumps(disp, ensure_ascii=False)}")
        if cmd["type"] == "screenshot" and not cmd.get("path"):
            cmd["path"] = ai_client.screenshot_temp_path()
        self._emit(self.sig_status,
                   self.tr("{0} running…").format(name))
        rep = driver.submit(cmd, origin="ai_panel")
        text = ai_client.reply_to_text(rep)
        self._emit(self.sig_append, "tool",
                   f"→ {text[:2000]}"
                   + ("…" if len(text) > 2000 else ""))
        # Return screenshots as images only for image-capable models
        # (sending images to other models causes API errors)
        image = None
        if (cmd["type"] == "screenshot" and "error" not in rep
                and cfg["vision"]):
            image = rep.get("result")
        return {"text": text, "image": image}

    def _run_instruction_tool(self, name, args):
        """ai_* tools: panel-local operations on instruction files.

        File I/O only, no GUI work, so these can run on a worker thread.
        Combo updates are bounced back to the GUI thread through signals.
        """
        self._emit(self.sig_append, "tool",
                   f"{name} {json.dumps(args or {}, ensure_ascii=False)}")
        self._emit(self.sig_status,
                   self.tr("{0} running…").format(name))
        r = {"text": "", "image": None}
        if name == "ai_select_agent":
            # The selection is panel UI state; the agent loop picks up the
            # agent_select key of the result dict and rebuilds the system prompt
            aid = ((args or {}).get("id") or "").strip()
            if aid and not any(a["id"] == aid
                               for a in ai_client.list_agents()):
                r["text"] = f"ERROR: agents '{aid}' not found"
            else:
                r["text"] = (f"active agent set: {aid}" if aid
                             else "active agent cleared")
                r["agent_select"] = aid
        else:
            try:
                r["text"] = ai_client.run_instruction_tool(name, args)
            except ai_client.ApiError as e:
                r["text"] = f"ERROR: {e}"
            except Exception as e:
                r["text"] = f"ERROR: {type(e).__name__}: {e}"
            self._emit(self.sig_instructions)
        text = r["text"]
        self._emit(self.sig_append, "tool",
                   f"→ {text[:2000]}"
                   + ("…" if len(text) > 2000 else ""))
        return r

    # ---- Tool execution confirmation (confirmation mode) ----

    def _confirm_tool(self, name, args):
        """Ask Yes/No from a worker thread through the GUI thread and return the result.

        The worker keeps polling while the modal dialog is up, so an abort or
        panel teardown can break it (deadlock prevention).
        """
        self._confirm_event.clear()
        self._emit(self.sig_confirm, name,
                   json.dumps(args or {}, ensure_ascii=False)[:400])
        while not self._confirm_event.wait(0.3):
            if self._abort or not self._alive:
                return False
        return bool(self._confirm_result)

    def _on_confirm(self, name, args_text):
        """Show the confirmation dialog (GUI thread)."""
        ok = QMessageBox.question(
            self, self.tr("Confirm tool execution"),
            self.tr("Run {0}?\n\n{1}").format(name, args_text),
            QMessageBox.StandardButton.Yes
            | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No
        ) == QMessageBox.StandardButton.Yes
        self._confirm_result = ok
        self._confirm_event.set()


class _InstructionsDialog(QDialog):
    """Create/edit/delete instruction files (agents|skills *.md).

    Saves always go to the user's ~/.qgis-live/<kind>/.
    Bundled entries are read-only; saving under the same name makes a user
    file that takes precedence (an effective overwrite).
    """

    _KINDS = [("agents",
               QT_TRANSLATE_NOOP("dsh_qgis_driver", "Agents")),
              ("skills",
               QT_TRANSLATE_NOOP("dsh_qgis_driver", "Skills")),
              ("prompts",
               QT_TRANSLATE_NOOP("dsh_qgis_driver", "Prompts"))]

    def __init__(self, parent, kind="agents", select=None):
        super().__init__(parent)
        self.setWindowTitle(
            self.tr("Edit instructions"))
        self.resize(760, 480)
        lay = QVBoxLayout(self)
        self.cmb_kind = QComboBox(self)
        for kid, label in self._KINDS:
            self.cmb_kind.addItem(
                QCoreApplication.translate("dsh_qgis_driver", label),
                kid)
        lay.addWidget(self.cmb_kind)
        self.cmb = QComboBox(self)
        lay.addWidget(self.cmb)
        self.ed_name = QLineEdit(self)
        self.ed_name.setPlaceholderText(self.tr(
            "Name (file name; saved as <name>.md. e.g. map-design)"))
        lay.addWidget(self.ed_name)
        # Split editing (Markdown input) and preview (rendered) side by side
        split = QSplitter(Qt.Orientation.Horizontal, self)
        ed_box = QGroupBox(self.tr("Edit (Markdown)"), split)
        eb = QVBoxLayout(ed_box)
        eb.setContentsMargins(4, 4, 4, 4)
        self.ed_body = QPlainTextEdit(ed_box)
        eb.addWidget(self.ed_body)
        pv_box = QGroupBox(self.tr("Preview"), split)
        pb = QVBoxLayout(pv_box)
        pb.setContentsMargins(4, 4, 4, 4)
        self.preview = QTextBrowser(pv_box)
        self.preview.setOpenExternalLinks(True)
        pb.addWidget(self.preview)
        split.addWidget(ed_box)
        split.addWidget(pv_box)
        split.setStretchFactor(0, 1)
        split.setStretchFactor(1, 1)
        lay.addWidget(split, 1)
        self.ed_body.textChanged.connect(self._update_preview)
        # Keep the edit/preview scroll positions in sync by ratio
        self._syncing_scroll = False
        self.ed_body.verticalScrollBar().valueChanged.connect(
            lambda _v: self._sync_scroll(self.ed_body, self.preview))
        self.preview.verticalScrollBar().valueChanged.connect(
            lambda _v: self._sync_scroll(self.preview, self.ed_body))
        self.lbl_hint = QLabel("", self)
        self.lbl_hint.setStyleSheet("color:#666; font-size:11px")
        self.lbl_hint.setWordWrap(True)
        lay.addWidget(self.lbl_hint)
        # Ask AI to revise: send the editor body and the instruction to the chat,
        # then mirror the result the AI saved with ai_save_instruction into the editor
        prow = QHBoxLayout()
        self.ed_prompt = _Input(self)
        self.ed_prompt.set_hint(
            self.tr("Edit instructions for the AI (Enter to send)"))
        self.ed_prompt.setMaximumHeight(48)
        self.ed_prompt.setToolTip(
            self.tr("e.g. \"Add a summary section\" \"Make the tone "
                    "more concise\""))
        self.btn_ai = QPushButton(
            self.tr("Ask AI to revise"), self)
        self.btn_ai.setToolTip(
            self.tr(
                "Send the editor body and the instructions above to "
                "the chat AI.\n"
                "When the AI saves, the result is reflected in the "
                "editor (not while there are unsaved manual edits)"))
        prow.addWidget(self.ed_prompt, 1)
        prow.addWidget(self.btn_ai)
        lay.addLayout(prow)
        row = QHBoxLayout()
        self.btn_save = QPushButton(self.tr("Save"), self)
        self.btn_del = QPushButton(self.tr("Delete"), self)
        self.btn_dir = QPushButton(
            self.tr("Open folder"), self)
        btn_close = QPushButton(self.tr("Close"), self)
        row.addWidget(self.btn_save)
        row.addWidget(self.btn_del)
        row.addWidget(self.btn_dir)
        row.addStretch(1)
        row.addWidget(btn_close)
        lay.addLayout(row)
        self.cmb_kind.activated.connect(lambda _i: self.reload())
        self.cmb.activated.connect(self._pick)
        self.btn_save.clicked.connect(self._save)
        self.btn_del.clicked.connect(self._delete)
        self.btn_dir.clicked.connect(self._open_dir)
        btn_close.clicked.connect(self.accept)
        self.ed_prompt.sig_submit.connect(self._ask_ai)
        self.btn_ai.clicked.connect(self._ask_ai)
        self._items = {}
        self._loaded_body = ""   # last loaded/saved body (to detect external changes)
        i = self.cmb_kind.findData(kind)
        self.cmb_kind.setCurrentIndex(i if i >= 0 else 0)
        self.reload(select)

    def _update_preview(self):
        """Render the Markdown being edited into the preview pane."""
        # setMarkdown rewinds the preview to the top, so suppress the
        # reverse sync (preview -> editor) meanwhile and re-align
        # to the editor's scroll position after rendering
        self._syncing_scroll = True
        try:
            self.preview.setMarkdown(self.ed_body.toPlainText())
        finally:
            self._syncing_scroll = False
        self._sync_scroll(self.ed_body, self.preview)

    def _sync_scroll(self, src, dst):
        """Apply src's scroll ratio to dst (for two-way following)."""
        if self._syncing_scroll:
            return
        s = src.verticalScrollBar()
        d = dst.verticalScrollBar()
        ratio = s.value() / s.maximum() if s.maximum() > 0 else 0.0
        self._syncing_scroll = True
        try:
            d.setValue(int(round(d.maximum() * ratio)))
        finally:
            self._syncing_scroll = False

    def _kind(self):
        return self.cmb_kind.currentData() or "agents"

    def _kind_label(self):
        return self.cmb_kind.currentText()

    def reload(self, select=None):
        kind = self._kind()
        self._items = {a["id"]: a for a in
                       ai_client.list_instruction_files(kind)}
        self.lbl_hint.setText(
            {"agents": self.tr(
                "Agents: the selected one is injected into the system "
                "prompt on every request. Format: \"# Title\" → "
                "description → \"use_when: when to use\" (optional)"),
             "prompts": self.tr(
                "Prompts: shown in the panel's suggestion list; the "
                "body after the header is inserted into the chat "
                "input when picked. Format: \"# Title\" → "
                "description → \"use_when: when to use\" (optional) "
                "→ prompt text")}.get(kind) or self.tr(
                "Skills: only the list of id+description+use_when "
                "appears in the prompt; the model reads the body via "
                "qgis_pyeval's open() when needed. Format: \"# Title\" "
                "→ description → \"use_when: when to use\" "
                "(optional)"))
        self._rebuild_combo(select)
        self._pick(self.cmb.currentIndex())

    def _rebuild_combo(self, select=None):
        """Rebuild the combo from self._items and keep select (current if omitted)."""
        cur = self.cmb.currentData() if select is None else select
        self.cmb.blockSignals(True)
        self.cmb.clear()
        self.cmb.addItem(
            self.tr("+ New {0}").format(self._kind_label()), "")
        for a in self._items.values():
            label = a["title"] + (self.tr(" (bundled)")
                                  if a["builtin"] else "")
            self.cmb.addItem(label, a["id"])
        i = self.cmb.findData(cur) if cur else -1
        self.cmb.setCurrentIndex(i if i > 0 else 0)
        self.cmb.blockSignals(False)

    def _pick(self, _idx):
        a = self._items.get(self.cmb.currentData() or "")
        if a is None:
            self.ed_name.setText("")
            self.ed_body.setPlainText("")
            self._loaded_body = ""
            return
        self.ed_name.setText(a["id"])
        try:
            with open(a["path"], "r", encoding="utf-8") as f:
                body = f.read()
        except Exception:
            body = ""
        self.ed_body.setPlainText(body)
        self._loaded_body = body

    def refresh_external(self):
        """Follow changes to instruction files made by ai_* tools and others.

        Rebuild the list and keep the selection; if the selected file's body was
        updated externally, mirror it into the editor. Do not overwrite while
        there are unsaved manual edits. If a file of the same name appears
        during creation, select it.
        """
        kind = self._kind()
        self._items = {a["id"]: a for a in
                       ai_client.list_instruction_files(kind)}
        aid = self.cmb.currentData() or ""
        if not aid:
            stem = re.sub(r'[\\/:*?"<>|\s]+', "_",
                          self.ed_name.text().strip())
            if stem in self._items:
                aid = stem
        self._rebuild_combo(aid or None)
        a = self._items.get(self.cmb.currentData() or "")
        if a is None:
            return
        try:
            with open(a["path"], "r", encoding="utf-8") as f:
                body = f.read()
        except Exception:
            return
        if (body != self._loaded_body
                and self.ed_body.toPlainText() == self._loaded_body):
            self.ed_name.setText(a["id"])
            self.ed_body.setPlainText(body)
            self._loaded_body = body

    def _ask_ai(self):
        """'Ask AI to revise': send the editor body and instruction to the chat AI."""
        prompt = self.ed_prompt.toPlainText().strip()
        if not prompt:
            return
        panel = self.parent()
        if panel is None:
            return
        kind = self._kind()
        name = (self.ed_name.text().strip()
                or self.cmb.currentData() or "")
        body = self.ed_body.toPlainText().strip()
        msg = (f"Please revise the {self._kind_label()} instruction "
               f"'{name or 'new'}'.\n\n"
               f"## Revision instructions\n{prompt}\n\n"
               f"## Current body\n{body or '(empty)'}\n\n")
        if name:
            msg += (f"Save the full revised text with "
                    f"ai_save_instruction "
                    f"(kind='{kind}', name='{name}').")
        else:
            msg += ("Give it a suitable name and save as new with "
                    f"ai_save_instruction (kind='{kind}').")
        if panel._send_prompt(msg):
            self.ed_prompt.clear()

    def _save(self):
        try:
            p = ai_client.save_instruction(
                self._kind(), self.ed_name.text(),
                self.ed_body.toPlainText())
        except Exception as e:
            QMessageBox.warning(self, self.tr("Save failed"), str(e))
            return False
        stem = os.path.splitext(os.path.basename(p))[0]
        self.reload(stem)
        return True

    def _delete(self):
        aid = self.cmb.currentData() or ""
        if not aid:
            return
        a = self._items.get(aid)
        if a and a["builtin"]:
            QMessageBox.information(
                self, self.tr("Cannot delete"),
                self.tr("Instructions bundled with the plugin "
                        "cannot be deleted"))
            return
        if QMessageBox.question(
                self, self.tr("Delete"),
                self.tr("Delete {0} '{1}'?")
                .format(self._kind_label(), aid)
        ) != QMessageBox.StandardButton.Yes:
            return
        ai_client.delete_instruction(self._kind(), aid)
        self.reload()

    def _open_dir(self):
        d = (ai_client.agents_dir() if self._kind() == "agents"
             else ai_client.skills_dir())
        os.makedirs(d, exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(d))


def _tabify_with_sibling(iface, panel):
    """Dock into the same area as an existing dock, using tabs instead of splitting.

    So the AI assistant opens as a tab over existing docks such as the layer
    panel, instead of splitting the area vertically.
    """
    from qgis.PyQt.QtWidgets import QDockWidget
    mw = iface.mainWindow()
    area = mw.dockWidgetArea(panel)
    for d in mw.findChildren(QDockWidget):
        if (d is not panel and d.isVisible()
                and mw.dockWidgetArea(d) == area):
            mw.tabifyDockWidget(d, panel)
            return


def show_panel(iface, get_driver, panel):
    """Show the dock (creating it if needed) and return the instance."""
    if panel is None:
        panel = AiPanel(iface, get_driver)
        iface.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, panel)
        _tabify_with_sibling(iface, panel)
    panel.show()
    panel.raise_()
    return panel
