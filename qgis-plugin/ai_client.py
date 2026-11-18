"""LLM API client for the AI assistant panel (stdlib only).

Called from ai_panel.py (the Qt layer). Independent of QGIS/Qt, so this
module is a pytest target.

Supported providers:
  - "openai": OpenAI Chat Completions compatible
    (POST {base}/chat/completions, tools=function calling).
    Compatible servers such as Ollama, LM Studio, OpenRouter, xAI Grok,
    Mistral, Groq and DeepSeek work too, just by changing the base URL
    (e.g. http://localhost:11434/v1). Bedrock/Vertex etc. connect the same
    way through a compatible proxy such as LiteLLM
  - "anthropic": Anthropic Messages API
    (POST {base}/v1/messages, tools=input_schema.
    Auth: x-api-key + anthropic-version headers)
  - "gemini": Google Gemini API
    (POST {base}/models/{model}:generateContent, functionDeclarations.
    Auth: x-goog-api-key header)
  - "azure": Azure OpenAI Service
    (Chat Completions is OpenAI compatible, but auth is the api-key header
    and the URL is {resource}/openai/deployments/<deployment>/chat/completions
    ?api-version=.... The model field is the deployment name)
  - "copilot": GitHub Copilot
    (OpenAI-compatible {api}/chat/completions. The GitHub token in the API key
    field is exchanged for a short-lived token at
    api.github.com/copilot_internal/v2/token, and endpoints.api from the
    response is used as the API host. Requires a Copilot subscription.
    The "Sign in with GitHub" button gets a token via the OAuth device flow)

Tool definitions are http_api.TOOLS (REST), converted to each
provider's schema. Execution is delegated to LiveDriver.submit(), so this
module never touches QGIS itself.

Provider abstraction: OpenAIProvider/AnthropicProvider/GeminiProvider/
AzureOpenAIProvider/CopilotProvider implement build_messages / send /
parse / append_exchange; ai_panel's agent loop is provider-agnostic.
"""

import base64
import inspect
import json
import os
import re
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from .http_api import TOOLS
from .profile_store import registry_dir

try:
    from qgis.PyQt.QtCore import QCoreApplication, QT_TRANSLATE_NOOP
except ImportError:
    QCoreApplication = None

    def QT_TRANSLATE_NOOP(ctx, src):  # noqa: N802
        return src


def tr_label(src):
    """Runtime translation of UI labels. Stays English where Qt is absent (pytest)."""
    if QCoreApplication is not None:
        return QCoreApplication.translate("dsh_qgis_driver", src)
    return src


_F_PRICE_TOKENS = QT_TRANSLATE_NOOP(
    "dsh_qgis_driver", "Input {0} / Output {1} /1M tokens")
_F_PRICE_IMG = QT_TRANSLATE_NOOP(
    "dsh_qgis_driver", "{0} /image (image generation)")
_F_KIND = QT_TRANSLATE_NOOP("dsh_qgis_driver", "Kind: {0}")
_F_PRICE = QT_TRANSLATE_NOOP("dsh_qgis_driver", "Price: {0} ({1})")
_F_CONTEXT = QT_TRANSLATE_NOOP("dsh_qgis_driver", "Context: {0} tokens")
_LBL_API_VALUE = QT_TRANSLATE_NOOP("dsh_qgis_driver", "API value")
_LBL_REFERENCE = QT_TRANSLATE_NOOP("dsh_qgis_driver", "reference")

# Max number of tool round trips per user message (runaway protection)
MAX_TOOL_ROUNDS = 25

# Cap on the tool result text returned to the model (excess is truncated)
MAX_TOOL_RESULT_CHARS = 6000
# Cap on conversation history passed to the prompt (characters). Excess is
# dropped from the oldest turns (keeps bloated round-trip context from erroring)
MAX_HISTORY_CHARS = 60000

DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-4o-mini"

GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_DEFAULT_MODEL = "gemini-3.8-flash"

# ---- Anthropic (Messages API) ----
ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com"
ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-5"
ANTHROPIC_VERSION = "2023-06-01"
# The Messages API requires max_tokens. Default to a value all current models allow
ANTHROPIC_MAX_TOKENS = 8192

# ---- Azure OpenAI ----
# Default when the api-version query is omitted (2024-10-21 = GA v1 API)
AZURE_API_VERSION = "2024-10-21"
AZURE_DEFAULT_MODEL = "gpt-4o"

# ---- GitHub Copilot ----
# The GitHub Copilot API is not a public spec but the internal endpoint that
# VS Code's Copilot Chat uses. Swapping the GitHub token for a short-lived one
# matches copilot-api and other community clients. A Copilot subscription is required.
COPILOT_DEFAULT_BASE = "https://api.githubcopilot.com"
COPILOT_DEFAULT_MODEL = "gpt-4o"
COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"  # nosec B105  # public URL
# Fallback for environments where v2/token does not respond: returns plan
# info (endpoints.api / access_type_sku). The official route @github/copilot uses
COPILOT_USER_URL = "https://api.github.com/copilot_internal/user"
# Client identification headers api.githubcopilot.com requires. An arbitrary
# Editor-Version may be rejected, so we send what VS Code's Copilot Chat sends
# (the de-facto standard, shared with VS Code extensions and copilot-api).
COPILOT_HEADERS = {
    "Editor-Version": "vscode/1.99.3",
    "Editor-Plugin-Version": "copilot-chat/0.26.7",
    "Copilot-Integration-Id": "vscode-chat",
    "Openai-Intent": "conversation-panel",
    "User-Agent": "GitHubCopilotChat/0.26.7",
}
# client_id for the OAuth device flow. The default is VS Code's public OAuth
# App, so the consent screen shows "Visual Studio Code" (the de-facto way to
# get Copilot authorization; copilot-api etc. use the same value). To use your
# own OAuth App, override it with the environment variable.
GITHUB_CLIENT_ID = os.environ.get("QGIS_LIVE_GITHUB_CLIENT_ID",
                                  "Iv1.b507a08c87ecfe98")
GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code"
GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"  # nosec B105  # public URL

PROVIDERS = {
    "openai": {
        "label": QT_TRANSLATE_NOOP("dsh_qgis_driver", "OpenAI-compatible"),
        "tag": "【API】",
        "base": DEFAULT_BASE_URL,
        "model": DEFAULT_MODEL,
        "key_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "API key (may be empty for local servers)"),
        "endpoint_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "https://api.openai.com/v1  or  http://localhost:11434/v1"),
    },
    "anthropic": {
        "label": "Anthropic (Claude)",
        "tag": "【API】",
        "base": ANTHROPIC_DEFAULT_BASE,
        "model": ANTHROPIC_DEFAULT_MODEL,
        "key_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "Anthropic API key (issued in the Anthropic Console)"),
        "endpoint_hint": "https://api.anthropic.com",
    },
    "gemini": {
        "label": "Gemini",
        "tag": "【API】",
        "base": GEMINI_DEFAULT_BASE_URL,
        "model": GEMINI_DEFAULT_MODEL,
        "key_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "Gemini API key (issued in AI Studio)"),
        "endpoint_hint": "https://generativelanguage.googleapis.com/v1beta",
    },
    "azure": {
        "label": "Azure OpenAI",
        "tag": "【API】",
        "base": ("https://<resource>.openai.azure.com"
                 "/openai/deployments/<deployment>"),
        "model": AZURE_DEFAULT_MODEL,
        "key_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "Azure OpenAI API key (KEY1/KEY2 of the resource)"),
        "endpoint_hint": ("https://<resource>.openai.azure.com"
                          "/openai/deployments/<deployment>"),
    },
    "copilot": {
        "label": "GitHub Copilot",
        "tag": "【API】",
        "base": COPILOT_DEFAULT_BASE,
        "model": COPILOT_DEFAULT_MODEL,
        "key_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "GitHub token (Copilot subscription required; can be "
            "acquired automatically via \"Sign in with GitHub\")"),
        "endpoint_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "https://api.githubcopilot.com  (URL of a compatible "
            "proxy such as copilot-api)"),
    },
    "devin_acp": {
        "label": "Devin",
        "tag": "【ACP】",
        "base": "",
        "model": "default",
        "key_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "not required (uses the IDE's Devin sign-in)"),
        "endpoint_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "working directory for Devin sessions "
            "(default: user home)"),
    },
    "copilot_acp": {
        "label": "GitHub Copilot",
        "tag": "【ACP】",
        "base": "",
        "model": "default",
        "key_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "not required (uses the Copilot CLI / gh sign-in)"),
        "endpoint_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "working directory for Copilot CLI sessions "
            "(default: user home)"),
    },
    "acp": {
        "label": QT_TRANSLATE_NOOP("dsh_qgis_driver", "Custom agent"),
        "tag": "【ACP】",
        "base": "",
        "model": "default",
        "key_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "working directory for the agent session "
            "(default: user home)"),
        "endpoint_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "ACP launch command for an arbitrary agent CLI "
            "(e.g. my-agent acp)"),
    },
    "devin_bridge": {
        "label": "Devin",
        "tag": "【Bridge】",
        "base": DEFAULT_BASE_URL,
        "model": DEFAULT_MODEL,
        "key_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "API key of the backing OpenAI-compatible endpoint "
            "(the chat LLM delegates work to Devin via the "
            "qgis_devin_* tools)"),
        "endpoint_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "OpenAI-compatible endpoint driving the delegation chat "
            "(e.g. https://api.openai.com/v1)"),
    },
    "copilot_bridge": {
        "label": "GitHub Copilot",
        "tag": "【Bridge】",
        "base": DEFAULT_BASE_URL,
        "model": DEFAULT_MODEL,
        "key_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "API key of the backing OpenAI-compatible endpoint "
            "(the chat LLM delegates work to Copilot CLI via the "
            "qgis_copilot_* tools)"),
        "endpoint_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "OpenAI-compatible endpoint driving the delegation chat "
            "(e.g. https://api.openai.com/v1)"),
    },
    "agent": {
        "label": QT_TRANSLATE_NOOP("dsh_qgis_driver", "External agent"),
        "tag": "【Bridge】",
        "base": "",
        "model": "default",
        "key_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "Bearer token for the agent endpoint (optional)"),
        "endpoint_hint": QT_TRANSLATE_NOOP(
            "dsh_qgis_driver",
            "agent endpoint URL accepting POST {message,...} and "
            "replying {reply: ...} "
            "(e.g. http://127.0.0.1:8511/agent)"),
    },
}

# Display order follows the category order [API] -> [ACP] -> [Bridge]
# (same rule as PROVIDER_ORDER in kasugai_canvas)
PROVIDER_ORDER = ["gemini", "copilot", "azure", "anthropic", "openai",
                  "copilot_acp", "devin_acp", "acp",
                  "copilot_bridge", "devin_bridge", "agent"]

