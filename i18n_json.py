# -*- coding: utf-8 -*-
"""Translation loader based on i18n/<lang>.json (common to all plugins, identical file).

The translation catalog is only <plugin>/i18n/<lang>.json (UTF-8).
Format: {"<context>": {"<English source>": "<translation>"}}
Qt Linguist (lupdate/lrelease) and .ts/.qm are not used.

- Code-side marking stays standard Qt:
  self.tr("...") / QCoreApplication.translate("Ctx", "...") / QT_TRANSLATE_NOOP
- Once install_translator() installs JsonTranslator, those calls consult the
  JSON catalog (strings from .ui files handled by uic/loadUi go the same way).
- For strings that do not go through Qt (generated HTML, etc.) or from tools
  outside QGIS, use translate_text() / catalog() / lookup() directly.
"""

import json
import os

try:
    from qgis.PyQt.QtCore import (
        QCoreApplication, QLocale, QSettings, QTranslator)
except Exception:  # outside QGIS (pytest, etc.)
    try:
        from PyQt6.QtCore import (
            QCoreApplication, QLocale, QSettings, QTranslator)
    except Exception:
        QCoreApplication = QLocale = QSettings = QTranslator = None

# Supported languages (fixed, identical across all plugins). The source
# language is English (en), so it needs no catalog.
LANGS = ("de", "es", "fr", "hi", "it", "ja", "pt", "ru", "zh")

_cache = {}


def lang_code():
    """UI language code from QGIS settings. 'en' for English or unsupported languages."""
    if QSettings is None:
        return "en"
    try:
        raw = QSettings().value("locale/userLocale", "") or ""
        code = str(raw).replace("-", "_").split("_")[0].lower()
        if not code:
            code = QLocale.system().name().split("_")[0].lower()
        return code if code in LANGS else "en"
    except Exception:
        return "en"


def catalog(plugin_dir, lang=None):
    """Read i18n/<lang>.json and return {context: {source: translation}}."""
    lang = lang or lang_code()
    if lang == "en":
        return {}
    key = (os.path.abspath(plugin_dir), lang)
    if key not in _cache:
        path = os.path.join(plugin_dir, "i18n", lang + ".json")
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            _cache[key] = data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            _cache[key] = {}
    return _cache[key]


def lookup(cat, context, source):
    """Return the translation from the catalog, or None when missing.

    When the context does not match, every context is searched (covers the
    same source under another context and absorbs context-name drift).
    """
    hit = None
    if context:
        hit = cat.get(context, {}).get(source)
    if hit is None:
        for messages in cat.values():
            if isinstance(messages, dict) and source in messages:
                hit = messages[source]
                break
    return hit or None


def translate_text(plugin_dir, context, source, lang=None):
    """Consult the catalog directly without Qt (for non-Qt strings such as generated HTML)."""
    if not source:
        return source
    return lookup(catalog(plugin_dir, lang), context, source) or source


def install_translator(plugin_dir):
    """Install and return the JsonTranslator for the current language.

    The caller must keep a reference to the return value (so it is not
    uninstalled by GC). Returns None and does nothing for English, an
    unsupported language, or an environment without Qt.
    """
    if QTranslator is None or QCoreApplication is None:
        return None
    code = lang_code()
    if code == "en":
        return None
    translator = _JsonTranslator(catalog(plugin_dir, code))
    QCoreApplication.installTranslator(translator)
    return translator


if QTranslator is not None:

    class _JsonTranslator(QTranslator):
        """QTranslator that consults a dict catalog.

        Captures every path: QCoreApplication.translate()/self.tr()/.ui loading.
        Unknown sources return None and Qt falls back to the English source.
        """

        def __init__(self, cat):
            super().__init__()
            self._cat = cat

        def translate(self, context, source_text, disambiguation=None, n=-1):
            if not source_text:
                return None
            return lookup(self._cat, context, source_text)

else:
    _JsonTranslator = None