# Provider category tag -> connection-method description (for tooltips/help)
PROVIDER_TAGS = {
    "【API】": QT_TRANSLATE_NOOP(
        "dsh_qgis_driver",
        "Direct LLM API — each message is sent to the model and the "
        "panel runs the tool loop itself"),
    "【ACP】": QT_TRANSLATE_NOOP(
        "dsh_qgis_driver",
        "Agent session — a Devin/Copilot CLI session is the chat "
        "engine and runs its own tool loop (the panel is a chat UI; "
        "no API key needed — uses the CLI/IDE sign-in; the endpoint "
        "field is the working directory)"),
    "【Bridge】": QT_TRANSLATE_NOOP(
        "dsh_qgis_driver",
        "Delegation chat — a normal API chat with injected "
        "instructions to hand substantial work to an agent CLI via "
        "the qgis_devin_* / qgis_copilot_* tools (the panel still "
        "drives the tool loop; needs an API endpoint + key)"),
}

# ---- Model list metadata ----

# Model kind -> display label. The combo box is grouped in this order.
MODEL_KINDS = [
    ("chat_vision",
     QT_TRANSLATE_NOOP("dsh_qgis_driver", "Text (image input)")),
    ("chat", QT_TRANSLATE_NOOP("dsh_qgis_driver", "Text")),
    ("image", QT_TRANSLATE_NOOP("dsh_qgis_driver", "Image generation")),
    ("embed", QT_TRANSLATE_NOOP("dsh_qgis_driver", "Embedding")),
    ("other", QT_TRANSLATE_NOOP("dsh_qgis_driver", "Audio/Other")),
]
MODEL_KIND_LABELS = dict(MODEL_KINDS)

# Suggested models preloaded into the combo when a provider's default endpoint
# is used (so models with prices can be chosen without pressing "Fetch").
# Actual availability depends on the API key's plan; "Fetch" replaces them.
SUGGESTED_MODELS = {
    "openai": ["gpt-5-mini", "gpt-5", "gpt-4.1-mini", "gpt-4.1",
               "gpt-4o-mini", "gpt-4o", "o4-mini"],
    "anthropic": ["claude-sonnet-4-5", "claude-opus-4-5",
                  "claude-haiku-4-5", "claude-opus-4-1",
                  "claude-sonnet-4", "claude-3-7-sonnet"],
    "gemini": ["gemini-3.8-flash", "gemini-3.5-flash",
               "gemini-3.1-flash-lite", "gemini-2.5-pro"],
    "azure": ["gpt-4o", "gpt-4.1", "gpt-5", "gpt-5-mini", "o4-mini"],
    "copilot": ["gpt-4o", "gpt-4.1", "gpt-5-mini", "gpt-5", "o4-mini",
                "claude-sonnet-4", "claude-3.7-sonnet", "gemini-2.5-pro"],
}

# Reference prices for popular models (USD / 1M tokens, [input, output]).
# For indicative display when the API returns no price. Based on public
# prices but subject to change, so shown as a "reference value". Looked up by
# longest prefix match against the tail of the model ID (provider name removed).
KNOWN_MODEL_PRICES = {
    "gpt-5-pro": (15.00, 120.00),
    "gpt-5": (1.25, 10.00),
    "gpt-5-mini": (0.25, 2.00),
    "gpt-5-nano": (0.05, 0.40),
    "gpt-4.1": (2.00, 8.00),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1-nano": (0.10, 0.40),
    "gpt-4o": (2.50, 10.00),
    "gpt-4o-mini": (0.15, 0.60),
    "o3": (2.00, 8.00),
    "o4-mini": (1.10, 4.40),
    "claude-opus-4": (15.00, 75.00),
    "claude-sonnet-4": (3.00, 15.00),
    "claude-haiku-4": (1.00, 5.00),
    "claude-3-5-haiku": (0.80, 4.00),
    "claude-3-haiku": (0.25, 1.25),
    "gemini-2.5-pro": (1.25, 10.00),
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-2.5-flash-lite": (0.10, 0.40),
    "gemini-2.0-flash": (0.10, 0.40),
    "gemini-2.0-flash-lite": (0.075, 0.30),
}

# Name hints for kind inference (searched against the lower-cased model ID tail).
# This is only a guess; when the API returns modality etc., that takes priority.
_EMBED_RE = re.compile(r"embed")
_IMAGE_RE = re.compile(
    r"dall-e|gpt-image|imagen|[-_/]image($|[-_.0-9])|flux|"
    r"stable.?diffusion|sdxl|ideogram|recraft|playground-v|cogview|"
    r"kolors|seedream|photon|hunyuan-image|pixart")
_AUDIO_RE = re.compile(
    r"whisper|tts|transcribe|realtime|audio|moderation|speech|voice")
_VISION_RE = re.compile(
    r"vision|gpt-4o|chatgpt|gpt-4\.1|gpt-5|gpt-4-turbo|gpt-4-|"
    r"\bo[134]\b|claude|gemini|gemma-?3|pixtral|llava|moondream|"
    r"cogvlm|internvl|minicpm-v|qvq|glm-4|kimi|[-_.]vl($|[-_.0-9])|"
    r"qwen.*vl|llama-4|llama-3\.2-(11|90)b|mistral-(small|medium|large)|"
    r"grok")


def classify_model(model_id, entry=None):
    """Infer the kind from the model ID (plus API metadata).

    @returns "chat_vision"|"chat"|"image"|"embed"|"other"
    entry is one element of list_model_entries(). If the API (e.g. OpenRouter)
    returns architecture.modality ("text+image->text" etc.) or
    input_modalities/output_modalities, those are used first.
    """
    tail = (model_id or "").split("/")[-1].lower()
    if entry:
        mod = str(entry.get("modality") or "").lower()
        ins = [str(x).lower() for x in entry.get("input_modalities") or []]
        outs = [str(x).lower() for x in entry.get("output_modalities") or []]
        if "->" in mod:
            mi, mo = mod.split("->", 1)
            if "image" in mo:
                return "image"
            if "image" in mi:
                return "chat_vision"
        if any("image" in o for o in outs):
            return "image"
        if any("image" in i for i in ins):
            return "chat_vision"
    if _EMBED_RE.search(tail):
        return "embed"
    if _IMAGE_RE.search(tail):
        return "image"
    if _AUDIO_RE.search(tail):
        return "other"
    if _VISION_RE.search(tail):
        return "chat_vision"
    return "chat"


def _usd(v):
    """Format an amount as $ (0.6 -> $0.60, 0.075 -> $0.075, 10 -> $10)."""
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    if "." in s and len(s.rsplit(".", 1)[1]) < 2:
        s = f"{v:.2f}"
    return f"${s}"


def fmt_tokens(n):
    """Abbreviate a token count (128000 -> "128k", 1048576 -> "1.0M")."""
    try:
        n = int(n)
    except (TypeError, ValueError):
        return None
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.0f}k"
    return str(n)


def _known_price(tail):
    """Longest-prefix match in the known price table by tail ID -> (in_usd, out_usd)|None"""
    best = None
    for key, io in KNOWN_MODEL_PRICES.items():
        if tail == key or tail.startswith(key):
            if best is None or len(key) > len(best[0]):
                best = (key, io)
    return best[1] if best else None


def _entry_price(entry, tail):
    """Price info -> (short form, description, source, (in,out) USD per 1M|None).

    If OpenRouter etc. returns pricing.prompt/completion (USD/token) that is
    used; otherwise it falls back to the known price table (reference values).
    """
    pr = entry.get("pricing")
    if isinstance(pr, dict):
        def _pm(key):
            try:
                return float(pr[key]) * 1_000_000
            except (KeyError, TypeError, ValueError):
                return None
        pin, pout = _pm("prompt"), _pm("completion")
        if pin is not None or pout is not None:
            pin, pout = pin or 0.0, pout or 0.0
            return (f"{_usd(pin)}/{_usd(pout)}",
                    tr_label(_F_PRICE_TOKENS).format(
                        _usd(pin), _usd(pout)),
                    "api", (pin, pout))
        try:
            pimg = float(pr.get("image"))
        except (TypeError, ValueError):
            pimg = None
        if pimg:
            return (f"{_usd(pimg)}/img",
                    tr_label(_F_PRICE_IMG).format(_usd(pimg)),
                    "api", None)
    kp = _known_price(tail)
    if kp:
        return (f"{_usd(kp[0])}/{_usd(kp[1])}",
                tr_label(_F_PRICE_TOKENS).format(
                    _usd(kp[0]), _usd(kp[1])),
                "known", kp)
    return None, None, None, None


def model_info(entry):
    """Normalize one element of list_model_entries() into {id, kind, price,
    price_desc, price_src, price_usd, context}."""
    mid = entry["id"]
    tail = mid.split("/")[-1].lower()
    price, desc, src, usd = _entry_price(entry, tail)
    return {
        "id": mid,
        "kind": classify_model(mid, entry),
        "price": price,
        "price_desc": desc,
        "price_src": src,          # "api" = endpoint response / "known" = reference value
        "price_usd": usd,          # (in_usd, out_usd)/1M tokens|None
        "context": (entry.get("context_length")
                    or entry.get("input_token_limit")),
    }


def usage_cost(info, total):
    """model_info + accumulated usage {"in","out"} -> estimated cost USD|None.

    price_usd is USD per 1M tokens. Calculation also runs for "known"
    (reference) prices.
    """
    pr = info.get("price_usd")
    if not pr:
        return None
    return (total.get("in", 0) * pr[0]
            + total.get("out", 0) * pr[1]) / 1_000_000


def parse_usage(data):
    """Normalize usage from an API response into {"in","out"}|None.

    OpenAI compatible: usage.prompt_tokens/completion_tokens
    Anthropic: usage.input_tokens/output_tokens
    Gemini: usageMetadata.promptTokenCount/candidatesTokenCount
    (thoughtsTokenCount is counted on the output side too)
    """
    u = data.get("usage")
    if isinstance(u, dict):
        pin = u.get("prompt_tokens")
        pout = u.get("completion_tokens")
        if pin is not None or pout is not None:
            return {"in": pin or 0, "out": pout or 0}
        pin = u.get("input_tokens")
        pout = u.get("output_tokens")
        if pin is not None or pout is not None:
            return {"in": pin or 0, "out": pout or 0}
    m = data.get("usageMetadata")
    if isinstance(m, dict):
        pin = m.get("promptTokenCount")
        pout = ((m.get("candidatesTokenCount") or 0)
                + (m.get("thoughtsTokenCount") or 0))
        if pin is not None or pout:
            return {"in": pin or 0, "out": pout}
    return None


def model_label(info):
    """Combo display text. With a price, the 'id   $in/$out' form."""
    return (f"{info['id']}   {info['price']}" if info.get("price")
            else info["id"])


def model_tooltip(info):
    """Tooltip for a combo item (multiple lines)."""
    lines = [info["id"],
             tr_label(_F_KIND).format(tr_label(
                 MODEL_KIND_LABELS.get(info["kind"], info["kind"])))]
    if info.get("price_desc"):
        src = (tr_label(_LBL_API_VALUE) if info["price_src"] == "api"
               else tr_label(_LBL_REFERENCE))
        lines.append(
            tr_label(_F_PRICE).format(info["price_desc"], src))
    if info.get("context"):
        ctx = fmt_tokens(info["context"])
        if ctx:
            lines.append(tr_label(_F_CONTEXT).format(ctx))
    return "\n".join(lines)


SYSTEM_PROMPT = """\
You are an AI assistant running inside QGIS (a desktop GIS application).
You operate QGIS through the provided tools. All tools run on the local
QGIS process via its live driver.

Guidelines:
- Prefer `qgis_pyeval` for QGIS operations. The code runs in the QGIS
  GUI thread with `iface`, `QgsProject`, `QgsApplication` and `driver`
  in scope. Expressions return their value; for statements assign the
  output to a variable named `result`.
- To move the map to a named place (city, address, landmark), prefer
  `qgis_bridge_call` on geo_search `searchAddress` over hardcoding
  coordinates. QgsMapCanvas has no "zoom level" API — use
  zoomScale(denominator), setExtent(), zoomByFactor() or
  zoomToFeatureExtent(), and transform EPSG:4326 lon/lat to the canvas
  CRS before setCenter().
- Use `qgis_status` first if you need to know which plugins are loaded
  or whether a plugin has a WebEngine view.
- Use `qgis_screenshot` to visually check the map canvas or the main
  window after operations that change the map.
- `plugin_id` routes eval/pyeval/screenshot to another plugin's live
  driver (e.g. a WebEngine plugin's `view`). Loaded plugin ids: {plugins}
- `ai_*` tools manage instruction files on this machine:
  `agents` = persistent instructions injected into your system prompt
  (one selected at a time), `skills` = on-demand procedural docs listed
  in the prompt, `prompts` = canned prompt text shown in the panel's
  suggestion list (the body is inserted into the user's input field
  when picked). You may create or update them when the user asks or
  when a reusable procedure emerges. Save always writes a user file;
  bundled files can be shadowed by saving the same id but never deleted.
- When the user asks to save/learn/create instructions, choose the
  right kind by intent and tell them which you chose and why:
  - `agents`: requests about how you should always behave — a role,
    persona, policy, or output style ("be a surveying expert", "always
    answer with a table", "from now on do X"). Only one is active at
    a time, so also offer to select it via ai_select_agent.
  - `skills`: requests to remember a procedure — repeatable steps for
    a specific task ("remember this workflow", "save how to do X").
    Skills coexist and are read on demand, so this is the default for
    task-specific knowledge.
  - `prompts`: requests to register a frequently used instruction as
    a one-click suggestion ("add this to the suggestions"). The file
    body after the header becomes the text inserted into the input.
  If the intent is genuinely ambiguous, ask the user which they want
  before saving.
- Keep each step small and verify the result before moving on.
- Answer in the user's language.
"""


class ApiError(Exception):
    """An API call failure (HTTP/connection/response shape/missing config)."""


def provider_defaults(provider):
    """Provider ID -> {"base","model","label","key_hint","endpoint_hint"}"""
    try:
        return PROVIDERS[provider]
    except KeyError:
        raise ApiError(f"Unknown provider: {provider}")


# ---- Shared HTTP ----

def _require_http_scheme(url):
    """Reject schemes other than http/https (file: etc.)."""
    scheme = urllib.parse.urlparse(url).scheme.lower()
    if scheme not in ("http", "https"):
        raise ApiError("Unsupported URL scheme: {0}".format(scheme or "(none)"))


def _get_json(url, headers, timeout=30.0):
    _require_http_scheme(url)
    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # nosec B310  # http/https only
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:500]
        except Exception:  # nosec B110  # acceptable by design
            pass
        raise ApiError(f"HTTP {e.code}: {detail or e.reason}") from e
    except urllib.error.URLError as e:
        raise ApiError(f"Connection failed: {e.reason}") from e


def _post_json(url, headers, body, timeout=180.0):
    _require_http_scheme(url)
    headers = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # nosec B310  # http/https only
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:500]
        except Exception:  # nosec B110  # acceptable by design
            pass
        raise ApiError(f"HTTP {e.code}: {detail or e.reason}") from e
    except urllib.error.URLError as e:
        raise ApiError(f"Connection failed: {e.reason}") from e


def _post_form(url, fields, timeout=30.0):
    """POST application/x-www-form-urlencoded and return the response JSON."""
    _require_http_scheme(url)
    body = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST", headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # nosec B310  # http/https only
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:500]
        except Exception:  # nosec B110  # acceptable by design
            pass
        raise ApiError(f"HTTP {e.code}: {detail or e.reason}") from e
    except urllib.error.URLError as e:
        raise ApiError(f"Connection failed: {e.reason}") from e


# ---- GitHub Copilot: token exchange / OAuth device flow ----

# GitHub token -> {"token","expires_at","api"} cache
_COPILOT_CACHE = {}
_COPILOT_CACHE_LOCK = threading.Lock()


def _gh_headers(github_token):
    return {"Authorization": f"token {github_token}",
            "Accept": "application/json",
            **COPILOT_HEADERS}


def copilot_session(github_token, base):
    """Resolve a GitHub token into (Copilot API bearer token, API base).

    Only when base is the default (COPILOT_DEFAULT_BASE) is the GitHub token
    exchanged for a short-lived token at copilot_internal/v2/token; endpoints.api
    from the response (individual/business/enterprise) becomes the API host.
    The token is cached in-module until 60s before it expires.
    Where v2/token does not respond (404s have been reported),
    copilot_internal/user resolves just the API host and the GitHub token is
    used as the bearer token directly (same as the @github/copilot CLI).
    Any base other than the default is treated as a copilot-api compatible
    proxy etc., and github_token is used as the bearer token without exchange.
    """
    u = (base or "").strip().rstrip("/") or COPILOT_DEFAULT_BASE
    if not github_token:
        raise ApiError(
            "Enter a GitHub token in the API key field, or acquire one "
            "via \"Sign in with GitHub\"")
    if u != COPILOT_DEFAULT_BASE:
        return github_token, u
    now = time.time()
    with _COPILOT_CACHE_LOCK:
        ent = _COPILOT_CACHE.get(github_token)
        if ent and ent["expires_at"] - now >= 60:
            return ent["token"], ent["api"]
        try:
            data = _get_json(COPILOT_TOKEN_URL, _gh_headers(github_token))
            tok = data.get("token")
            if not tok:
                raise ApiError(f"no token: {str(data)[:200]}")
            ent = {
                "token": tok,
                "expires_at": float(
                    data.get("expires_at")
                    or now + float(data.get("refresh_in") or 1500)),
                "api": ((data.get("endpoints") or {}).get("api")
                        or COPILOT_DEFAULT_BASE),
            }
        except ApiError as e1:
            # Fallback: resolve the plan-specific API host via
            # copilot_internal/user and use the GitHub token as the bearer
            try:
                user = _get_json(COPILOT_USER_URL,
                                 _gh_headers(github_token))
            except ApiError as e2:
                raise ApiError(
                    "Could not obtain a Copilot token"
                    " (the GitHub token may be invalid or lack a Copilot "
                    "subscription): "
                    f"{e1} / {e2}") from e2
            ent = {
                "token": github_token,
                "expires_at": now + 1500,
                "api": ((user.get("endpoints") or {}).get("api")
                        or COPILOT_DEFAULT_BASE),
            }
        _COPILOT_CACHE[github_token] = ent
        return ent["token"], ent["api"]


def github_device_code(scope="read:user"):
    """Start the OAuth device flow.

    @returns {"device_code","user_code","verification_uri",
              "interval","expires_in"} -- have the user enter user_code at
      verification_uri, then poll with device_code
    """
    d = _post_form(GITHUB_DEVICE_CODE_URL,
                   {"client_id": GITHUB_CLIENT_ID, "scope": scope})
    if not d.get("device_code") or not d.get("user_code"):
        raise ApiError(f"Invalid device code response: {str(d)[:300]}")
    return d


def github_poll_access_token(device_code):
    """Poll once for the device flow token.

    @returns the API response dict. {"access_token": ...} means done;
      {"error": "authorization_pending"|"slow_down"|...} means pending/failed
      (GitHub returns HTTP 200 with an error field even when not authorized)
    """
    return _post_form(GITHUB_ACCESS_TOKEN_URL, {
        "client_id": GITHUB_CLIENT_ID,
        "device_code": device_code,
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})


# ---- OpenAI-compatible (Chat Completions) ----

def openai_models_url(base):
    """Normalize a base URL into the GET target for the models list."""
    u = (base or "").strip().rstrip("/")
    if not u:
        raise ApiError("API endpoint is not set")
    if u.endswith("/chat/completions"):
        u = u[: -len("/chat/completions")]
    return u + "/models"


def endpoint_url(base):
    """Normalize a base URL into the POST target for chat/completions.

    "https://api.openai.com/v1" -> ".../v1/chat/completions"
    A URL already ending in /chat/completions is used as-is.
    """
    u = (base or "").strip().rstrip("/")
    if not u:
        raise ApiError("API endpoint is not set")
    if not u.endswith("/chat/completions"):
        u += "/chat/completions"
    return u


def _tool_short(name):
    """Tool name with the qgis_|ai_ prefix stripped. Used for allowed checks."""
    return name.split("_", 1)[1] if "_" in name else name


def openai_tools(allowed=None):
    """Convert http_api.TOOLS + INSTRUCTION_TOOLS into
    the OpenAI function calling schema."""
    out = []
    for t in TOOLS + INSTRUCTION_TOOLS:
        if allowed is not None and _tool_short(t["name"]) not in allowed:
            continue
        out.append({
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["inputSchema"],
            },
        })
    return out


def chat_completions(base, api_key, model, messages, tools=None,
                     timeout=180.0, extra=None, headers=None):
    """POST {base}/chat/completions (non-streaming) and return the response JSON.

    @param headers: extra headers besides Authorization (for Copilot)
    @raises ApiError: HTTP/connection error, or a malformed response
    """
    body = {"model": model, "messages": messages}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    if extra:
        body.update(extra)
    hdrs = dict(headers or {})
    if api_key:
        hdrs["Authorization"] = f"Bearer {api_key}"
    data = _post_json(endpoint_url(base), hdrs, body, timeout)
    if not isinstance(data, dict) or not data.get("choices"):
        raise ApiError(f"Invalid response format: {str(data)[:300]}")
    return data


# ---- OpenAI Responses API (POST {base}/responses) ----
# For models that reject /chat/completions and only support /responses, such
# as Copilot's GPT-6 family (detectable via supported_endpoints on GET /models).
# The wire format differs, but providers keep chat-format msgs internally and
# convert to the Responses format only when sending (every round converts the
# whole msgs list with mixed tool_calls/tool results, so no state is kept).

def responses_tools(tools):
    """OpenAI function calling format -> the Responses API tools format.
    Flattens {"type":"function","function":{...}}."""
    out = []
    for t in tools or []:
        if t.get("type") == "function" \
                and isinstance(t.get("function"), dict):
            d = {"type": "function"}
            d.update(t["function"])
            out.append(d)
        else:
            out.append(t)
    return out


def _responses_content_parts(content, role):
    """chat-format content -> Responses content parts
    (user=input_text/input_image, assistant=output_text)."""
    text_t = "input_text" if role == "user" else "output_text"
    if isinstance(content, str):
        return [{"type": text_t, "text": content}]
    parts = []
    for p in content or []:
        if not isinstance(p, dict):
            continue
        t = p.get("type")
        if t == "text":
            parts.append({"type": text_t, "text": p.get("text") or ""})
        elif t == "image_url":
            parts.append({"type": "input_image",
                          "image_url":
                              (p.get("image_url") or {}).get("url") or ""})
        elif t in ("input_text", "input_image"):
            parts.append(p)
    return parts


def _tool_result_output(content):
    """chat-format tool result content -> function_call_output.output.
    Strings pass through; part lists with images become the input_* form."""
    if isinstance(content, str):
        return content
    parts = []
    for p in content or []:
        if not isinstance(p, dict):
            continue
        t = p.get("type")
        if t == "text":
            parts.append({"type": "input_text", "text": p.get("text") or ""})
        elif t == "image_url":
            parts.append({"type": "input_image",
                          "image_url":
                              (p.get("image_url") or {}).get("url") or ""})
    return parts or json.dumps(content, ensure_ascii=False)


def openai_msgs_to_responses_input(msgs):
    """OpenAI chat-shaped msgs -> (instructions, Responses API input items)."""
    instr = []
    items = []
    for m in msgs or []:
        role = m.get("role")
        if role == "system":
            c = m.get("content")
            instr.append(
                c if isinstance(c, str)
                else "\n".join(p.get("text") or "" for p in c or []
                               if isinstance(p, dict)))
            continue
        if role == "assistant" and m.get("tool_calls"):
            if m.get("content"):
                items.append({"type": "message", "role": "assistant",
                              "content": _responses_content_parts(
                                  m["content"], "assistant")})
            for tc in m["tool_calls"]:
                fn = tc.get("function") or {}
                args = fn.get("arguments")
                items.append({
                    "type": "function_call",
                    "call_id": tc.get("id") or "",
                    "name": fn.get("name") or "",
                    "arguments": (args if isinstance(args, str)
                                  else json.dumps(
                                      args or {}, ensure_ascii=False))})
            continue
        if role == "tool":
            items.append({
                "type": "function_call_output",
                "call_id": m.get("tool_call_id") or "",
                "output": _tool_result_output(m.get("content"))})
            continue
        items.append({"type": "message", "role": role,
                      "content": _responses_content_parts(
                          m.get("content"), role)})
    return "\n".join(x for x in instr if x), items


def responses_create(base, api_key, model, msgs, tools=None,
                     timeout=180.0, extra=None, headers=None):
    """POST {base}/responses (non-streaming) and return the response JSON.

    @param msgs: OpenAI chat-format message list (including system).
      system messages move to the instructions field
    """
    instr, inp = openai_msgs_to_responses_input(msgs)
    body = {"model": model, "input": inp, "store": False}
    if instr:
        body["instructions"] = instr
    if tools:
        body["tools"] = responses_tools(tools)
        body["tool_choice"] = "auto"
    if extra:
        body.update(extra)
    hdrs = dict(headers or {})
    if api_key:
        hdrs["Authorization"] = f"Bearer {api_key}"
    data = _post_json(base.rstrip("/") + "/responses",
                      hdrs, body, timeout)
    if not isinstance(data, dict) \
            or not isinstance(data.get("output"), list):
        raise ApiError(f"Invalid response format: {str(data)[:300]}")
    return data


def parse_responses_output(data):
    """Responses API response -> {"text","calls","raw","usage"} like parse().
    raw is a chat-format assistant message (append_exchange compatible)."""
    text = []
    calls = []
    tool_calls = []
    for item in data.get("output") or []:
        if not isinstance(item, dict):
            continue
        t = item.get("type")
        if t == "message":
            for c in item.get("content") or []:
                if isinstance(c, dict) \
                        and c.get("type") == "output_text":
                    text.append(c.get("text") or "")
        elif t == "function_call":
            args = item.get("arguments")
            cid = item.get("call_id") or item.get("id")
            calls.append({"id": cid,
                          "name": item.get("name") or "",
                          "args": parse_tool_arguments(args)})
            tool_calls.append({
                "id": cid, "type": "function",
                "function": {
                    "name": item.get("name") or "",
                    "arguments": (args if isinstance(args, str)
                                  else json.dumps(
                                      args or {}, ensure_ascii=False))}})
    raw = {"role": "assistant", "content": "".join(text) or None}
    if tool_calls:
        raw["tool_calls"] = tool_calls
    return {"text": "".join(text), "calls": calls, "raw": raw,
            "usage": parse_usage(data)}


# Records model id -> True when the model is /responses only.
# Learned from supported_endpoints on Copilot's GET /models and from the
# model_not_supported error when sending (fallback)
_RESPONSES_ONLY_MODELS = {}


def _responses_only_error(e):
    """Decide whether the error means the model does not accept
    /chat/completions. A false positive just makes /responses fail the
    same way and return its own error, so match broadly."""
    s = str(e).lower()
    # Also catch wording variants such as "The requested model is not supported."
    return ("not accessible via the /chat/completions" in s
            or "model_not_supported" in s
            or "not supported" in s)


# ---- Gemini (generateContent) ----

def gemini_models_url(base):
    """Normalize a base URL into the GET target for the models list."""
    u = (base or "").strip().rstrip("/")
    if not u:
        raise ApiError("API endpoint is not set")
    if ":generateContent" in u:
        u = u.split("/models/")[0]  # strip /models/<m>:generateContent
    return u + "/models"


def _gemini_schema(s):
    """Convert a JSON Schema (lowercase type) into the Schema form used by
    Gemini functionDeclarations (UPPERCASE type, an OpenAPI subset)."""
    if isinstance(s, dict):
        out = {}
        for k, v in s.items():
            out[k] = (v.upper() if (k == "type" and isinstance(v, str))
                      else _gemini_schema(v))
        if out.get("type") == "ARRAY" and "items" not in out:
            out["items"] = {}  # items is required; {} = any type
        return out
    if isinstance(s, list):
        return [_gemini_schema(x) for x in s]
    return s


def gemini_tools(allowed=None):
    """Convert http_api.TOOLS + INSTRUCTION_TOOLS into
    Gemini functionDeclarations."""
    decls = []
    for t in TOOLS + INSTRUCTION_TOOLS:
        if allowed is not None and _tool_short(t["name"]) not in allowed:
            continue
        decls.append({
            "name": t["name"],
            "description": t["description"],
            "parameters": _gemini_schema(t["inputSchema"]),
        })
    return decls


def gemini_url(base, model):
    """POST target URL for generateContent."""
    u = (base or "").strip().rstrip("/")
    if not u:
        raise ApiError("API endpoint is not set")
    if ":generateContent" in u:
        return u
    return f"{u}/models/{model}:generateContent"


def gemini_generate(base, api_key, model, system, contents,
                    tools=None, timeout=180.0, extra=None):
    """POST {base}/models/{model}:generateContent and return the response JSON."""
    body = {"contents": contents}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if tools:
        body["tools"] = [{"functionDeclarations": tools}]
    if extra:
        body.update(extra)
    headers = {"x-goog-api-key": api_key} if api_key else {}
    data = _post_json(gemini_url(base, model), headers, body, timeout)
    if not isinstance(data, dict) or not data.get("candidates"):
        fb = (data or {}).get("promptFeedback") if isinstance(data, dict) else None
        raise ApiError(
            f"Invalid or blocked response: "
            f"{str(fb or data)[:300]}")
    return data


# ---- Anthropic (Messages API) ----

def _anthropic_v1(base):
    """Normalize a base URL into the form ending at /v1."""
    u = (base or "").strip().rstrip("/")
    if not u:
        raise ApiError("API endpoint is not set")
    if u.endswith("/messages"):
        u = u[: -len("/messages")].rstrip("/")
    elif u.endswith("/models"):
        u = u[: -len("/models")].rstrip("/")
    if not u.endswith("/v1"):
        u += "/v1"
    return u


def anthropic_messages_url(base):
    """POST target URL for messages."""
    return _anthropic_v1(base) + "/messages"


def anthropic_models_url(base):
    """GET target URL for the models list."""
    return _anthropic_v1(base) + "/models"


def anthropic_headers(api_key):
    """Auth headers for the Messages API."""
    h = {"anthropic-version": ANTHROPIC_VERSION}
    if api_key:
        h["x-api-key"] = api_key
    return h


def anthropic_tools(allowed=None):
    """Convert http_api.TOOLS + INSTRUCTION_TOOLS into
    Anthropic tools (input_schema)."""
    out = []
    for t in TOOLS + INSTRUCTION_TOOLS:
        if allowed is not None and _tool_short(t["name"]) not in allowed:
            continue
        out.append({
            "name": t["name"],
            "description": t["description"],
            "input_schema": t["inputSchema"],
        })
    return out


def anthropic_image_part(path):
    """PNG file -> Anthropic image block (None if unreadable)."""
    b64 = image_b64(path)
    if b64 is None:
        return None
    return {"type": "image",
            "source": {"type": "base64",
                       "media_type": "image/png",
                       "data": b64}}


def anthropic_content(text, image_paths):
    """Turn text + image paths into Anthropic content.

    With no images it returns the plain string (shorthand form).
    """
    imgs = [p for p in
            (anthropic_image_part(x) for x in image_paths or [])
            if p is not None]
    if not imgs:
        return text or "(empty)"   # the API rejects empty string content
    return ([{"type": "text", "text": text}] if text else []) + imgs


def anthropic_messages(base, api_key, model, system, messages,
                       tools=None, timeout=180.0, extra=None):
    """POST {base}/v1/messages (non-streaming) and return the response JSON."""
    body = {"model": model, "max_tokens": ANTHROPIC_MAX_TOKENS,
            "messages": messages}
    if system:
        body["system"] = system
    if tools:
        body["tools"] = tools
        body["tool_choice"] = {"type": "auto"}
    if extra:
        body.update(extra)
    data = _post_json(anthropic_messages_url(base),
                      anthropic_headers(api_key), body, timeout)
    if not isinstance(data, dict) \
            or not isinstance(data.get("content"), list):
        raise ApiError(f"Invalid response format: {str(data)[:300]}")
    return data


# ---- Azure OpenAI ----

def azure_chat_url(base):
    """Turn an Azure base (deployments path) into a chat/completions POST URL.

    When the api-version query is missing, AZURE_API_VERSION is appended as
    the default. URLs that already contain /chat/completions or api-version
    are left as they are.
    """
    u = (base or "").strip().rstrip("/")
    if not u:
        raise ApiError("API endpoint is not set")
    sp = urllib.parse.urlsplit(u)
    path = sp.path
    if "/chat/completions" not in path:
        path = path.rstrip("/") + "/chat/completions"
    q = urllib.parse.parse_qsl(sp.query, keep_blank_values=True)
    if not any(k.lower() == "api-version" for k, _ in q):
        q.append(("api-version", AZURE_API_VERSION))
    return urllib.parse.urlunsplit(
        (sp.scheme, sp.netloc, path, urllib.parse.urlencode(q), ""))


def azure_resource_url(base, tail):
    """Build {scheme}://{host}/openai/<tail>?api-version=....

    Inherits the path up to /openai in base, plus the api-version
    (for resource-level APIs such as deployments/models).
    """
    u = (base or "").strip()
    if not u:
        raise ApiError("API endpoint is not set")
    sp = urllib.parse.urlsplit(u)
    i = sp.path.find("/openai")
    root = sp.path[: i + len("/openai")] if i >= 0 else "/openai"
    ver = next((v for k, v in urllib.parse.parse_qsl(sp.query)
                if k.lower() == "api-version"), AZURE_API_VERSION)
    return urllib.parse.urlunsplit(
        (sp.scheme, sp.netloc, f"{root}/{tail.lstrip('/')}",
         f"api-version={urllib.parse.quote(ver)}", ""))


# ---- Shared tool helpers ----

def tool_to_command(name, args):
    """Convert a tool call (qgis_<type>) into a driver command dict.

    Strip the qgis_ prefix to get the
    type, then merge the arguments as-is. Arguments that are None are not sent.
    """
    if not (name or "").startswith("qgis_"):
        raise ApiError(f"Unknown tool: {name}")
    cmd = {"type": name[len("qgis_"):]}
    cmd.update({k: v for k, v in (args or {}).items() if v is not None})
    return cmd


def trim_history(history, max_chars=MAX_HISTORY_CHARS):
    """Trim conversation history to max_chars. Older turns are dropped first
    and the newest turn always survives (guards the context cap when prompting)."""
    total = 0
    keep = []
    for m in reversed(history or []):
        n = len(m.get("content") or "")
        if keep and total + n > max_chars:
            break
        keep.append(m)
        total += n
    return list(reversed(keep))


def parse_tool_arguments(raw):
    """Turn the tool_call arguments (a JSON string) into a dict."""
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw or "{}")
    except Exception as e:
        raise ApiError(
            f"tool arguments are not valid JSON: {e}: {str(raw)[:200]}")


def command_from_tool_call(tc):
    """OpenAI tool_call object -> (name, driver cmd)."""
    fn = (tc or {}).get("function") or {}
    name = fn.get("name") or ""
    args = parse_tool_arguments(fn.get("arguments"))
    return name, tool_to_command(name, args)


def reply_to_text(rep):
    """Turn a driver reply dict into tool result text."""
    if "error" in rep:
        return f"ERROR: {rep['error']}"
    text = rep.get("result")
    if not isinstance(text, str):
        text = json.dumps(text, ensure_ascii=False, indent=2)
    if len(text) > MAX_TOOL_RESULT_CHARS:
        text = (text[:MAX_TOOL_RESULT_CHARS]
                + f"\n... (truncated, {len(text)} chars total)")
    return text


def screenshot_temp_path():
    return os.path.join(tempfile.gettempdir(),
                        f"qgis-ai-shot-{uuid.uuid4().hex[:8]}.png")


def attachment_temp_path():
    """Save destination for an image attached to chat input (normalized to PNG)."""
    return os.path.join(tempfile.gettempdir(),
                        f"qgis-ai-attach-{uuid.uuid4().hex[:8]}.png")


def image_b64(path):
    """Base64-encode a PNG file (None if unreadable)."""
    try:
        with open(path, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")
    except Exception:
        return None


def image_url_part(path):
    """PNG file -> OpenAI image_url part (None if unreadable)."""
    b64 = image_b64(path)
    if b64 is None:
        return None
    return {"type": "image_url",
            "image_url": {"url": f"data:image/png;base64,{b64}"}}


def image_inline_part(path):
    """PNG file -> Gemini inlineData part (None if unreadable)."""
    b64 = image_b64(path)
    if b64 is None:
        return None
    return {"inlineData": {"mimeType": "image/png", "data": b64}}


def user_content(text, image_paths):
    """Turn user input (text + image paths) into OpenAI content.

    With no images, or none readable, it returns the plain text string (a
    single text is not wrapped in an array, for compatibility with non-vision models).
    """
    imgs = [p for p in
            (image_url_part(x) for x in image_paths or [])
            if p is not None]
    if not imgs:
        return text or ""
    return ([{"type": "text", "text": text}] if text else []) + imgs


def image_message_content(path, note=None):
    """Turn a PNG file into an OpenAI vision content array (None if unreadable)."""
    part = image_url_part(path)
    if part is None:
        return None
    return [{"type": "text",
             "text": note or f"screenshot saved: {path}"}, part]


def system_prompt(plugins=None, agent_text=None, skills=None,
                  agents=None, active_agent=None):
    """Assemble the system prompt.

    @param agent_text: agent instruction text (body of agents/*.md).
      Injected at all times when one is selected
    @param skills: the list_skills() listing. Only path + description go in;
      the model reads bodies on demand with open() in qgis_pyeval
      (progressive disclosure saves tokens)
    @param agents: the list_agents() listing. Only id + description go in,
      with [active] on active_agent. The model can switch with
      ai_select_agent and read with ai_read_instruction
    """
    plist = ", ".join(sorted(plugins)) if plugins else "(none)"
    p = SYSTEM_PROMPT.format(plugins=plist)
    if agent_text and agent_text.strip():
        p += "\n## Agent instructions\n" + agent_text.strip() + "\n"
    if agents:
        lines = "\n".join(
            f"- {a['id']}: {a['desc'] or a['title']}"
            + (f" — use when: {a['when']}" if a.get("when") else "")
            + (" [active]" if a["id"] == active_agent else "")
            for a in agents)
        p += ("\n## Agents\n"
              "Agent instruction files define persistent behavior. "
              "The [active] agent's body is already injected above. "
              "Each entry's 'use when' (if any) says which tasks it "
              "suits. Switch with ai_select_agent, or read one via "
              "ai_read_instruction and adopt it ad hoc:\n"
              + lines + "\n")
    if skills:
        lines = "\n".join(
            f"- {s['id']} ({s['path']}): {s['desc']}"
            + (f" — use when: {s['when']}" if s.get("when") else "")
            for s in skills)
        p += ("\n## Skills\n"
              "Skill files are available on this machine. Check each "
              "entry's 'use when' (if any); when a task matches, read "
              "the file via qgis_pyeval open() first:\n"
              + lines + "\n")
    return p


# ---- Agents/skills (instruction files) ----
# Layout policy:
#   agents/  = instructions injected at all times (role, policy). Pick one in the UI
#   skills/  = on-demand procedure docs. Only the listing goes in the prompt;
#              the model reads the body with qgis_pyeval when the task matches
# User-defined locations are ~/.qgis-live/<kind>/ (per QGIS_LIVE_REGISTRY).
# <plugin>/<kind>/ holds plugin-bundled read-only defaults, and a user file
# with the same name takes precedence (overrides it).

def _registry_dir():
    return registry_dir()


def agents_dir():
    return os.path.join(_registry_dir(), "agents")


def skills_dir():
    return os.path.join(_registry_dir(), "skills")


def prompts_dir():
    return os.path.join(_registry_dir(), "prompts")


def _bundled_dir(kind):
    """Plugin-bundled default <kind> directory."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), kind)


def _bundled_dirs(kind):
    """All bundled <kind> directories (dsh_qgis_driver + every loaded plugin).

    Lets each plugin bundle its own <plugin>/<kind>/*.md, with dsh_qgis_driver's
    first; on a name clash the earlier directory wins.
    """
    dirs = [_bundled_dir(kind)]
    try:
        import qgis.utils
        for p in qgis.utils.plugins.values():
            try:
                d = os.path.join(
                    os.path.dirname(inspect.getfile(type(p))), kind)
            except (TypeError, AttributeError):
                continue
            if d not in dirs and os.path.isdir(d):
                dirs.append(d)
    except Exception:  # nosec B110  # acceptable outside QGIS
        pass
    return dirs


# "use_when" header label (right after the description, up to the first blank line)
_WHEN_RE = re.compile(
    r"^(?:use_when|when_to_use|when|用途|使いどき)\s*[:：]\s*(.+)$",
    re.IGNORECASE)


def _md_head(path):
    """Read (title, desc, when) from the head of a .md file.

    Expected header format:
        # Title
        Description (one line)
        use_when: when it applies (one line, optional)
    'use_when' also accepts when/when_to_use and the two Japanese labels
    (see _WHEN_RE). A when line is recognized only right after the description,
    up to the first blank line. A frontmatter-like '---' and comment lines
    are skipped.
    """
    title = desc = when = None
    try:
        with open(path, "r", encoding="utf-8") as f:
            for raw in f:
                t = raw.strip()
                if not t:
                    if title and desc:
                        break
                    continue
                if t.startswith("#"):
                    if title is None:
                        title = t.lstrip("#").strip()
                    elif desc:
                        break      # next heading = end of header
                    continue
                if desc is None:
                    if t.startswith("---") or t.startswith("<!--"):
                        continue
                    desc = t
                    continue
                m = _WHEN_RE.match(t)
                if m:
                    when = m.group(1).strip()
                break              # non-label line = end of header
    except Exception:  # nosec B110  # acceptable by design
        pass
    return title, desc, when


def list_instruction_files(kind):
    """Walk the .md files for "agents"|"skills".

    @returns [{id, title, desc, path, builtin}] (id = file stem, sorted).
      Bundled -> user order; a user file of the same name overrides it.
    """
    udir = os.path.join(_registry_dir(), kind)
    out = {}
    dirs = [(d, True) for d in _bundled_dirs(kind)] + [(udir, False)]
    for d, builtin in dirs:
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if not f.lower().endswith(".md"):
                continue
            stem = f[:-3]
            if not builtin or stem not in out:
                p = os.path.join(d, f)
                title, desc, when = _md_head(p)
                out[stem] = {"id": stem, "path": p, "builtin": builtin,
                             "title": title or stem, "desc": desc or "",
                             "when": when or ""}
    return [out[k] for k in sorted(out)]


def list_agents():
    """List the available agent instruction files."""
    return list_instruction_files("agents")


def list_skills():
    """List the available skill instruction files."""
    return list_instruction_files("skills")


def list_prompts():
    """List the suggested prompts (canned text to insert into the chat input)."""
    return list_instruction_files("prompts")


def _md_body(path):
    """Same rules as _md_head: skip the header (#title/description/
    use_when) and return the remaining body text."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return ""
    title = desc = None
    i = 0
    while i < len(lines):
        t = lines[i].strip()
        if not t:
            if title and desc:
                i += 1
                break
            i += 1
            continue
        if t.startswith("#"):
            if title is None:
                title = t.lstrip("#").strip()
                i += 1
                continue
            if desc:
                break       # next heading = header end (that line is body)
            i += 1
            continue
        if desc is None:
            if t.startswith("---") or t.startswith("<!--"):
                i += 1
                continue
            desc = t
            i += 1
            continue
        if _WHEN_RE.match(t):
            i += 1        # consume the use_when line as part of the header
        break               # non-label line = header end (that line is body)
    return "".join(lines[i:]).strip()


def prompt_body(item_id):
    """prompt id -> text to insert into the input field. None if unspecified.

    Strips the header (#title/description/use_when) and returns the rest;
    a file without a body falls back to description then title.
    """
    for a in list_instruction_files("prompts"):
        if a["id"] == item_id:
            body = _md_body(a["path"])
            return body or a.get("desc") or a["title"]
    return None


def _kind_dir(kind):
    return os.path.join(_registry_dir(), kind)


def _kind_list(kind):
    return list_instruction_files(kind)


def load_agent(agent_id):
    """Agent id -> instruction text. None if unspecified or missing."""
    return load_instruction("agents", agent_id)


def load_instruction(kind, item_id):
    """id of kind ("agents"|"skills") -> body text. None if unspecified."""
    if not item_id:
        return None
    for a in _kind_list(kind):
        if a["id"] == item_id:
            try:
                with open(a["path"], "r", encoding="utf-8") as f:
                    return f.read()
            except Exception:
                return None
    return None


def save_agent(name, text):
    """Save as <name>.md under the user's agents/ and return the path."""
    return save_instruction("agents", name, text)


def save_skill(name, text):
    """Save as <name>.md under the user's skills/ and return the path."""
    return save_instruction("skills", name, text)


def save_instruction(kind, name, text):
    """Save as <name>.md under the user's <kind>/ and return the path.

    Characters not allowed in file names and whitespace become '_'.
    """
    safe = re.sub(r'[\\/:*?"<>|\s]+', "_", (name or "").strip())
    if not safe:
        raise ApiError("Name is empty")
    d = _kind_dir(kind)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, safe + ".md")
    with open(p, "w", encoding="utf-8") as f:
        f.write(text or "")
    return p


def delete_agent(agent_id):
    """Delete the user's agent file (bundled files cannot be deleted)."""
    return delete_instruction("agents", agent_id)


def delete_skill(skill_id):
    """Delete the user's skill file (bundled files cannot be deleted)."""
    return delete_instruction("skills", skill_id)


def delete_instruction(kind, item_id):
    """Delete the user's <kind>/<id>.md (bundled files cannot be deleted)."""
    for a in _kind_list(kind):
        if a["id"] == item_id and not a["builtin"]:
            try:
                os.remove(a["path"])
                return True
            except Exception:
                return False
    return False


# ---- AI local tools (self-editing of the instruction files) ----
# The qgis_* tools are driver commands, but the ai_* tools run locally
# in the panel and delegate to this file layer.
# They use the same {name, description, inputSchema} shape as
# http_api.TOOLS so they can be mixed into openai_tools()/gemini_tools().

_KIND_PROP = {"type": "string",
              "enum": ["agents", "skills", "prompts"],
              "description":
                  "agents = persistent instructions (role, policy, output style) injected "
                  "into the system prompt (only one is active at a time; for persona / "
                  "\"always do ...\" requests) / skills = task procedures and recipes (many "
                  "coexist, read on demand; for \"remember this procedure\" requests) / "
                  "prompts = canned prompt text inserted into the chat input (shown in the "
                  "panel's suggestion list; for \"add this instruction to the suggestions\" "
                  "requests; body = the text inserted)"}

INSTRUCTION_TOOLS = [
    {
        "name": "ai_list_instructions",
        "description":
            "List agent/skill instruction files on this machine "
            "(id, title, desc, path, bundled-or-user).",
        "inputSchema": {"type": "object",
                        "properties": {"kind": _KIND_PROP},
                        "required": ["kind"]},
    },
    {
        "name": "ai_read_instruction",
        "description":
            "Read the full body of an agent/skill instruction file by id.",
        "inputSchema": {"type": "object",
                        "properties": {"kind": _KIND_PROP,
                                       "id": {"type": "string",
                                              "description": "File name (stem)"}},
                        "required": ["kind", "id"]},
    },
    {
        "name": "ai_save_instruction",
        "description":
            "Create or overwrite an agent/skill instruction file. Always "
            "writes the user file (~/.qgis-live/<kind>/<name>.md); a "
            "user file with a bundled id shadows the bundled one. "
            "Choose the kind by intent: 'agents' for behavior/persona/"
            "output-style instructions (only one is active at a time), "
            "'skills' for task procedures and recipes (many coexist, "
            "read on demand), 'prompts' for canned prompt text shown "
            "in the panel's suggestion list and inserted into the "
            "chat input when picked (body = the instruction text). "
            "Format: first '# ' line = title, next "
            "non-empty line = description, optionally followed by a "
            "'use_when: <when to use>' line (shown in listings so "
            "the model can pick it when a task matches), then the "
            "instruction body.",
        "inputSchema": {"type": "object",
                        "properties": {"kind": _KIND_PROP,
                                       "name": {"type": "string",
                                                "description": "File name (stem)"},
                                       "text": {"type": "string",
                                                "description": "File body (Markdown)"}},
                        "required": ["kind", "name", "text"]},
    },
    {
        "name": "ai_delete_instruction",
        "description":
            "Delete a user-side agent/skill instruction file. "
            "Bundled files cannot be deleted.",
        "inputSchema": {"type": "object",
                        "properties": {"kind": _KIND_PROP,
                                       "id": {"type": "string",
                                              "description": "File name (stem)"}},
                        "required": ["kind", "id"]},
    },
    {
        "name": "ai_select_agent",
        "description":
            "Switch the active agent instruction injected into your "
            "system prompt. Pass the agent id, or empty to clear. "
            "Panel-only: not meaningful for external clients.",
        "inputSchema": {"type": "object",
                        "properties": {
                            "id": {"type": "string",
                                   "description": "Agent id (empty = clear)"}},
                        "required": ["id"]},
    },
]

INSTRUCTION_TOOL_NAMES = {t["name"] for t in INSTRUCTION_TOOLS}


def run_instruction_tool(name, args):
    """Run an ai_* tool and return the result text (panel-local execution).

    @raises ApiError: unknown tool, invalid arguments, or no target
    """
    if name == "ai_select_agent":
        # selection state is panel UI state, so it is not handled here
        raise ApiError("ai_select_agent is only valid on the AI panel")
    a = args or {}
    kind = a.get("kind") or ""
    if kind not in ("agents", "skills", "prompts"):
        raise ApiError(
            f"kind must be agents|skills|prompts: {kind!r}")
    if name == "ai_list_instructions":
        items = list_instruction_files(kind)
        if not items:
            return "(none)"
        return "\n".join(
            f"- {i['id']}: {i['title']}"
            + (f" — {i['desc']}" if i.get("desc") else "")
            + (f" — use when: {i['when']}" if i.get("when") else "")
            + f" [{'bundled' if i['builtin'] else 'user'}] {i['path']}"
            for i in items)
    if name == "ai_read_instruction":
        body = load_instruction(kind, a.get("id") or "")
        if body is None:
            raise ApiError(f"{kind} '{a.get('id')}' not found")
        return body
    if name == "ai_save_instruction":
        if a.get("text") is None:
            raise ApiError("text is required")
        return f"saved: {save_instruction(kind, a.get('name'), a['text'])}"
    if name == "ai_delete_instruction":
        if delete_instruction(kind, a.get("id") or ""):
            return f"deleted: {kind}/{a.get('id')}"
        raise ApiError(
            f"cannot delete {kind} '{a.get('id')}'"
            "(does not exist or is bundled)")
    raise ApiError(f"Unknown tool: {name}")


# ---- Provider abstraction ----
# Every provider exposes the following interface:
#   build_messages(system, history, user_text, user_images=None)
#       -> message list in wire format
#       history items are {"role","content","images"?} (images = PNG paths),
#       user_images = PNG paths attached to the new user message.
#   send(base, key, model, system, msgs, timeout) -> response JSON
#   parse(data) -> {"text": str, "calls": [{"id","name","args"}], "raw": ...}
#   append_exchange(msgs, turn, results)
#       results: [{"text": str, "image": path|None}] matching the calls
#       appends the raw assistant turn + provider-specific tool results
#   list_models(base, key, timeout) -> [model id, ...]
#   list_model_entries(base, key, timeout) -> [{id, metadata...}]


class OpenAIProvider:
    id = "openai"
    label = PROVIDERS["openai"]["label"]

    def list_model_entries(self, base, key, timeout=30.0):
        """GET {base}/models -> [{id, price/modality etc. if any}, ...]

        OpenRouter and friends return pricing, context_length and
        architecture.modality; pick them up for metadata display.
        """
        headers = {"Authorization": f"Bearer {key}"} if key else {}
        data = _get_json(openai_models_url(base), headers, timeout)
        items = data.get("data") if isinstance(data, dict) else None
        if not isinstance(items, list):
            raise ApiError(f"Invalid response format: {str(data)[:300]}")
        out = []
        for i in items:
            if not isinstance(i, dict) or not i.get("id"):
                continue
            e = {"id": i["id"]}
            arch = i.get("architecture") or {}
            for k in ("modality", "input_modalities", "output_modalities"):
                if arch.get(k):
                    e[k] = arch[k]
            if i.get("pricing"):
                e["pricing"] = i["pricing"]
            if i.get("context_length"):
                e["context_length"] = i["context_length"]
            out.append(e)
        return sorted(out, key=lambda e: e["id"])

    def list_models(self, base, key, timeout=30.0):
        """GET {base}/models -> sorted data[].id."""
        return [e["id"] for e in self.list_model_entries(base, key, timeout)]

    def build_messages(self, system, history, user_text,
                       user_images=None):
        msgs = [{"role": "system", "content": system}]
        for m in history:
            d = dict(m)
            imgs = d.pop("images", None)  # drop keys absent from wire format
            if imgs:
                d["content"] = user_content(
                    m.get("content") or "", imgs)
            msgs.append(d)
        msgs.append({"role": "user",
                     "content": user_content(user_text, user_images)})
        return msgs

    def send(self, base, key, model, system, msgs, timeout=180.0):
        return chat_completions(base, key, model, msgs,
                                tools=openai_tools(), timeout=timeout)

    def parse(self, data):
        msg = (data.get("choices") or [{}])[0].get("message") or {}
        calls = []
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function") or {}
            calls.append({
                "id": tc.get("id"),
                "name": fn.get("name") or "",
                "args": parse_tool_arguments(fn.get("arguments")),
            })
        return {"text": msg.get("content") or "",
                "calls": calls, "raw": msg,
                "usage": parse_usage(data)}

    def append_exchange(self, msgs, turn, results):
        msgs.append(turn["raw"])
        for c, r in zip(turn["calls"], results):
            content = r["text"]
            if r.get("image"):
                img = image_message_content(r["image"], note=r["text"])
                if img is not None:
                    content = img
            msgs.append({"role": "tool",
                         "tool_call_id": c.get("id"),
                         "content": content})


class AnthropicProvider:
    """Anthropic Messages API.

    system is a top-level field, tools use input_schema, and tool
    results come back as tool_result blocks in a user turn.
    """
    id = "anthropic"
    label = PROVIDERS["anthropic"]["label"]

    def list_model_entries(self, base, key, timeout=30.0):
        """GET {base}/v1/models -> [{id}, ...] (paged via has_more)."""
        url = anthropic_models_url(base)
        out = []
        after = None
        for _ in range(20):              # page cap (runaway guard)
            u = url + ("&" if "?" in url else "?") + "limit=1000"
            if after:
                u += "&after_id=" + urllib.parse.quote(after)
            data = _get_json(u, anthropic_headers(key), timeout)
            items = data.get("data") if isinstance(data, dict) else None
            if not isinstance(items, list):
                raise ApiError(
                    f"Invalid response format: {str(data)[:300]}")
            for m in items:
                if isinstance(m, dict) and m.get("id"):
                    out.append({"id": m["id"]})
            if not data.get("has_more") or not data.get("last_id"):
                break
            after = data["last_id"]
        return sorted(out, key=lambda e: e["id"])

    def list_models(self, base, key, timeout=30.0):
        return [e["id"] for e in
                self.list_model_entries(base, key, timeout)]

    def build_messages(self, system, history, user_text,
                       user_images=None):
        msgs = []
        for m in history:
            msgs.append({
                "role": m.get("role"),
                "content": anthropic_content(
                    m.get("content") or "", m.get("images"))})
        msgs.append({"role": "user",
                     "content": anthropic_content(user_text,
                                                  user_images)})
        return msgs

    def send(self, base, key, model, system, msgs, timeout=180.0):
        return anthropic_messages(base, key, model, system, msgs,
                                  tools=anthropic_tools(),
                                  timeout=timeout)

    def parse(self, data):
        blocks = data.get("content") or []
        text = "".join(b.get("text", "") for b in blocks
                       if b.get("type") == "text")
        calls = [{"id": b.get("id"),
                  "name": b.get("name") or "",
                  "args": b.get("input") or {}}
                 for b in blocks if b.get("type") == "tool_use"]
        if not text and not calls:
            raise ApiError(
                f"Response empty or blocked: stop_reason="
                f"{data.get('stop_reason')} {str(data)[:200]}")
        return {"text": text, "calls": calls,
                "raw": {"role": "assistant", "content": blocks},
                "usage": parse_usage(data)}

    def append_exchange(self, msgs, turn, results):
        # right after the assistant turn (content block list), return all
        # tool_result blocks together in a single user turn
        msgs.append(turn["raw"])
        parts = []
        for c, r in zip(turn["calls"], results):
            content = r["text"]
            if r.get("image"):
                img = anthropic_image_part(r["image"])
                if img is not None:
                    content = ([{"type": "text", "text": r["text"]}]
                               if r["text"] else []) + [img]
            parts.append({"type": "tool_result",
                          "tool_use_id": c.get("id"),
                          "content": content})
        msgs.append({"role": "user", "content": parts})


class GeminiProvider:
    id = "gemini"
    label = PROVIDERS["gemini"]["label"]

    def list_model_entries(self, base, key, timeout=30.0):
        """GET {base}/models -> [{id, input/output_token_limit}, ...] for
        models that support generateContent."""
        headers = {"x-goog-api-key": key} if key else {}
        data = _get_json(gemini_models_url(base), headers, timeout)
        items = data.get("models") if isinstance(data, dict) else None
        if not isinstance(items, list):
            raise ApiError(f"Invalid response format: {str(data)[:300]}")
        out = []
        for m in items:
            name = (m.get("name") or "").split("/")[-1]
            methods = m.get("supportedGenerationMethods")
            if not name or (methods and "generateContent" not in methods):
                continue
            e = {"id": name}
            if m.get("inputTokenLimit"):
                e["input_token_limit"] = m["inputTokenLimit"]
            if m.get("outputTokenLimit"):
                e["output_token_limit"] = m["outputTokenLimit"]
            out.append(e)
        return sorted({e["id"]: e for e in out}.values(),
                      key=lambda e: e["id"])

    def list_models(self, base, key, timeout=30.0):
        """GET {base}/models -> the models that support generateContent.

        models[].name comes as "models/<id>", so strip the prefix.
        Models without generateContent in supportedGenerationMethods
        (embeddings etc.) are excluded.
        """
        return [e["id"] for e in self.list_model_entries(base, key, timeout)]

    def _parts(self, text, image_paths=None):
        parts = [{"text": text}] if text else []
        parts += [p for p in
                  (image_inline_part(x) for x in image_paths or [])
                  if p is not None]
        return parts

    def build_messages(self, system, history, user_text,
                       user_images=None):
        contents = []
        for m in history:
            role = "model" if m.get("role") == "assistant" else "user"
            contents.append({"role": role,
                             "parts": self._parts(
                                 m.get("content", ""), m.get("images"))})
        contents.append({"role": "user",
                         "parts": self._parts(user_text, user_images)})
        return contents

    def send(self, base, key, model, system, msgs, timeout=180.0):
        return gemini_generate(base, key, model, system, msgs,
                               tools=gemini_tools(), timeout=timeout)

    def parse(self, data):
        cand = (data.get("candidates") or [{}])[0]
        content = cand.get("content") or {}
        parts = content.get("parts") or []
        text = "".join(p.get("text", "") for p in parts)
        calls = [{"id": None,
                  "name": (p.get("functionCall") or {}).get("name") or "",
                  "args": (p.get("functionCall") or {}).get("args") or {}}
                 for p in parts if "functionCall" in p]
        raw = {"role": "model", "parts": parts}
        if not text and not calls:
            raise ApiError(
                f"Response empty or blocked: finishReason="
                f"{cand.get('finishReason')} {str(data)[:200]}")
        return {"text": text, "calls": calls, "raw": raw,
                "usage": parse_usage(data)}

    def append_exchange(self, msgs, turn, results):
        # append the model content (with its functionCall) as-is, then
        # return all functionResponse parts in a single user turn
        msgs.append(turn["raw"])
        parts = []
        for c, r in zip(turn["calls"], results):
            parts.append({"functionResponse": {
                "name": c["name"],
                "response": {"result": r["text"]},
            }})
            if r.get("image"):
                part = image_inline_part(r["image"])
                if part is not None:
                    parts.append(part)
        msgs.append({"role": "user", "parts": parts})


class CopilotProvider(OpenAIProvider):
    """GitHub Copilot.

    Message format is OpenAI-compatible, so build_messages/parse/
    append_exchange come from OpenAIProvider. Only auth differs: the
    API-key field's GitHub token is swapped for a short-lived one by
    copilot_session(), and endpoints.api depends on the plan type.
    """
    id = "copilot"
    label = PROVIDERS["copilot"]["label"]

    def list_model_entries(self, base, key, timeout=30.0):
        """GET {api}/models -> the list of chat-capable models.

        Copilot API entries carry capabilities.type / policy.state /
        capabilities.limits.max_context_window_tokens /
        supports.vision, used to decide kind and context length.
        Responses without capabilities (compatible proxies) are all kept.
        """
        tok, api_base = copilot_session(key, base)
        data = _get_json(
            api_base.rstrip("/") + "/models",
            {"Authorization": f"Bearer {tok}", **COPILOT_HEADERS},
            timeout)
        items = data.get("data") if isinstance(data, dict) else None
        if not isinstance(items, list):
            raise ApiError(f"Invalid response format: {str(data)[:300]}")
        out = []
        for m in items:
            if not isinstance(m, dict) or not m.get("id"):
                continue
            caps = m.get("capabilities")
            if not isinstance(caps, dict):
                out.append({"id": m["id"]})
                continue
            if caps.get("type") not in (None, "chat"):
                continue
            if (m.get("policy") or {}).get("state") == "disabled":
                continue
            e = {"id": m["id"],
                 "input_modalities":
                     ["text", "image"]
                     if (caps.get("supports") or {}).get("vision")
                     else ["text"]}
            lim = caps.get("limits") or {}
            if lim.get("max_context_window_tokens"):
                e["context_length"] = lim["max_context_window_tokens"]
            # remember /responses-only models (GPT-6 family etc.;
            # a response without supported_endpoints is unknown = chat)
            eps = m.get("supported_endpoints")
            if isinstance(eps, list):
                if "/chat/completions" not in eps \
                        and "/responses" in eps:
                    _RESPONSES_ONLY_MODELS[m["id"]] = True
                elif "/chat/completions" in eps:
                    _RESPONSES_ONLY_MODELS.pop(m["id"], None)
            out.append(e)
        return sorted(out, key=lambda e: e["id"])

    def send(self, base, key, model, system, msgs, timeout=180.0):
        tok, api_base = copilot_session(key, base)
        if not _RESPONSES_ONLY_MODELS.get(model):
            try:
                return chat_completions(
                    api_base, tok, model, msgs,
                    tools=openai_tools(), timeout=timeout,
                    headers=COPILOT_HEADERS)
            except ApiError as e:
                if not _responses_only_error(e):
                    raise
                # it was a /responses-only model; remember and switch
                _RESPONSES_ONLY_MODELS[model] = True
        return responses_create(
            api_base, tok, model, msgs,
            tools=openai_tools(), timeout=timeout,
            headers=COPILOT_HEADERS)

    def parse(self, data):
        if isinstance(data, dict) \
                and isinstance(data.get("output"), list):
            return parse_responses_output(data)
        return super().parse(data)


class AzureOpenAIProvider(OpenAIProvider):
    """Azure OpenAI Service.

    Message format is OpenAI-compatible, so build_messages/parse/
    append_exchange come from OpenAIProvider. URL and auth differ:
    POST {resource}/openai/deployments/<deployment>/chat/completions
    ?api-version=... with an api-key header. The model field is the
    deployment name (optional on the v1 API since api-version=2024-10-21,
    but still sent for compatibility).
    """
    id = "azure"
    label = PROVIDERS["azure"]["label"]

    def list_model_entries(self, base, key, timeout=30.0):
        """GET {resource}/openai/deployments -> the deployment names.

        Where the v1 API's deployment listing is unavailable, fall back to
        /openai/models (the underlying model names).
        """
        headers = {"api-key": key} if key else {}
        try:
            data = _get_json(azure_resource_url(base, "deployments"),
                             headers, timeout)
            items = data.get("data") if isinstance(data, dict) else None
            out = [{"id": m["id"]} for m in items or []
                   if isinstance(m, dict) and m.get("id")]
            if out:
                return sorted(out, key=lambda e: e["id"])
        except ApiError:
            pass                        # fall back to /openai/models
        data = _get_json(azure_resource_url(base, "models"),
                         headers, timeout)
        items = data.get("data") if isinstance(data, dict) else None
        if not isinstance(items, list):
            raise ApiError(f"Invalid response format: {str(data)[:300]}")
        return sorted([{"id": m["id"]} for m in items
                       if isinstance(m, dict) and m.get("id")],
                      key=lambda e: e["id"])

    def send(self, base, key, model, system, msgs, timeout=180.0):
        body = {"model": model, "messages": msgs}
        tools = openai_tools()
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        headers = {"api-key": key} if key else {}
        data = _post_json(azure_chat_url(base), headers, body, timeout)
        if not isinstance(data, dict) or not data.get("choices"):
            raise ApiError(
                f"Invalid response format: {str(data)[:300]}")
        return data


# ---- Devin providers ----
#
# "devin_bridge" ([Bridge]): an ordinary OpenAI-compatible chat plus a
# system instruction telling it to delegate the real work to Devin via
# the qgis_devin_* tools. The tool loop stays on the panel side.
# "devin_acp" ([ACP]): a real provider that uses a Devin CLI `devin acp`
# session as the chat engine. Prompts go to session/prompt and Devin
# runs its own tool loop. No API key; it shares the IDE
# login. History lives in the Devin session, so each turn sends only
# the latest user message.

_DEVIN_BRIDGE_HINT = """\
[DELEGATION MODE] You are a delegation assistant. For any task that
requires writing files, running commands, editing code, or other
substantial work, delegate it to Devin via the qgis_devin_* tools
instead of describing the work yourself:
- qgis_devin_run(prompt, cwd, session_id, engine) starts a task and
  returns task_id (engine "acp" works without `devin auth login`)
- qgis_devin_status / qgis_devin_result monitor it (poll; tasks are
  asynchronous and may take minutes — keep polling until done)
- qgis_devin_abort cancels a running task
Pass the returned session_id to later qgis_devin_run calls to continue
the same Devin session. Report Devin's results to the user."""

_COPILOT_BRIDGE_HINT = _DEVIN_BRIDGE_HINT.replace(
    "Devin", "Copilot CLI").replace("qgis_devin_", "qgis_copilot_")

# devin_acp sessions are kept per cwd at module level and reused on every
# send (provider instances are recreated for each send)
_ACP_SESSIONS = {}


def close_acp_sessions():
    """Close every session opened by devin_acp (on panel teardown)."""
    for s in list(_ACP_SESSIONS.values()):
        try:
            s.close()
        except Exception:  # nosec B110  # acceptable by design
            pass
    _ACP_SESSIONS.clear()


class DevinBridgeProvider(OpenAIProvider):
    """[Bridge] OpenAI-compatible chat plus the Devin delegation prompt."""

    id = "devin_bridge"
    label = PROVIDERS["devin_bridge"]["label"]

    def build_messages(self, system, history, user_text,
                       user_images=None):
        return super().build_messages(
            _DEVIN_BRIDGE_HINT + "\n\n" + (system or ""),
            history, user_text, user_images)


class CopilotBridgeProvider(OpenAIProvider):
    """[Bridge] OpenAI-compatible chat plus the Copilot CLI delegation prompt."""

    id = "copilot_bridge"
    label = PROVIDERS["copilot_bridge"]["label"]

    def build_messages(self, system, history, user_text,
                       user_images=None):
        return super().build_messages(
            _COPILOT_BRIDGE_HINT + "\n\n" + (system or ""),
            history, user_text, user_images)


class DevinAcpProvider:
    """[ACP] Uses a `devin acp` session as the chat engine.

    Endpoint field = working directory of the session (cwd);
    API-key field = unused (the IDE login is shared); model field = the
    Devin-side model ("default" or empty for unspecified).
    """

    id = "devin_acp"
    label = PROVIDERS["devin_acp"]["label"]
    ENGINE = "devin"

    def list_model_entries(self, base, key, timeout=30.0):
        return [{"id": "default"}]

    def list_models(self, base, key, timeout=30.0):
        return ["default"]

    def build_messages(self, system, history, user_text,
                       user_images=None):
        # Devin keeps the history, so this is just a display-only form
        msgs = [{"role": "system", "content": system}]
        for m in history:
            msgs.append({"role": m.get("role"),
                         "content": m.get("content") or "",
                         "images": m.get("images")})
        msgs.append({"role": "user", "content": user_text,
                     "images": list(user_images or [])})
        return msgs

    def _session(self, cwd, model):
        """Get the resident session per engine+cwd (creating it if needed)."""
        from . import devin_tasks  # noqa: PLC0415
        cwd = os.path.abspath(os.path.expanduser(cwd or "~"))
        skey = (self.ENGINE, cwd)
        s = _ACP_SESSIONS.get(skey)
        if s is not None and s._proc.poll() is not None:
            s = None  # recreate it if the process has died
        if s is None:
            s = devin_tasks.AcpSession(
                cwd, mode="bypass",
                model=None if model in (None, "", "default") else model,
                engine=self.ENGINE)
            _ACP_SESSIONS[skey] = s
        return s

    def _make_session(self, base, key, model):
        """Session hook used by send. base = endpoint field,
        key = API-key field (ACP uses it for non-auth purposes).
        By default base is treated as the cwd."""
        return self._session(base, model)

    def send(self, base, key, model, system, msgs, timeout=180.0):
        from . import devin_tasks  # noqa: PLC0415
        sess = self._make_session(base, key, model)
        last = msgs[-1] if msgs else {}
        text = last.get("content") or ""
        # prepend system (instruction files) only to the first prompt
        if not getattr(sess, "_sys_sent", False):
            if system:
                text = system + "\n\n---\n\n" + text
            sess._sys_sent = True
        blocks = []
        if text.strip():
            blocks.append({"type": "text", "text": text})
        for p in last.get("images") or []:
            try:
                with open(p, "rb") as f:
                    import base64
                    blocks.append({
                        "type": "image",
                        "data": base64.b64encode(f.read()).decode("ascii"),
                        "mimeType": "image/png"})
            except OSError:
                pass
        if not blocks:
            raise ApiError("empty prompt")
        chunks = []

        def on_update(u):
            kind = u.get("sessionUpdate")
            if kind == "agent_message_chunk":
                t = ((u.get("content") or {}).get("text") or "")
                if t:
                    chunks.append(t)
            cb = getattr(self, "on_event", None)
            if cb:
                try:
                    cb(kind, u)
                except Exception:  # nosec B110  # acceptable by design
                    pass

        sess.on_update = on_update
        self._sess = sess
        try:
            res = sess.prompt(blocks)
        except devin_tasks.TaskError as e:
            raise ApiError(str(e))
        usage = res.get("usage") or {}
        return {"text": "".join(chunks),
                "stop_reason": res.get("stopReason"),
                "session_id": sess.session_id,
                "usage": {"in": usage.get("inputTokens", 0),
                          "out": usage.get("outputTokens", 0)},
                "raw": res}

    def parse(self, data):
        return {"text": data.get("text") or "", "calls": [],
                "raw": data.get("raw") or data,
                "usage": data.get("usage")}

    def append_exchange(self, msgs, turn, results):
        # calls is always empty so this is rarely used; keep text only
        msgs.append({"role": "assistant",
                     "content": turn.get("text") or ""})

    def abort(self):
        """Panel abort button -> session/cancel."""
        s = getattr(self, "_sess", None)
        if s is not None:
            s.cancel()


class CopilotAcpProvider(DevinAcpProvider):
    """[ACP] Uses a `copilot --acp --stdio` session as the chat engine.

    Same mechanics as DevinAcpProvider; only the engine and auth differ
    (it uses the GitHub Copilot CLI gh login; no windsurf_api_key needed).
    """

    id = "copilot_acp"
    label = PROVIDERS["copilot_acp"]["label"]
    ENGINE = "copilot"


def _custom_acp_argv(command):
    """Split a launch command string into argv.

    Windows .cmd/.bat shims cannot be spawned directly, so go through
    cmd /c (the same workaround as for copilot.cmd and friends).
    """
    import shlex  # noqa: PLC0415
    try:
        argv = shlex.split(command, posix=os.name != "nt")
    except ValueError:
        argv = command.split()
    argv = [a.strip('"').strip("'") for a in argv if a.strip('"').strip("'")]
    if not argv:
        raise ApiError("ACP launch command is empty")
    resolved = shutil.which(argv[0])
    if resolved is None:
        raise ApiError(f"ACP command not found: {argv[0]}")
    argv[0] = resolved
    if os.name == "nt" and resolved.lower().endswith((".cmd", ".bat")):
        argv = [os.environ.get("COMSPEC", "cmd.exe"), "/c", *argv]
    return argv


class CustomAcpProvider(DevinAcpProvider):
    """[ACP] Uses any ACP-capable CLI as the chat engine.

    Endpoint field = launch command (e.g. `my-agent acp`);
    API-key field = working directory of the session (cwd; home if empty).
    Auth is delegated to the CLI's own login (only when authMethods is
    offered, the first method is tried best-effort). Mechanics match
    DevinAcpProvider (equivalent to KASUGAI Canvas's [ACP] custom agent).
    """

    id = "acp"
    label = PROVIDERS["acp"]["label"]
    ENGINE = "custom"

    def _make_session(self, base, key, model):
        from . import devin_tasks  # noqa: PLC0415
        command = (base or "").strip()
        if not command:
            raise ApiError(
                "ACP launch command is not set (endpoint field)")
        argv = _custom_acp_argv(command)
        cwd = os.path.abspath(
            os.path.expanduser((key or "").strip() or "~"))
        skey = (self.ENGINE, command, cwd)
        s = _ACP_SESSIONS.get(skey)
        if s is not None and s._proc.poll() is not None:
            s = None  # recreate it if the process has died
        if s is None:
            s = devin_tasks.AcpSession(
                cwd, exe=argv, mode="bypass",
                model=None if model in (None, "", "default") else model,
                engine="custom")
            _ACP_SESSIONS[skey] = s
        return s


class ExternalAgentProvider(OpenAIProvider):
    """[Bridge] Delegates to any agent HTTP endpoint.

    POST {endpoint} {"message", "system", "history", "model"?}
      -> {"reply": "..."} (any of reply/text/message/content).
    Same shape as the KASUGAI Canvas bridge hub /agent; the hub's provider
    routing does not use the model field, and no fixed "provider" value is
    put in the body -- requests go straight to the provider URL.
    """

    id = "agent"
    label = PROVIDERS["agent"]["label"]

    def list_model_entries(self, base, key, timeout=30.0):
        return [{"id": "default"}]

    def list_models(self, base, key, timeout=30.0):
        return ["default"]

    def send(self, base, key, model, system, msgs, timeout=180.0):
        url = (base or "").strip()
        if not url:
            raise ApiError("agent endpoint is not set")
        last = msgs[-1] if msgs else {}
        content = last.get("content")
        if isinstance(content, str):
            text = content
        else:  # multipart (with images etc.): join the text parts only
            text = " ".join(
                p.get("text", "") for p in (content or [])
                if isinstance(p, dict))
        headers = {}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        body = {
            "message": text,
            "system": system or "",
            "history": [
                {"role": m.get("role"), "content": m.get("content")}
                for m in msgs[-20:]
                if m.get("role") in ("user", "assistant", "model")],
        }
        if model and model != "default":
            body["model"] = model
        return _post_json(url, headers, body, timeout)

    def parse(self, data):
        if isinstance(data, dict):
            reply = data.get("reply")
            if isinstance(reply, dict):
                reply = (reply.get("text") or reply.get("content")
                         or reply.get("message") or "")
            if not reply:
                reply = (data.get("text") or data.get("message")
                         or data.get("content") or "")
            if isinstance(reply, str):
                return {"text": reply, "calls": [], "raw": data,
                        "usage": parse_usage(data)}
        raise ApiError(f"Invalid agent response: {str(data)[:300]}")

    def append_exchange(self, msgs, turn, results):
        # calls is always empty. Appending the response dict as-is would
        # corrupt the next request history, so keep text only
        msgs.append({"role": "assistant",
                     "content": turn.get("text") or ""})


_PROVIDERS = {"openai": OpenAIProvider, "anthropic": AnthropicProvider,
              "gemini": GeminiProvider, "azure": AzureOpenAIProvider,
              "copilot": CopilotProvider,
              "devin_bridge": DevinBridgeProvider,
              "copilot_bridge": CopilotBridgeProvider,
              "devin_acp": DevinAcpProvider,
              "copilot_acp": CopilotAcpProvider,
              "acp": CustomAcpProvider,
              "agent": ExternalAgentProvider}


def get_provider(provider):
    """Provider id -> provider instance."""
    try:
        return _PROVIDERS[provider]()
    except KeyError:
        raise ApiError(f"Unknown provider: {provider}")


def list_models(provider, base, key, timeout=30.0):
    """Return the model ids available at the provider endpoint."""
    return get_provider(provider).list_models(base, key, timeout)


def list_model_infos(provider, base, key, timeout=30.0):
    """Return the model list with metadata.

    @returns [dict from model_info(), ...] (sorted by id)
    """
    entries = get_provider(provider).list_model_entries(base, key, timeout)
    return [model_info(e) for e in entries]
